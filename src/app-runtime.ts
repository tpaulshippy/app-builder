/**
 * The live app runtime: the capsule server entry evaluated once per file
 * version, with its database context stashed in QuickJS globals so queries
 * and mutations run against the same state across calls. `build` (runCapsule)
 * starts from an empty database on every call; this keeps one instead, which
 * is what makes the app view a real app rather than a preview snapshot.
 *
 * State is in-memory: new files re-initialize (a fresh database, same as
 * `lakebed dev` on restart), and a Durable Object eviction loses it — the
 * next call re-initializes from stored files.
 *
 * Probes follow the sandbox handshake (`__result`/`__err`/`__done`). When a
 * query or mutation finds no initialized runtime (eviction, or another probe
 * cleared it), it answers `{needsInit:true}` and the caller re-initializes
 * once and retries, rather than paying a liveness ping on every call.
 */

import { capsuleShapeError, inlineModules, LAKEBED_SERVER_STUB, lintCapsule, type CapsuleError } from "./capsule";
import type { Sandbox } from "./sandbox";

export type FileMap = Record<string, string>;
export type AppKind = "mutation" | "action";

export type AppState =
  | { ok: true; tables: string[]; queries: Record<string, unknown> }
  | { ok: false; error: CapsuleError };

export type AppMutation =
  | { ok: true; result: unknown; tables: string[]; queries: Record<string, unknown> }
  | { ok: false; error: CapsuleError };

export const NEEDS_INIT = { needsInit: true as const };
export type NeedsInit = typeof NEEDS_INIT;

/** Identity check with narrowing: the singleton above is the only such value. */
export function isNeedsInit(v: unknown): v is NeedsInit {
  return v === NEEDS_INIT;
}

/** Cheap synchronous key for "have the files changed since init". */
export function fileKey(files: FileMap): string {
  const names = Object.keys(files).sort();
  let h1 = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h1 ^= s.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193);
    }
  };
  for (const name of names) {
    mix(name);
    mix("\0");
    mix(files[name] ?? "");
    mix("\0");
  }
  return (h1 >>> 0).toString(16);
}

const HANDSHAKE_RESET = `
globalThis.__out = "";
globalThis.__result = undefined;
globalThis.__err = undefined;
globalThis.__done = false;`;

const RUN_ALL_QUERIES = `
    const queries = {};
    for (const [name, q] of Object.entries(app.def.queries ?? {})) {
      queries[name] = await (typeof q === "function" ? q : q.handler)(app.ctx);
    }`;

/**
 * Initialize (or re-initialize) the app runtime: evaluate the server entry,
 * build its database context, stash both in `globalThis.__app`, and answer
 * the initial query state. Throws when the server entry does not bundle.
 */
export function buildInitProbe(files: FileMap): string {
  const inlined = inlineModules("server/index.ts", files, { stubBare: { "lakebed/server": "__lakebedServer" } });
  return (
    `{ ${LAKEBED_SERVER_STUB}\n${inlined} }\n` +
    HANDSHAKE_RESET +
    `
(async function () {
  try {
    const def = globalThis.__entryDefault;
    if (!def || typeof def !== "object" || typeof def.schema !== "object") {
      throw new Error("server/index.ts must default-export capsule({...}) from lakebed/server");
    }
    const app = { def, ctx: globalThis.__lakebedServer.__ctxFor(def.schema) };
    const queries = {};
    for (const [name, q] of Object.entries(app.def.queries ?? {})) {
      queries[name] = await (typeof q === "function" ? q : q.handler)(app.ctx);
    }
    globalThis.__app = app;
    globalThis.__result = JSON.stringify({ tables: Object.keys(app.def.schema), queries });
  } catch (e) {
    globalThis.__result = undefined;
    globalThis.__err = { name: (e && e.name) || "Error", message: String((e && e.message) || e) };
  }
  globalThis.__done = true;
})();`
  );
}

/** Run every query against the stashed runtime. Needs no bundle. */
export function buildQueryProbe(): string {
  return (
    HANDSHAKE_RESET +
    `
(async function () {
  try {
    const app = globalThis.__app;
    if (!app || !app.def || !app.ctx) {
      globalThis.__result = JSON.stringify({ needsInit: true });
    } else {
${RUN_ALL_QUERIES}
      globalThis.__result = JSON.stringify({ tables: Object.keys(app.def.schema ?? {}), queries });
    }
  } catch (e) {
    globalThis.__result = undefined;
    globalThis.__err = { name: (e && e.name) || "Error", message: String((e && e.message) || e) };
  }
  globalThis.__done = true;
})();`
  );
}

/**
 * Run one mutation (or action) positionally against the stashed runtime,
 * then re-run every query so the caller refreshes in one round trip. Call
 * arguments travel in a global: they already survived JSON, so embedding the
 * serialized form is quoting-safe.
 */
export function buildMutateProbe(kind: AppKind, name: string, args: unknown[]): string {
  const call = JSON.stringify({ kind, name, args });
  return (
    `globalThis.__call = ${call};` +
    HANDSHAKE_RESET +
    `
(async function () {
  try {
    const app = globalThis.__app;
    const call = globalThis.__call;
    globalThis.__call = undefined;
    if (!app || !app.def || !app.ctx) {
      globalThis.__result = JSON.stringify({ needsInit: true });
    } else {
      const handlers = call.kind === "action" ? (app.def.actions ?? {}) : (app.def.mutations ?? {});
      const h = handlers[call.name];
      if (h === undefined) throw new Error("unknown " + call.kind + ": " + call.name);
      const result = await (typeof h === "function" ? h : h.handler)(app.ctx, ...(call.args ?? []));
${RUN_ALL_QUERIES}
      globalThis.__result = JSON.stringify({
        result: result === undefined ? null : result,
        tables: Object.keys(app.def.schema ?? {}),
        queries,
      });
    }
  } catch (e) {
    globalThis.__result = undefined;
    globalThis.__err = { name: (e && e.name) || "Error", message: String((e && e.message) || e) };
  }
  globalThis.__done = true;
})();`
  );
}

function toError(raw: { ok: boolean; error?: CapsuleError }): CapsuleError {
  return raw.error ?? { name: "Error", message: "unreadable result from the isolate" };
}

function parseState(rawResult: unknown): AppState | NeedsInit {
  let parsed: { tables?: unknown; queries?: unknown; needsInit?: unknown };
  try {
    parsed = JSON.parse(String(rawResult));
  } catch {
    return { ok: false, error: { name: "Result", message: `app runtime returned unreadable state: ${String(rawResult)}` } };
  }
  if (parsed && parsed.needsInit === true) return NEEDS_INIT;
  if (!parsed || !Array.isArray(parsed.tables) || typeof parsed.queries !== "object" || parsed.queries === null) {
    return { ok: false, error: { name: "Result", message: `app runtime returned unreadable state: ${String(rawResult)}` } };
  }
  return { ok: true, tables: parsed.tables as string[], queries: parsed.queries as Record<string, unknown> };
}

export async function initAppRuntime(files: FileMap, sandbox: Sandbox): Promise<AppState> {
  const shape = capsuleShapeError(files);
  if (shape) return { ok: false, error: { name: "Shape", message: shape } };
  const problems = lintCapsule(files);
  if (problems.length) return { ok: false, error: { name: "Lint", message: problems.join("\n") } };
  let probe: string;
  try {
    probe = buildInitProbe(files);
  } catch (e: any) {
    return { ok: false, error: { name: "Bundle", message: e?.message ?? String(e) } };
  }
  const raw = await sandbox.runRaw(probe, "app-init.ts");
  if (!raw.ok || raw.error) return { ok: false, error: toError(raw) };
  const parsed = parseState(raw.result);
  // The init probe never answers needsInit, but the parser type allows it.
  if (isNeedsInit(parsed)) {
    return { ok: false, error: { name: "Runtime", message: "app runtime did not initialize" } };
  }
  return parsed;
}

export async function queryAppRuntime(sandbox: Sandbox): Promise<AppState | NeedsInit> {
  const raw = await sandbox.runRaw(buildQueryProbe(), "app-query.ts");
  if (!raw.ok || raw.error) return { ok: false, error: toError(raw) };
  return parseState(raw.result);
}

export async function mutateAppRuntime(
  sandbox: Sandbox,
  kind: AppKind,
  name: string,
  args: unknown[],
): Promise<AppMutation | NeedsInit> {
  const raw = await sandbox.runRaw(buildMutateProbe(kind, name, args), "app-mutate.ts");
  if (!raw.ok || raw.error) return { ok: false, error: toError(raw) };
  let parsed: { result?: unknown; tables?: unknown; queries?: unknown; needsInit?: unknown };
  try {
    parsed = JSON.parse(String(raw.result));
  } catch {
    return { ok: false, error: { name: "Result", message: `app runtime returned unreadable state: ${String(raw.result)}` } };
  }
  if (parsed && parsed.needsInit === true) return NEEDS_INIT;
  if (!parsed || !Array.isArray(parsed.tables) || typeof parsed.queries !== "object" || parsed.queries === null) {
    return { ok: false, error: { name: "Result", message: `app runtime returned unreadable state: ${String(raw.result)}` } };
  }
  return {
    ok: true,
    result: parsed.result ?? null,
    tables: parsed.tables as string[],
    queries: parsed.queries as Record<string, unknown>,
  };
}
