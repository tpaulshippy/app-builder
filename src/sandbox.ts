/**
 * TypeScript-in-isolate sandbox.
 *
 * Workers bans V8 codegen (`eval`, `new Function`, `WebAssembly.compile`), so the
 * usual "compile then eval" path is closed. We route around it by shipping a
 * JavaScript engine compiled to WebAssembly as a static bundle and calling
 * `WebAssembly.instantiate` with the precompiled module, which the runtime does
 * permit. Inside that VM an `eval` exists that V8 knows nothing about.
 *
 * The compiler here is sucrase rather than tsc-rs. tsc-rs is the interesting
 * choice long-term because it is retargetable (you can point its emitter at your
 * own IR instead of JavaScript); it needs a Rust toolchain and is not vendored
 * here. sucrase is a pure-JS TypeScript-to-JavaScript transform, which runs
 * in-isolate with no native binary.
 */

import { getQuickJSWASMModule } from "@cf-wasm/quickjs/workerd";
import { transform } from "sucrase";
import type { Diagnostic, TypecheckFailure } from "./typecheck";

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_STACK_BYTES = 1024 * 1024;
/**
 * Interrupt-poll budget per run. QuickJS calls the handler periodically while
 * interpreting, so this is a deterministic stand-in for a wall-clock limit that
 * the Workers runtime will not give us. ~4,200 ticks/second measured.
 */
const RUN_TICK_BUDGET = 8000;
/** Microtask drains allowed before we declare the run finished. */
const MAX_PENDING_JOBS = 10000;

export type SandboxError = {
  name: string;
  message: string;
  stack?: string;
  lineNumber?: number;
};

export type RunResult = {
  ok: boolean;
  /** Whatever the program rendered, via the `html` tag or a trailing expression. */
  html: string;
  /** console.log / warn / error lines, in order. */
  logs: string[];
  error?: SandboxError;
  /** Set when the TypeScript itself would not parse. */
  compileError?: { message: string };
  /**
   * Type errors from `tsc`, in tsc's own shape. Present when the program was
   * rejected before it ran, so `html` and `logs` are empty.
   */
  diagnostics?: Diagnostic[];
  /**
   * Set when the type checker itself failed — trapped, panicked, or could not
   * be read. Distinct from an empty `diagnostics`, because that means "checked
   * and clean" while this means "no verdict". Both block the run.
   */
  typecheckError?: TypecheckFailure;
  /** How long the type check took, reported apart from execution. */
  typecheckMs?: number;
  durationMs: number;
};

export type Sandbox = {
  run: (code: string) => Promise<RunResult>;
};

/**
 * Injected once per context. Gives user code a tagged template for output and a
 * `state` object that survives re-runs, which is what makes single-isolate
 * hot-swapping observable.
 */
const BOOTSTRAP = `
globalThis.__out = "";
globalThis.__logs = [];
globalThis.console = {
  log:   (...a) => __logs.push("log   " + a.map(fmt).join(" ")),
  warn:  (...a) => __logs.push("warn  " + a.map(fmt).join(" ")),
  error: (...a) => __logs.push("error " + a.map(fmt).join(" ")),
};
function fmt(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
globalThis.html = (strings, ...values) =>
  (globalThis.__out += strings.reduce(
    (acc, s, i) => acc + s + (i < values.length ? fmt(values[i]) : ""), ""));
globalThis.state = globalThis.state || {};
`;

/** Strip TypeScript types. Sucrase parses; it does not type-check. */
function compile(code: string): { js: string } | { compileError: { message: string } } {
  try {
    const { code: js } = transform(code, {
      transforms: ["typescript"],
      jsxRuntime: "preserve",
      preserveDynamicImport: true,
    });
    return { js };
  } catch (e: any) {
    const loc = e?.loc ? ` (line ${e.loc.line})` : "";
    return { compileError: { message: `${e?.message ?? e}${loc}` } };
  }
}

function toError(dumped: unknown): SandboxError {
  if (dumped && typeof dumped === "object") {
    const d = dumped as Record<string, unknown>;
    return {
      name: typeof d.name === "string" ? d.name : "Error",
      message: typeof d.message === "string" ? d.message : String(dumped),
      stack: typeof d.stack === "string" ? d.stack : undefined,
      lineNumber: typeof d.lineNumber === "number" ? d.lineNumber : undefined,
    };
  }
  return { name: "Error", message: String(dumped) };
}

/**
 * One QuickJS runtime plus one context. Both outlive a single request, so a
 * program can be swapped out and the next run still sees the previous run's
 * globals. That is the whole point: no new isolate, no eval in V8.
 */
export function createSandbox(): Sandbox {
  let ready: Promise<any> | null = null;
  let rt: any = null;
  let ctx: any = null;
  let ticks = 0;

  const init = () => {
    ready ??= getQuickJSWASMModule().then((QuickJS: any) => {
      rt = QuickJS.newRuntime();
      rt.setMemoryLimit(MEMORY_LIMIT_BYTES);
      rt.setMaxStackSize(MAX_STACK_BYTES);
      ctx = rt.newContext();
      ctx.evalCode(BOOTSTRAP);
    });
    return ready;
  };

  /**
   * Read a global out of the VM. Returns `undefined` rather than throwing so a
   * half-initialised context cannot take down a request.
   */
  const readGlobal = (name: string): unknown => {
    try {
      const h = ctx.evalCode(`globalThis.${name}`);
      return h?.error ? undefined : ctx.dump(h.unwrap());
    } catch {
      return undefined;
    }
  };

  const readGlobals = () => {
    const rawErr = readGlobal("__err");
    let err: SandboxError | undefined;
    if (rawErr && typeof rawErr === "object") {
      const d = rawErr as Record<string, unknown>;
      err = {
        name: typeof d.name === "string" ? d.name : "Error",
        message: typeof d.message === "string" ? d.message : String(d),
        stack: typeof d.stack === "string" && d.stack ? d.stack : undefined,
      };
    }
    return {
      err,
      done: readGlobal("__done") === true,
      out: readGlobal("__out"),
      result: readGlobal("__result"),
    };
  };

  const run = async (code: string): Promise<RunResult> => {
    const startedAt = Date.now();
    await init();

    const compiled = compile(code);
    if ("compileError" in compiled) {
      return {
        ok: false,
        html: "",
        logs: [],
        compileError: compiled.compileError,
        durationMs: Date.now() - startedAt,
      };
    }

    // Resource guards are installed on the runtime, not passed per eval.
    //
    // The per-call `shouldInterrupt` option is silently ignored by this binding,
    // and a wall-clock guard cannot work anyway: the handler is host-side
    // JavaScript, where workerd freezes Date.now() so code cannot measure its
    // own runtime. Counting interrupt polls sidesteps both problems. Measured
    // throughput is roughly 4,200 ticks/second, so this budget lands near two
    // seconds of worst-case wall time.
    ticks = 0;
    rt.setInterruptHandler(() => ++ticks > RUN_TICK_BUDGET);

    // Each run is wrapped in its own async IIFE, which buys three things:
    // top-level `const` no longer collides with the previous run's, the last
    // expression statement becomes a value we can collect, and `await` works.
    // Only `state`, which the program sets explicitly, outlives the call.
    //
    // Results travel back through plain globals rather than a settled promise.
    // ctx.dump() on a handle from getPromiseState() returns undefined, but it
    // reads globals correctly, so the handshake is done with globals.
    // `html` is the output channel: it appends to __out, which is reset per run.
    const wrapped = `
globalThis.__out = "";
globalThis.__result = undefined;
globalThis.__err = undefined;
globalThis.__done = false;
(async function () {
  try {
    globalThis.__result = await (async function () {
${compiled.js}
    })();
  } catch (e) {
    globalThis.__err = {
      name: (e && e.name) ? String(e.name) : "Error",
      message: (e && e.message) ? String(e.message) : String(e),
      stack: (e && e.stack) ? String(e.stack) : "",
    };
  }
  globalThis.__done = true;
})();`;

    let error: SandboxError | undefined;

    try {
      const result = ctx.evalCode(wrapped, "app.ts");
      if (result?.error) {
        error = toError(ctx.dump(result.error));
      } else {
        // The VM is synchronous, so the microtask queue is pumped by hand. Code
        // awaiting already-settled values finishes here; anything waiting on
        // real I/O never sets __done and is reported as unsupported. The bound
        // is a job count, not a clock, for the same reason as the tick budget.
        let guard = 0;
        while (rt.hasPendingJob() && guard < 200) {
          rt.executePendingJobs(MAX_PENDING_JOBS);
          guard++;
        }

        const globals = readGlobals();
        if (globals.err) {
          error = globals.err;
        } else if (!globals.done) {
          error = {
            name: "Unsupported",
            message:
              "This run ended on a pending promise. The bundled QuickJS build is synchronous, " +
              "so `await` only works for values that settle immediately. Awaiting real I/O " +
              "or a timer is not supported.",
          };
        }
      }
    } catch (e: any) {
      error = { name: "HostError", message: e?.message ?? String(e) };
    }

    // A budget overrun surfaces as a generic QuickJS "interrupted" error. Say so
    // plainly, since that message is otherwise unactionable.
    const budgetSpent = ticks > RUN_TICK_BUDGET;
    if (budgetSpent || (error && error.message === "interrupted")) {
      error = {
        name: "Timeout",
        message:
          `Stopped after exceeding the ${RUN_TICK_BUDGET.toLocaleString()} interrupt budget ` +
          `(about two seconds of interpreted work). Reduce the work, or split it across runs.`,
      };
    }

    const globals = readGlobals();

    let logs: string[] = [];
    try {
      const h = ctx.evalCode("globalThis.__logs");
      logs = h?.error ? [] : ctx.dump(h.unwrap());
      if (!Array.isArray(logs)) logs = [];
      ctx.evalCode("globalThis.__logs = []");
    } catch {
      logs = [];
    }

    // `html` is the output channel. A bare trailing expression is not a
    // reliable fallback: function bodies evaluate to undefined in strict mode,
    // which is what the sandbox runs, so completion values do not survive.
    const raw = globals.out;
    const html = typeof raw === "string" ? raw : raw == null ? "" : String(raw);

    return { ok: !error, html, logs, error, durationMs: Date.now() - startedAt };
  };

  return { run };
}