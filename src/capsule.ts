/**
 * Capsule runtime for the isolate.
 *
 * Lakebed's `lakebed build` uses esbuild (native binary), which cannot run in
 * a Worker. For the capsules our agent writes — relative imports only, plus
 * `lakebed/server` — a small pure-TS path is faithful: sucrase-transform each
 * file, inline relative imports in dependency order, and execute the server
 * entry in QuickJS against a stub `lakebed/server` with a real in-memory
 * database. That gives `build` (shape + smoke-run every query) and `test`
 * (assertions against the same stub) lakebed-dev-like semantics.
 */

import { transform } from "sucrase";
import { isSafePath } from "./paths";
import { createSandbox, type Sandbox } from "./sandbox";

export type FileMap = Record<string, string>;

export type CapsuleError = { name: string; message: string; stack?: string };

export type CapsuleResult = {
  ok: boolean;
  /** Table names declared in schema. */
  tables: string[];
  /** One entry per query smoke-run: name -> rows or scalar. */
  queries: Record<string, unknown>;
  logs: string[];
  error?: CapsuleError;
  durationMs: number;
};

/** Files every new capsule starts with. The agent edits these. */
export const DEFAULT_FILES: FileMap = {
  "server/index.ts": `import { boolean, capsule, endpoint, json, mutation, query, string, table, userId } from "lakebed/server";

export default capsule({
  schema: {
    todos: table({
      text: string(),
      done: boolean().default(false),
      ownerId: userId(),
    }).index("by_owner", ["ownerId"]),
  },
  queries: {
    todos: query(async (ctx) => {
      const { userId } = ctx.auth.requireIdentity();
      return ctx.db.todos
        .withIndex("by_owner", (q) => q.eq("ownerId", userId))
        .order("desc")
        .collect();
    }),
  },
  mutations: {
    addTodo: mutation(async (ctx, text: string) => {
      const { userId } = ctx.auth.requireIdentity();
      return ctx.db.todos.insert({ text, done: false, ownerId: userId });
    }),
  },
  endpoints: {
    health: endpoint({ method: "GET", path: "/api/health", readOnly: true }, async () => json({ ok: true })),
  },
});
`,
  "client/index.tsx": `import { createClient } from "lakebed/client";
import type app from "../server/index";

const client = createClient<typeof app>();

export function App() {
  const todos = client.useQuery("todos");
  const addTodo = client.useMutation("addTodo");
  if (todos === undefined) return <main>Loading…</main>;
  return (
    <main>
      <h1>Todos</h1>
      <ul>
        {todos.map((t) => (
          <li key={t.id}>{t.text}</li>
        ))}
      </ul>
      <button onClick={() => addTodo("New todo")}>Add</button>
    </main>
  );
}
`,
  "shared/types.ts": `export interface NewTodo {
  text: string;
}
`,
};

/** Resolve an import to a FileMap key: bare specs via `bareMap`, relative by path. */
export function resolveImport(
  fromFile: string,
  spec: string,
  files: FileMap,
  bareMap: Record<string, string> = {},
): string | null {
  if (!spec.startsWith(".")) {
    const mapped = bareMap[spec];
    return mapped && mapped in files ? mapped : null;
  }
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const base = (dir ? `${dir}/` : "") + spec;
  const norm = base
    .split("/")
    .reduce<string[]>((acc, seg) => {
      if (seg === "" || seg === ".") return acc;
      if (seg === "..") acc.pop();
      else acc.push(seg);
      return acc;
    }, [])
    .join("/");
  const candidates = [norm, `${norm}.ts`, `${norm}.tsx`, `${norm}/index.ts`, `${norm}/index.tsx`];
  return candidates.find((c) => c in files) ?? null;
}

/** All static + dynamic module specifiers in one file. */
function importSpecs(source: string): string[] {
  const specs: string[] = [];
  const staticRe = /^\s*import\s+(?!type\b)(?:[^;]+?\s+from\s+)?["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(source))) {
    if (m[1] !== undefined) specs.push(m[1]);
  }
  const dynamicRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynamicRe.exec(source))) {
    if (m[1] !== undefined) specs.push(m[1]);
  }
  return specs;
}
/** Direct relative dependencies of one file. */
function depsOf(path: string, source: string, files: FileMap, bareMap: Record<string, string> = {}): string[] {
  const out: string[] = [];
  for (const spec of importSpecs(source)) {
    const r = resolveImport(path, spec, files, bareMap);
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/** Entry plus transitive deps, dependencies first. Throws on cycles. */
export function orderFiles(
  entry: string,
  files: FileMap,
  bareMap: Record<string, string> = {},
): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (path: string) => {
    if (ordered.includes(path)) return;
    if (visiting.has(path)) throw new Error(`circular import involving ${path}`);
    visiting.add(path);
    const source = files[path] ?? "";
    for (const d of depsOf(path, source, files, bareMap)) visit(d);
    visiting.delete(path);
    ordered.push(path);
  };
  visit(entry);
  return ordered;
}

function stripTypeScript(source: string, path = "file.ts"): string {
  const { code } = transform(source, {
    transforms: ["typescript",
      ...(path.endsWith(".tsx") || path.endsWith(".jsx") ? (["jsx"] as const) : [])],
    // No ES downleveling: concatenated chunks would redeclare sucrase's
    // helpers, and both targets (QuickJS, modern browsers/node) parse ?.?/?..
    disableESTransforms: true,
    jsxPragma: "h",
    jsxFragmentPragma: "Fragment",
  });
  return code;
}

/**
 * Rewrite imports in sucrase output. Imports may follow sucrase's
 * `const _jsxFileName = "";` prefix, so matchers tolerate a `;`/`}` prefix.
 * Relative imports become comments (inlined elsewhere); bare imports become
 * stub destructures when given, otherwise are kept for the platform.
 */
export function rewriteImports(
  js: string,
  opts: { stubBare?: Record<string, string>; bareMap?: Record<string, string> } = {},
): string {
  js = js.replace(/(^|[;}])\s*import\s+type\s[^;]+;/gm, "$1");
  js = js.replace(/(^|[;}])\s*import\s+["']\.[^"']*["'];?/gm, "$1");
  js = js.replace(
    /(^|[;}])\s*import\s+([^;]+?)\s+from\s+["']([^"']+)["'];?/gm,
    (_m, pre: string, clause: string, spec: string) => {
      const c = clause.trim();
      if (spec.startsWith(".")) return `${pre}/* inlined: ${spec} */`;
      if (opts.bareMap?.[spec]) return `${pre}/* vendored: ${spec} */`;
      const stub = opts.stubBare?.[spec];
      if (stub) {
        if (c.startsWith("{")) return `${pre}const ${c} = ${stub};`;
        if (c.startsWith("* as")) return `${pre}const ${c.slice(5).trim()} = ${stub};`;
        return `${pre}const ${c} = ${stub}.default ?? ${stub};`;
      }
      return `${pre}import ${c} from "${spec}";`;
    },
  );
  return js;
};

/** Render one file to JS: strip types, rewrite imports, capture entry default. */
function renderFile(
  path: string,
  source: string,
  isEntry: boolean,
  stubBare?: Record<string, string>,
  bareMap?: Record<string, string>,
): string {
  let js = rewriteImports(stripTypeScript(source, path), { stubBare, bareMap });
  // export default -> capture (entry) or drop; other exports -> strip keyword
  js = isEntry
    ? js.replace(/^\s*export\s+default\s+/m, "globalThis.__entryDefault = ")
    : js.replace(/^\s*export\s+default\s+([^;]+);?/m, "/* default export dropped: non-entry */");
  js = js.replace(/^\s*export\s+(?=(?:const|let|var|function|class|async function)\b)/gm, "");
  // export { a, b } -> drop (names already in scope)
  js = js.replace(/^\s*export\s*\{[^}]*\};?/gm, "");
  return `// ---- ${path} ----\n${js}`;
}

/**
 * Inline relative modules into one JS unit. Relative imports/exports are
 * rewritten to share one scope; bare imports (`lakebed/*`, `preact*`) are
 * rewritten to destructured stub globals when a stub name is given, or kept
 * as-is for the deploy bundle (the platform provides them).
 */
export function inlineModules(
  entry: string,
  files: FileMap,
  opts: { stubBare?: Record<string, string>; bareMap?: Record<string, string> } = {},
): string {
  return orderFiles(entry, files, opts.bareMap ?? {})
    .map((path) => renderFile(path, files[path] ?? "", path === entry, opts.stubBare, opts.bareMap))
    .join("\n");
}

/**
 * Inline like `inlineModules`, but splice `injectAfter[path]` right after
 * that file's chunk — used to materialize the test context once the server
 * entry has evaluated, before test files run.
 */
export function inlineModulesWithInjection(
  entry: string,
  files: FileMap,
  injectAfter: Record<string, string>,
  opts: { stubBare?: Record<string, string>; bareMap?: Record<string, string> } = {},
): string {
  return orderFiles(entry, files, opts.bareMap ?? {})
    .map((path) => {
      const chunk = renderFile(path, files[path] ?? "", path === entry, opts.stubBare, opts.bareMap);
      const extra = injectAfter[path];
      return extra ? `${chunk}\n${extra}` : chunk;
    })
    .join("\n");
}

/**
 * JS stub for `lakebed/server`.
 *
 * Descriptor shapes mirror the real `lakebed` package exactly (`{kind,
 * defaultValue?, optionalValue?, refTable?}` fields, `{kind:"table", fields,
 * indexes[]}` tables, identity query/mutation/action, `{kind:"endpoint",
 * method, path, readOnly}` endpoints) so schema extraction matches what
 * `lakebed build` would serialize. The database is in-memory and resets every
 * run — the same contract as `lakebed dev`, whose local state is in-memory.
 */
export const LAKEBED_SERVER_STUB = `
globalThis.__lakebedServer = (() => {
  const namePattern = /^[A-Za-z][A-Za-z0-9_]*$/;
  const createField = (kind, extra) => ({
    kind, ...extra,
    default(v) { return { ...this, defaultValue: v }; },
    optional() { return { ...this, optionalValue: true }; },
  });
  // Tables materialize from the capsule definition once capsule() runs, so
  // ctx.db always matches the declared schema.
  let dbTables = new Map();
  const matches = (row, filters) => filters.every(([k, v]) => row[k] === v);
  const applyDefaults = (desc, obj) => {
    const row = { ...obj };
    for (const [k, f] of Object.entries(desc)) {
      if (row[k] === undefined && f && typeof f === "object" && "defaultValue" in f) row[k] = f.defaultValue;
    }
    return row;
  };
  const buildDb = (schema) => {
    dbTables = new Map();
    for (const [name, t] of Object.entries(schema ?? {})) {
      const desc = t.fields ?? {};
      const rows = [];
      dbTables.set(name, {
        async insert(obj) {
          const row = {
            id: "id_" + Math.random().toString(36).slice(2, 10),
            createdAt: Date.now(), updatedAt: Date.now(),
            ...applyDefaults(desc, obj),
          };
          rows.push(row);
          return row.id;
        },
        async get(id) { return rows.find((r) => r.id === id) ?? null; },
        async update(id, patch) {
          const row = rows.find((r) => r.id === id);
          if (!row) throw new Error("not found: " + id);
          Object.assign(row, patch, { updatedAt: Date.now() });
        },
        async delete(id) {
          const i = rows.findIndex((r) => r.id === id);
          if (i === -1) throw new Error("not found: " + id);
          rows.splice(i, 1);
        },
        withIndex(idx, fn) {
          const q = { _filters: [], eq(k, v) { q._filters.push([k, v]); return q; } };
          if (fn) fn(q);
          const view = rows.filter((r) => matches(r, q._filters));
          const chain = {
            order(dir) {
              view.sort((a, b) => dir === "desc" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt);
              return chain;
            },
            async collect() { return view.map((r) => ({ ...r })); },
            async take(n) { return view.slice(0, n).map((r) => ({ ...r })); },
            async first() { return view.length ? { ...view[0] } : null; },
            async paginate(p) {
              const n = (p && p.numItems) || 25;
              return { page: view.slice(0, n).map((r) => ({ ...r })), isDone: view.length <= n, cursor: null };
            },
          };
          return chain;
        },
      });
    }
    return Object.fromEntries([...dbTables.entries()]);
  };
  return {
    __buildDb: buildDb,
    __ctxFor: (schema) => ({
      auth: {
        requireIdentity() { return { userId: "guest-test", provider: "guest", isGuest: true }; },
        requireSignedIn() { throw new Error("signed in account required"); },
      },
      db: buildDb(schema),
      env: {},
      log: { info() {}, warn() {}, error() {} },
    }),
    capsule: (d) => d,
    table: (fields) => {
      const definition = {
        fields, indexes: [], kind: "table",
        index(name, indexFields) {
          if (!namePattern.test(name)) throw new Error('Index name "' + name + '" must start with a letter');
          return { ...this, indexes: [...this.indexes, { fields: [...indexFields], name }] };
        },
      };
      return definition;
    },
    query: (h) => h,
    mutation: (h) => h,
    action: (h) => h,
    endpoint: (route, h) => {
      const method = String((route && route.method) || "").toUpperCase();
      return {
        handler: h, kind: "endpoint", method, path: String((route && route.path) || ""),
        readOnly: (route && route.readOnly !== undefined) ? route.readOnly : (method === "GET" || method === "HEAD"),
      };
    },
    string: () => createField("string"),
    boolean: () => createField("boolean"),
    number: () => createField("number"),
    id: (t) => createField("id", { refTable: t }),
    userId: () => createField("userId"),
    json: (v) => ({ kind: "response", body: JSON.stringify(v ?? null) }),
    text: (v) => ({ kind: "response", body: String(v ?? "") }),
  };
})();
`;

export type CapsuleTests = {
  ok: boolean;
  passed: number;
  failed: { file: string; test: string; message: string }[];
  logs: string[];
  durationMs: number;
};

const EXPECT_HARNESS = `
globalThis.__passed = 0;
globalThis.__failures = [];
globalThis.__its = [];
globalThis.describe = (_name, fn) => { globalThis.__its.push(Promise.resolve().then(() => fn())); };
globalThis.it = (name, fn) => {
  globalThis.__its.push((async () => {
    try { await fn(); globalThis.__passed++; }
    catch (e) { globalThis.__failures.push({ test: String(name), message: String((e && e.message) || e) }); }
  })());
};
globalThis.expect = (actual) => {
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    toBe: (exp) => { if (!Object.is(actual, exp)) throw new Error("expected " + JSON.stringify(actual) + " to be " + JSON.stringify(exp)); },
    toEqual: (exp) => { if (!eq(actual, exp)) throw new Error("expected " + JSON.stringify(actual) + " to equal " + JSON.stringify(exp)); },
    toContain: (exp) => {
      const ok = typeof actual === "string" ? actual.includes(exp) : Array.isArray(actual) && actual.includes(exp);
      if (!ok) throw new Error("expected " + JSON.stringify(actual) + " to contain " + JSON.stringify(exp));
    },
    toBeTruthy: () => { if (!actual) throw new Error("expected " + JSON.stringify(actual) + " to be truthy"); },
    toBeNull: () => { if (actual !== null) throw new Error("expected " + JSON.stringify(actual) + " to be null"); },
    toBeGreaterThan: (exp) => { if (!(actual > exp)) throw new Error("expected " + JSON.stringify(actual) + " to be > " + JSON.stringify(exp)); },
  };
};
`;

/**
 * Run `*.test.ts` files in the isolate. Each file executes against the stub
 * database with `__testCtx` (fresh tables per file) plus `describe/it/expect`.
 * Only settled promises work — same constraint as `build`.
 */
export async function runCapsuleTests(files: FileMap, sandbox?: Sandbox): Promise<CapsuleTests> {
  const startedAt = Date.now();
  const sb = sandbox ?? createSandbox();
  const testFiles = Object.keys(files).filter((p) => p.endsWith(".test.ts") || p.endsWith(".test.tsx"));
  if (!testFiles.length) {
    return { ok: true, passed: 0, failed: [], logs: [], durationMs: Date.now() - startedAt };
  }
  const failed: CapsuleTests["failed"] = [];
  const logs: string[] = [];
  let passed = 0;
  const stubBare = { "lakebed/server": "__lakebedServer" };
  for (const file of testFiles) {
    let combined: string;
    try {
      // Server entry first (dependency order), then __testCtx is
      // materialized from its schema before the test file runs. Tests that
      // never import the server still get it: the entry is prepended unless
      // the test already pulls it in.
      const stubOpts = { stubBare };
      const needsServer = !orderFiles(file, files).includes("server/index.ts");
      const serverFirst = needsServer
        ? inlineModules("server/index.ts", files, stubOpts) +
          "\nglobalThis.__testCtx = globalThis.__lakebedServer.__ctxFor((globalThis.__entryDefault && globalThis.__entryDefault.schema) || {});\n"
        : "";
      combined =
        serverFirst +
        inlineModulesWithInjection(
          file,
          files,
          {
            "server/index.ts":
              "globalThis.__testCtx = globalThis.__lakebedServer.__ctxFor((globalThis.__entryDefault && globalThis.__entryDefault.schema) || {});",
          },
          stubOpts,
        );
    } catch (e: any) {
      failed.push({ file, test: "(bundle)", message: e?.message ?? String(e) });
      continue;
    }
    const probe = `{ ${LAKEBED_SERVER_STUB}\n${EXPECT_HARNESS} }\n` + `
globalThis.__out = "";
globalThis.__result = undefined;
globalThis.__err = undefined;
globalThis.__done = false;
globalThis.__passed = 0;
globalThis.__failures = [];
(async function () {
  try {
    ${combined}
    let __pending = 0;
    while (__pending < globalThis.__its.length) {
      const batch = globalThis.__its.slice(__pending);
      __pending = globalThis.__its.length;
      await Promise.all(batch);
    }
    globalThis.__result = JSON.stringify({ passed: globalThis.__passed, failures: globalThis.__failures });
  } catch (e) {
    globalThis.__err = { name: (e && e.name) || "Error", message: String((e && e.message) || e) };
  }
  globalThis.__done = true;
})();`;
    const raw = await sb.runRaw(probe, file);
    logs.push(...raw.logs);
    if (!raw.ok || raw.error) {
      failed.push({ file, test: "(runtime)", message: raw.error ? `${raw.error.name}: ${raw.error.message}` : "unknown" });
      continue;
    }
    try {
      const r = JSON.parse(String(raw.result));
      passed += r.passed;
      for (const f of r.failures) failed.push({ file, test: f.test, message: f.message });
    } catch {
      failed.push({ file, test: "(result)", message: `unreadable result: ${String(raw.result)}` });
    }
  }
  return { ok: failed.length === 0, passed, failed, logs, durationMs: Date.now() - startedAt };
}

/** Validate capsule shape before build/test/deploy. Returns error or null. */
export function capsuleShapeError(files: FileMap): string | null {
  if (!("server/index.ts" in files)) return "missing server/index.ts — a capsule needs a server entry";
  if (!("client/index.tsx" in files)) return "missing client/index.tsx — a capsule needs a client entry";
  for (const p of Object.keys(files)) {
    if (!isSafePath(p)) return `refusing unsafe path: ${p}`;
  }
  return null;
}

/** Forbidden patterns the isolate cannot run (mirror of agent prompt limits). */
export function lintCapsule(files: FileMap): string[] {
  const problems: string[] = [];
  const shape = capsuleShapeError(files);
  if (shape) problems.push(shape);
  for (const [path, source] of Object.entries(files)) {
    for (const spec of importSpecs(source)) {
      if (
        !spec.startsWith(".") &&
        !spec.startsWith("lakebed/") &&
        !spec.startsWith("preact")
      ) {
        problems.push(
          `${path}: import "${spec}" is not available — only relative files, lakebed/*, and preact`,
        );
      }
    }
    if (/\bprocess\b|\bBuffer\b|\brequire\s*\(/.test(source)) {
      problems.push(`${path}: Node built-ins are not available in capsules`);
    }
    try {
      stripTypeScript(source, path);
    } catch (e: any) {
      problems.push(`${path}: does not parse: ${e?.message ?? e}`);
    }
  }
  return problems;
}

/**
 * Build = validate shape, parse every file, execute the server entry against
 * the stub DB, and smoke-run each query. Client code is parsed, not executed
 * (it needs a DOM).
 */
export async function runCapsule(files: FileMap, sandbox?: Sandbox): Promise<CapsuleResult> {
  const startedAt = Date.now();
  const fail = (name: string, message: string, extra?: Partial<CapsuleResult>): CapsuleResult => ({
    ok: false, tables: [], queries: {}, logs: [], error: { name, message }, durationMs: Date.now() - startedAt, ...extra,
  });

  const shape = capsuleShapeError(files);
  if (shape) return fail("Shape", shape);
  const problems = lintCapsule(files);
  if (problems.length) return fail("Lint", problems.join("\n"));

  let inlined: string;
  try {
    inlined = inlineModules("server/index.ts", files, { stubBare: { "lakebed/server": "__lakebedServer" } });
  } catch (e: any) {
    return fail("Bundle", e?.message ?? String(e));
  }

  const sb = sandbox ?? createSandbox();
  // The probe manages the globals handshake itself: it sets __out/__logs for
  // console capture, __result to a JSON summary, __err on failure, and __done.
  const probe = `{ ${LAKEBED_SERVER_STUB}\n${inlined} }\n` + `
globalThis.__out = "";
globalThis.__result = undefined;
globalThis.__err = undefined;
globalThis.__done = false;
(async function () {
  try {
    const def = globalThis.__entryDefault;
    if (!def || typeof def !== "object" || typeof def.schema !== "object") {
      throw new Error("server/index.ts must default-export capsule({...}) from lakebed/server");
    }
    const tables = Object.keys(def.schema);
    const queries = {};
    const ctx = globalThis.__lakebedServer.__ctxFor(def.schema);
    for (const [name, q] of Object.entries(def.queries ?? {})) {
      queries[name] = await (typeof q === "function" ? q : q.handler)(ctx);
    }
    globalThis.__result = JSON.stringify({ tables, queries });
  } catch (e) {
    globalThis.__err = { name: (e && e.name) || "Error", message: String((e && e.message) || e) };
  }
  globalThis.__done = true;
})();`;

  const raw = await sb.runRaw(probe, "capsule.ts");
  if (!raw.ok || raw.error) {
    return fail(raw.error?.name ?? "Error", raw.error?.message ?? "unknown", { logs: raw.logs });
  }
  let parsed: { tables: string[]; queries: Record<string, unknown> };
  try {
    parsed = JSON.parse(String(raw.result));
  } catch {
    return fail("Result", `server entry returned unreadable state: ${String(raw.result)}`, { logs: raw.logs });
  }
  return {
    ok: true,
    tables: parsed.tables,
    queries: parsed.queries,
    logs: raw.logs,
    durationMs: Date.now() - startedAt,
  };
}
