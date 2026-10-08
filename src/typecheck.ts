/**
 * Real type checking, in the Worker, with no Rust toolchain at runtime.
 *
 * `sandbox.ts` compiles TypeScript with sucrase, which strips types without
 * checking them. That is why `interface User { age: number }` accepts
 * `age: "forty"`, and why the failure surfaces three layers down as
 * `undefined`. This module closes that gap by running `tsc` itself, as a
 * `wasm32-wasip1` module, over the program's source in an in-memory
 * filesystem.
 *
 * The compiler is `pingdotgg/ts-rust`, a Rust port of the TypeScript 7
 * compiler. The QuickJS execution path is untouched: `tsc` emits JavaScript, so
 * this gates it rather than replacing it.
 *
 * ```
 *              ┌─ src/index.ts ─────────────┐
 * source ──▶   │ sucrase        → JS text    │
 *              │ QuickJS        → execute   │
 *              └─────────────────────────────┘
 * source ──▶   ts_rust.wasm ──▶ diagnostics ──▶ reject if any
 *              (type check only, --noEmit)
 * ```
 *
 * ## Cost, per run
 *
 * `crates/ts_wasm` keeps one program per process (`core::set_prog`), so a
 * module instance can serve exactly one request. Every type check therefore
 * pays a fresh instantiation of a 4.2 MB module whose first 32 MiB of linear
 * memory is the shadow stack (`crates/ts_wasm/build.rs` sets
 * `-zstack-size=33554432`). That is fine for a build loop where a run takes
 * seconds, and it is why this is not on a keystroke path.
 *
 * The vendored binary is built from a pinned upstream commit; see
 * `docs/ts-rust-integration.md` for the rebuild command and the SHA-256.
 */

import mod from "./ts_rust.wasm";
import { instantiate, MemoryFs, WasiExit } from "./wasi-shim";
import { projectFiles, APP_DIR, APP_ENTRY } from "./host-api";

/** `FLAG_DIAGNOSTICS_JSON`: report diagnostics in the reply instead of on stdout. */
const FLAG_DIAGNOSTICS_JSON = 1;

/** `categories::Category` from ts-rust, which writes as a number. */
const CATEGORY_ERROR = 1;
const CATEGORY_WARNING = 0;
const CATEGORY_SUGGESTION = 2;
const CATEGORY_MESSAGE = 3;

const dec = new TextDecoder();

/** A source line the diagnostic points at, with the lines around it. */
export type SourceLine = {
  /** One-based, as displayed. */
  line: number;
  text: string;
};

/**
 * One diagnostic, normalised to one-based positions and a bare file name.
 *
 * The wire format is ts-rust's `DiagnosticResponse`, whose positions are
 * zero-based (`startPosition`) and whose `fileName` is the absolute path inside
 * the in-memory filesystem. Both are unhelpful in a UI, so both are fixed here
 * rather than at each render site.
 */
export type Diagnostic = {
  /** TS2322 and so on. Zero when the diagnostic has no code. */
  code: number;
  category: "error" | "warning" | "suggestion" | "message";
  text: string;
  /** `index.ts`, not `/app/index.ts`. */
  file: string;
  /** One-based. */
  line: number;
  /** One-based, in UTF-16 code units, as tsc counts. */
  column: number;
  /**
   * End of the highlighted span, one-based. Carried so the UI can underline
   * the exact range rather than pointing at a single character.
   */
  endLine: number;
  endColumn: number;
  sourceLines: SourceLine[];
  /** Nested diagnostics, e.g. the "and here are two more" chain. */
  related: Diagnostic[];
};

/**
 * A failed type check.
 *
 * Distinct from `diagnostics: []` on purpose, and the distinction is load
 * bearing. An empty diagnostic list means "tsc ran and accepted this". A
 * compiler that trapped, panicked or was handed something it could not read
 * also yields no diagnostics, and treating that as success would wave through
 * exactly the code this module exists to reject. Callers must block on both.
 */
export type TypecheckFailure = {
  name: string;
  message: string;
  /** Whatever tsc printed to stderr: panic text, or `unported:` counters. */
  stderr: string;
};

export type TypecheckResult = {
  diagnostics: Diagnostic[];
  /** Set only when the compiler itself did not produce a verdict. */
  failure?: TypecheckFailure;
  /**
   * What the run cost. Not optional in practice — a trap inside `runOnce`
   * still reports the instantiation it managed to do — but left off the
   * `TypeChecker` interface's input side because callers in the app have no use
   * for it beyond logging.
   */
  timing?: TypecheckTiming;
};

/** The backend seam. `ts-rust` is the only member today. */
export interface TypeChecker {
  typecheck(source: string): Promise<TypecheckResult>;
}

/** ts-rust's `DiagnosticResponse`, as it arrives on the wire. */
type WireDiagnostic = {
  fileName?: string;
  startPosition?: { line?: number; character?: number };
  endPosition?: { line?: number; character?: number };
  sourceLines?: { line?: number; text?: string }[];
  code?: number;
  category?: number;
  text?: string;
  messageChain?: WireDiagnostic[];
  relatedInformation?: WireDiagnostic[];
};

/** Strip the virtual project root, so paths read the way tsc prints them. */
function displayFile(fileName: string): string {
  return fileName.startsWith(APP_DIR + "/") ? fileName.slice(APP_DIR.length + 1) : fileName;
}

function categoryName(category: number | undefined): Diagnostic["category"] {
  switch (category) {
    case CATEGORY_WARNING:
      return "warning";
    case CATEGORY_SUGGESTION:
      return "suggestion";
    case CATEGORY_MESSAGE:
      return "message";
    case CATEGORY_ERROR:
    default:
      // An unknown or absent category is an error. Reporting an unknown
      // severity as a warning would let a rejection through as a nudge.
      return "error";
  }
}

function normalize(d: WireDiagnostic): Diagnostic {
  return {
    code: d.code ?? 0,
    category: categoryName(d.category),
    text: d.text ?? "",
    file: d.fileName ? displayFile(d.fileName) : "",
    // ts-rust documents these as zero-based; every consumer wants one-based.
    line: (d.startPosition?.line ?? 0) + 1,
    column: (d.startPosition?.character ?? 0) + 1,
    endLine: (d.endPosition?.line ?? 0) + 1,
    endColumn: (d.endPosition?.character ?? 0) + 1,
    sourceLines: (d.sourceLines ?? []).map((l) => ({ line: (l.line ?? 0) + 1, text: l.text ?? "" })),
    related: [...(d.relatedInformation ?? []), ...(d.messageChain ?? [])].map(normalize),
  };
}

/**
 * Run `tsc -p /app --noEmit` over one source file.
 *
 * `noEmit` is in the generated tsconfig rather than on the command line so the
 * fixtures and the Worker cannot disagree about it.
 */
async function runOnce(source: string): Promise<TimedTypecheckResult> {
  const fs = new MemoryFs(projectFiles(source));

  const instantiatedAt = Date.now();
  let instance: WebAssembly.Instance;
  let stderr: string[];
  try {
    ({ instance, stderr } = await instantiate(mod, fs, {
      // NO_COLOR matters if a future flag turns formatting back on.
      env: ["NO_COLOR=1"],
    }));
  } catch (e) {
    // Instantiation itself trapped (for example, out of memory while
    // deserialising the 4.2 MB module). There is no instance to measure, so
    // the timing is just the time spent failing — but it is still a timing,
    // not an absent one.
    const failure = {
      name: "Trap",
      message: (e as Error)?.message ?? String(e),
      stderr: "",
    };
    return {
      diagnostics: [],
      timing: {
        instantiateMs: Date.now() - instantiatedAt,
        compileMs: 0,
        memoryPages: 0,
        peakPages: 0,
      },
      failure,
    };
  }
  const instantiateMs = Date.now() - instantiatedAt;

  const exports = instance.exports as {
    ts_input: (len: number) => number;
    ts_run: () => number;
    ts_output: () => number;
    ts_output_len: () => number;
    memory: WebAssembly.Memory;
  };

  const timing: TypecheckTiming = {
    instantiateMs,
    compileMs: 0,
    memoryPages: exports.memory.buffer.byteLength / WASM_PAGE_BYTES,
    peakPages: exports.memory.buffer.byteLength / WASM_PAGE_BYTES,
  };

  const trackPeak = () => {
    const pages = exports.memory.buffer.byteLength / WASM_PAGE_BYTES;
    if (pages > timing.peakPages) timing.peakPages = pages;
  };

  // The request is NUL-separated UTF-8: cwd, flags as a decimal number, then
  // the tsc arguments.
  const request = [APP_DIR, String(FLAG_DIAGNOSTICS_JSON), "-p", APP_DIR].join("\0");
  const bytes = new TextEncoder().encode(request);

  const inputPtr = exports.ts_input(bytes.length);
  new Uint8Array(exports.memory.buffer, inputPtr, bytes.length).set(bytes);

  let exitCode = 0;
  let exited: WasiExit | undefined;
  const compileStartedAt = Date.now();
  try {
    exitCode = exports.ts_run();
  } catch (e) {
    // Rust's panic hook exits through WASI `proc_exit`, so a panic arrives here
    // rather than as a trap. The reply buffer was written before the exit, so
    // keep it: a run can fail *after* reporting real diagnostics.
    if (!(e instanceof WasiExit)) {
      // A real trap: out of memory, or a stack overflow in the checker. It is
      // not a verdict on the program, but it happened after the module was
      // instantiated and grew, so the measurements so far are real and worth
      // keeping — without them the caller logs a peak of 0 MiB for a run that
      // did allocate.
      timing.compileMs = Date.now() - compileStartedAt;
      trackPeak();
      return {
        diagnostics: [],
        timing,
        failure: {
          name: "Trap",
          message: (e as Error)?.message ?? String(e),
          stderr: "",
        },
      };
    }
    exited = e;
    exitCode = e.code;
  }
  timing.compileMs = Date.now() - compileStartedAt;
  trackPeak();

  const stderrText = stderr.join("");
  // Exit 0 is tsc's "no diagnostics". Exit 2 is its ordinary "had
  // diagnostics". 70 is ts-rust's EXIT_UNPORTED and 2 is also EXIT_GO_PANIC,
  // so a non-zero code that produced no diagnostics is a compiler that did not
  // finish, not a program that passed.
  const diagnostics: Diagnostic[] = [];
  let reply = "";
  try {
    // Memory grows during a run, so re-read the buffer rather than caching it.
    const len = exports.ts_output_len();
    if (len > 0) {
      reply = dec.decode(new Uint8Array(exports.memory.buffer, exports.ts_output(), len));
    }
  } catch {
    reply = "";
  }

  if (reply) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(reply);
    } catch {
      // A reply we cannot read is a compiler we cannot trust, not a clean run.
      return {
        diagnostics,
        timing,
        failure: {
          name: "UnreadableReply",
          message: `tsc produced ${reply.length} bytes that are not a diagnostics array`,
          stderr: stderrText,
        },
      };
    }
    // A reply that parses but is not an array is the same failure. Accepting it
    // would leave `diagnostics` empty and report a clean check for a compiler
    // that never produced a verdict.
    if (!Array.isArray(parsed)) {
      return {
        diagnostics,
        timing,
        failure: {
          name: "UnreadableReply",
          message: `tsc produced ${reply.length} bytes that are not a diagnostics array`,
          stderr: stderrText,
        },
      };
    }
    diagnostics.push(...parsed.map(normalize));
  }

  if (!exited && exitCode !== 0 && exitCode !== 2) {
    return {
      diagnostics,
      timing,
      failure: {
        name: "CompilerExit",
        message: `tsc exited ${exitCode} without reporting diagnostics`,
        stderr: stderrText,
      },
    };
  }

  if (exited) {
    return {
      diagnostics,
      timing,
      failure: {
        name: "CompilerExit",
        message:
          `tsc ended the run with exit ${exited.code}` +
          (exited.code === 70 ? " (ts-rust: unported Go code, or a panic)" : ""),
        stderr: stderrText,
      },
    };
  }

  return { diagnostics, timing };
}

export type TypecheckTiming = {
  /** Milliseconds spent deserialising and instantiating the module. */
  instantiateMs: number;
  /** Milliseconds spent in `tsc` itself. */
  compileMs: number;
  /**
   * The module's declared initial linear memory, in 64 KiB pages. Read from the
   * instance rather than assumed, because `crates/ts_wasm/build.rs` sets
   * `-zstack-size=33554432`: the 32 MiB shadow stack is the *first* region of
   * every instance, and it is the reason the compiler does not share an isolate
   * with the 64 MiB QuickJS runtime for free.
   */
  memoryPages: number;
  /** Highest page count seen during the run. */
  peakPages: number;
};

export type TimedTypecheckResult = TypecheckResult & { timing: TypecheckTiming };

/** Bytes in one wasm page, which is how `WebAssembly.Memory` reports growth. */
const WASM_PAGE_BYTES = 65536;

/** MiB of wasm linear memory, for logging and the benchmark. */
export function peakMiB(timing: TypecheckTiming | undefined): number {
  return ((timing?.peakPages ?? 0) * WASM_PAGE_BYTES) / (1024 * 1024);
}

/**
 * The `ts_rust.wasm` type checker.
 *
 * The module import is static so the bundler includes the 4.2 MB binary, but
 * nothing is instantiated until the first `typecheck` call: deserialising the
 * module inside the Durable Object keeps it off the Worker's start-up path.
 */
export function createTypeChecker(): TypeChecker {
  return {
    // `runOnce` returns timing too; the interface narrows it away because
    // callers in the app have no use for it and `scripts/bench.mjs` reads the
    // timing off the parity worker instead.
    async typecheck(source: string): Promise<TypecheckResult> {
      // `runOnce` converts every trap into a failure result itself, so that
      // the partial timing survives. This catch is only for something
      // unexpected escaping that handling — still a failure, never a pass.
      try {
        return await runOnce(source);
      } catch (e) {
        return {
          diagnostics: [],
          failure: {
            name: "Trap",
            message: (e as Error)?.message ?? String(e),
            stderr: "",
          },
        };
      }
    },
  };
}

/** Where the program is written in the type checker's filesystem. */
export { APP_ENTRY };