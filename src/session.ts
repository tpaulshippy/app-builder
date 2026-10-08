import { DurableObject } from "cloudflare:workers";
import { createSandbox, type RunResult } from "./sandbox";
import { createTypeChecker, peakMiB } from "./typecheck";

/**
 * One Durable Object per session, so one QuickJS runtime and context.
 *
 * The context deliberately outlives individual requests. Re-running with new
 * source replaces the program inside the same VM while globals from the previous
 * run are still there, which is the property this prototype exists to show.
 *
 * A Durable Object can be evicted at any time, and with it the in-memory globals
 * live in that runtime. Losing them on eviction is expected and invisible to
 * the demo; persisting them to the DO's SQLite storage is the obvious next step.
 *
 * ## Why the type checker lives here
 *
 * Type checking gates `sandbox.run`, and it runs inside the Durable Object for
 * two reasons. A 4.2 MB module must not be deserialised on the Worker's
 * one-second start-up path, and `ts_rust.wasm` keeps one program per process,
 * so the module is instantiated per run rather than held. Neither cost
 * belongs in the request-handling Worker, which also stays free of the
 * compiler's memory: see the shadow-stack note in `typecheck.ts`.
 */
export class AppSession extends DurableObject {
  private readonly sandbox = createSandbox();
  private readonly typechecker = createTypeChecker();

  async run(code: string): Promise<RunResult> {
    const startedAt = Date.now();

    // Type check first. A program tsc rejects must not reach QuickJS: the point
    // is that a wrong type fails here, loudly, rather than three layers down as
    // `undefined`.
    const checked = await this.typechecker.typecheck(code);
    const typecheckMs = Date.now() - startedAt;

    // A type check costs a fresh 4.7 MB module instantiation per run, and the
    // compiler's peak linear memory is ~69 MiB because `crates/ts_wasm/build.rs`
    // reserves a 32 MiB shadow stack. Both numbers decide whether this can ever
    // move off the build-loop path, and both are only knowable by measuring.
    // Structured fields rather than a sentence, so they survive log parsing.
    console.log({
      event: "typecheck",
      ms: typecheckMs,
      instantiateMs: checked.timing?.instantiateMs,
      compileMs: checked.timing?.compileMs,
      peakMiB: Number(peakMiB(checked.timing).toFixed(1)),
      diagnostics: checked.diagnostics.length,
      failed: Boolean(checked.failure),
    });

    // A compiler that did not finish is not a pass. Block the run, and say why,
    // rather than executing unchecked code because the diagnostic list is
    // empty.
    if (checked.failure) {
      return {
        ok: false,
        html: "",
        logs: [],
        typecheckError: checked.failure,
        typecheckMs,
        durationMs: Date.now() - startedAt,
      };
    }

    if (checked.diagnostics.length) {
      return {
        ok: false,
        html: "",
        logs: [],
        diagnostics: checked.diagnostics,
        typecheckMs,
        durationMs: Date.now() - startedAt,
      };
    }

    // The type check is part of what a run costs, so it is reported on the
    // success path too, not only when it rejected the program.
    const result = await this.sandbox.run(code);
    return { ...result, typecheckMs };
  }
}