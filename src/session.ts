import { DurableObject } from "cloudflare:workers";
import { createSandbox, type RunResult } from "./sandbox";

/**
 * One Durable Object per session, so one QuickJS runtime and context.
 *
 * The context deliberately outlives individual requests. Re-running with new
 * source replaces the program inside the same VM while globals from the previous
 * run are still there, which is the property this prototype exists to show.
 *
 * A Durable Object can be evicted at any time, and with it the in-memory globals
 * live in that runtime. Losing them on eviction is expected and invisible to the
 * demo; persisting them to the DO's SQLite storage is the obvious next step.
 */
export class AppSession extends DurableObject {
  private readonly sandbox = createSandbox();

  async run(code: string): Promise<RunResult> {
    return this.sandbox.run(code);
  }
}