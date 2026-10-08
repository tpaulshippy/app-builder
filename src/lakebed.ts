/**
 * In-isolate `lakebed deploy`.
 *
 * `lakebed build` uses esbuild (native binary), which cannot run in a Worker.
 * For the capsules our agent writes — relative imports only, `lakebed/*` and
 * `preact` otherwise — the artifact the control plane accepts can be assembled
 * with pure TS: sucrase-transform each file, inline relative modules, extract
 * the capsule definition by executing the server entry in QuickJS, and POST
 * the envelope. Schema/endpoint/auth serialization and the forbidden-source
 * checks mirror the lakebed CLI so a local `lint` predicts deploy acceptance.
 *
 * Pinned against lakebed@0.0.39 (constants copied from its dist output).
 */

import { transform } from "sucrase";
import { LAKEBED_SERVER_STUB, capsuleShapeError, inlineModules, lintCapsule, orderFiles, rewriteImports } from "./capsule";
import type { Sandbox } from "./sandbox";

export type FileMap = Record<string, string>;
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const LAKEBED_API = "https://api.lakebed.dev";
const LAKEBED_VERSION = "0.0.39";
const ARTIFACT_FORMAT = "lakebed.capsule.artifact.v2";
const DATABASE_API_VERSION = 1;
const INDEX_CODEC_VERSION = 1;

const ANONYMOUS_LIMITS = {
  maxRowsReturned: 1000,
  maxValueBytes: 65536,
  maxIndexKeyBytes: 2048,
  maxRowsRead: 5000,
  maxBytesRead: 4 * 1024 * 1024,
  maxDirectGets: 1000,
  maxScanCalls: 100,
  maxWrites: 1000,
};

export type DeployResult =
  | { ok: true; url: string; deployId: string; expiresAt?: string; claimed: boolean }
  | { ok: false; message: string };

type Diagnostic = { file: string; message: string };
const diagnostic = (file: string, message: string): Diagnostic => ({ file, message });

/** Anonymous-server forbidden patterns, mirroring the lakebed CLI. */
const FORBIDDEN: [RegExp, string][] = [
  [/\beval\s*\(/, "eval is not available in anonymous server code. Write the logic out as normal code."],
  [/\bFunction\s*\(/, "Function constructors are not available in anonymous server code."],
  [/\bimport\s*\(/, "Dynamic import is not available in anonymous server code. Move the import to a static import."],
  [/\bfetch\b/, "Outbound fetch is disabled for anonymous deploys. Claim this deploy, then deploy again."],
  [/\bwhile\s*\(/, "while loops are not available in anonymous server code. Use for...of with a fixed bound."],
  [/\bfor\s*\(\s*;/, "Unbounded for loops are not available in anonymous server code."],
  [/\bprocess\b/, "process is not available in capsule code. Use ctx.env in a handler with a claimed deploy."],
  [/\bglobalThis\b/, "globalThis is not available in anonymous server code. Keep state in ctx.db."],
  [/\bsetTimeout\s*\(/, "Timers are not available in anonymous server code. Do the work inline."],
  [/\bsetInterval\s*\(/, "Timers are not available in anonymous server code. Do the work inline."],
  [ /\.where\s*\(/, "where() is a legacy full-scan database API. Declare an index and use withIndex()."],
  [ /\.orderBy\s*\(/, "orderBy() is a legacy in-memory database API. Use index traversal with order()."],
];

/** Anonymous-server forbidden checks, also surfaced by `lint`. */
export function deployLint(files: FileMap): Diagnostic[] {
  const out: Diagnostic[] = [];
  const shape = capsuleShapeError(files);
  if (shape) out.push(diagnostic("(shape)", shape));
  for (const [path, source] of Object.entries(files)) {
    if (!path.startsWith("server/") && !path.startsWith("shared/")) continue;
    for (const [pattern, message] of FORBIDDEN) {
      if (pattern.test(source)) out.push(diagnostic(path, message));
    }
    if (/from\s+["']node:/.test(source)) {
      out.push(diagnostic(path, "Node built-ins are not available in anonymous server code."));
    }
  }
  return out;
}

type Extracted = {
  name: string;
  schema: Record<string, unknown>;
  auth: { requireSignIn: boolean };
  endpoints: Record<string, { method: string; path: string; readOnly?: boolean }>;
  queries: string[];
  mutations: string[];
  actions: string[];
};

/** Execute the server entry in QuickJS and read the capsule definition back. */
async function extractDefinition(files: FileMap, sandbox: Sandbox): Promise<Extracted> {
  const inlined = inlineModules("server/index.ts", files, { stubBare: { "lakebed/server": "__lakebedServer" } });
  const probe = `{ ${LAKEBED_SERVER_STUB}\n${inlined} }\n` + `
globalThis.__out = "";
globalThis.__result = undefined;
globalThis.__err = undefined;
globalThis.__done = false;
globalThis.__done = true;
globalThis.__result = JSON.stringify({
  name: (globalThis.__entryDefault && globalThis.__entryDefault.name) || "Lakebed Capsule",
  schema: (globalThis.__entryDefault && globalThis.__entryDefault.schema) || {},
  auth: (globalThis.__entryDefault && globalThis.__entryDefault.auth) || { requireSignIn: false },
  endpoints: Object.fromEntries(Object.entries((globalThis.__entryDefault && globalThis.__entryDefault.endpoints) || {}).map(([k, e]) => [k, {
    method: e.method, path: e.path, ...(e.readOnly !== undefined ? { readOnly: e.readOnly } : {}),
  }])),
  queries: Object.keys((globalThis.__entryDefault && globalThis.__entryDefault.queries) || {}),
  mutations: Object.keys((globalThis.__entryDefault && globalThis.__entryDefault.mutations) || {}),
  actions: Object.keys((globalThis.__entryDefault && globalThis.__entryDefault.actions) || {}),
});`;
  const raw = await sandbox.runRaw(probe, "extract.ts");
  if (!raw.ok || raw.error) throw new Error(`${raw.error?.name ?? "Error"}: ${raw.error?.message ?? "unknown"}`);
  return JSON.parse(String(raw.result));
}

const FIELD_KINDS = new Set(["boolean", "id", "number", "string", "userId"]);
const METADATA_FIELDS = new Set(["id", "createdAt", "updatedAt"]);
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function serializeSchema(schema: Record<string, unknown>): { schema: Record<string, unknown>; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const clean: Record<string, unknown> = {};
  for (const [tableName, tableValue] of Object.entries(schema ?? {})) {
    const table = tableValue as Record<string, unknown>;
    if (!table || table.kind !== "table" || typeof table.fields !== "object") {
      diagnostics.push(diagnostic("server/index.ts", `Anonymous deploys only support Lakebed table() schema entries. Check schema.${tableName}.`));
      continue;
    }
    if (!NAME.test(tableName)) {
      diagnostics.push(diagnostic("server/index.ts", `Table name "${tableName}" must start with a letter.`));
      continue;
    }
    const fields: Record<string, unknown> = {};
    for (const [fieldName, fieldValue] of Object.entries((table.fields ?? {}) as Record<string, unknown>)) {
      const field = (fieldValue ?? {}) as Record<string, unknown>;
      if (!field || !FIELD_KINDS.has(field.kind as string)) {
        diagnostics.push(diagnostic("server/index.ts", `${tableName}.${fieldName} is not a Lakebed field. Declare it with string(), boolean(), number(), id(), or userId().`));
        continue;
      }
      if (METADATA_FIELDS.has(fieldName)) {
        diagnostics.push(diagnostic("server/index.ts", `Field name "${fieldName}" is reserved for Lakebed metadata.`));
        continue;
      }
      if (field.kind === "userId" && field.refTable !== undefined) {
        diagnostics.push(diagnostic("server/index.ts", `${tableName}.${fieldName} is a userId() field with a refTable. Drop the reference, or use id("<table>").`));
        continue;
      }
      if (typeof field.defaultValue === "function") {
        diagnostics.push(diagnostic("server/index.ts", `${tableName}.${fieldName} has a function default, which anonymous deploys cannot run.`));
        continue;
      }
      if (typeof field.defaultValue === "number" && !Number.isFinite(field.defaultValue)) {
        diagnostics.push(diagnostic("server/index.ts", `${tableName}.${fieldName} default must be finite.`));
        continue;
      }
      fields[fieldName] = {
        ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
        kind: field.kind,
        ...(field.optionalValue === true ? { optional: true } : {}),
        ...(field.refTable ? { refTable: field.refTable } : {}),
      };
    }
    const indexes: { fields: string[]; name: string }[] = [];
    const rawIndexes = (table as { indexes?: unknown }).indexes;
    if (rawIndexes !== undefined && !Array.isArray(rawIndexes)) {
      diagnostics.push(diagnostic("server/index.ts", `schema.${tableName}.indexes must be an array.`));
    }
    const seen = new Set<string>();
    for (const index of Array.isArray(rawIndexes) ? rawIndexes : []) {
      const ix = index as { name?: unknown; fields?: unknown };
      const ok =
        ix && typeof ix === "object" && typeof ix.name === "string" && Array.isArray(ix.fields) &&
        ix.fields.length > 0 &&
        (ix.fields as unknown[]).every((f) => typeof f === "string" && (f in fields || METADATA_FIELDS.has(f)));
      if (!ok) {
        diagnostics.push(diagnostic("server/index.ts", `An index on schema.${tableName} is not usable. Each index needs a name and at least one declared field.`));
        continue;
      }
      if (seen.has(ix.name as string)) {
        diagnostics.push(diagnostic("server/index.ts", `Index name ${ix.name} is declared twice on ${tableName}.`));
        continue;
      }
      seen.add(ix.name as string);
      indexes.push({ fields: [...(ix.fields as string[])], name: ix.name as string });
    }
    clean[tableName] = { kind: "table", fields, indexes };
  }
  for (const [tableName, tableValue] of Object.entries(clean)) {
    const t = tableValue as { fields: Record<string, { kind: string; refTable?: string }> };
    for (const [fieldName, field] of Object.entries(t.fields)) {
      if (field.kind === "id" && field.refTable && !clean[field.refTable]) {
        diagnostics.push(diagnostic("server/index.ts", `ID field ${tableName}.${fieldName} points at table ${field.refTable}, which this schema does not declare.`));
      }
    }
  }
  return { schema: clean, diagnostics };
}

const ENDPOINT_METHOD = /^[A-Z0-9!#$%&'*+.^_`|~-]+$/;
function isReservedEndpointPath(path: string): boolean {
  return (
    path === "/" || path === "/index.html" || path === "/client.js" || path === "/auth/callback" ||
    path.startsWith("/auth/") || path === "/__lakebed" || path.startsWith("/__lakebed/") ||
    path === "/__span" || path.startsWith("/__span/")
  );
}

function serializeEndpoints(endpoints: Extracted["endpoints"]): { endpoints: Record<string, unknown>; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const clean: Record<string, unknown> = {};
  const seen = new Map<string, string>();
  for (const [name, e] of Object.entries(endpoints ?? {})) {
    const dPath = `server.index.endpoints.${name}`;
    const method = String(e.method ?? "").toUpperCase();
    const path = String(e.path ?? "");
    if (!ENDPOINT_METHOD.test(method)) {
      diagnostics.push(diagnostic(dPath, `Endpoint method is not an HTTP method. Use an uppercase name like GET or POST.`));
      continue;
    }
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("?") || path.includes("#")) {
      diagnostics.push(diagnostic(dPath, `Endpoint path is not usable. Write an absolute app path like /webhooks/stripe.`));
      continue;
    }
    if (isReservedEndpointPath(path)) {
      diagnostics.push(diagnostic(dPath, `Endpoint path is reserved by Lakebed. Use an app path such as /api/events.`));
      continue;
    }
    if (e.readOnly !== undefined && typeof e.readOnly !== "boolean") {
      diagnostics.push(diagnostic(dPath, `Endpoint readOnly must be true or false.`));
      continue;
    }
    const key = `${method} ${path}`;
    if (seen.has(key)) {
      diagnostics.push(diagnostic("server/index.ts", `Endpoints ${name} and ${seen.get(key)} both serve ${key}.`));
      continue;
    }
    seen.set(key, name);
    clean[name] = { method, op: "source", path, ...(typeof e.readOnly === "boolean" ? { readOnly: e.readOnly } : {}) };
  }
  return { endpoints: clean, diagnostics };
}

/** Pin browser externals to esm.sh URLs: browsers resolve absolute URLs natively. */
const PREACT_BASE = "https://esm.sh/preact@10.28.0";
// Deep build URL so the app and lakebed/client share one preact instance
// (two copies break hooks state). ?deps pins the client's transitive preact.
const PREACT_PIN = `${PREACT_BASE}/es2022/preact.mjs`;
const LAKEBED_CLIENT_PIN = "https://esm.sh/lakebed@0.0.39/dist/client.js?deps=preact@10.28.0";

function shimSpec(spec: string): string | null {
  if (spec === "preact") return PREACT_PIN;
  if (spec.startsWith("preact/")) return `${PREACT_BASE}/${spec.slice("preact/".length)}`;
  if (spec === "lakebed/client") return LAKEBED_CLIENT_PIN;
  // lakebed/server stays bare: the platform provides it to server bundles.
  return null;
}

function rewriteBareImports(js: string): string {
  return js.replace(
    /(^|[;}])(\s*import\s+[^;]+?\s+from\s+)["']([^"']+)["'];?/gm,
    (_m, pre: string, head: string, spec: string) => {
      if (spec.startsWith(".")) return _m;
      const target = shimSpec(spec);
      return target ? `${pre}${head}"${target}";` : _m;
    },
  );
}

/** Bundle one entry to ESM text: inline relative files, keep bare imports. */
export function bundleEntry(
  entry: string,
  files: FileMap,
  opts: { jsx?: boolean; shims?: boolean; bareMap?: Record<string, string> } = {},
): string {
  const ordered = orderFiles(entry, files, opts.bareMap ?? {});
  const chunks: string[] = [];
  for (const path of ordered) {
    const source = files[path] ?? "";
    let js: string;
    try {
      const out = transform(source, {
        transforms: ["typescript",
      ...(opts.jsx || path.endsWith(".tsx") || path.endsWith(".jsx") ? (["jsx"] as const) : [])],
        // No ES downleveling: see stripTypeScript in capsule.ts.
        disableESTransforms: true,
        jsxPragma: "h",
        jsxFragmentPragma: "Fragment",
      });
      js = out.code;
    } catch (e: any) {
      throw new Error(`${path}: does not parse: ${e?.message ?? e}`);
    }
    const isEntry = path === entry;
    js = rewriteImports(js, { bareMap: opts.bareMap });
    if (opts.shims) js = rewriteBareImports(js);
    if (!isEntry) {
      js = js.replace(/^\s*export\s+default\s+([^;]+);?/m, "/* default export dropped: non-entry */");
      js = js.replace(/^\s*export\s+(?=(?:const|let|var|function|class|async function)\b)/gm, "");
      js = js.replace(/^\s*export\s*\{[^}]*\};?/gm, "");
    }
    chunks.push(`// ${path}\n${js}`);
  }
  return chunks.join("\n");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

async function sha256hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Hash format is `sha256:<hex>` everywhere in the lakebed artifact protocol.
  return `sha256:${hex}`;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Pinned lakebed/server runtime vendored into server bundles (node:-clean). */
const VENDOR_BASE = "https://cdn.jsdelivr.net/npm/lakebed@0.0.39/dist";
const VENDOR_FILES: { path: string; url: string; sha256: string }[] = [
  {
    path: "__vendor/lakebed/server.js",
    url: `${VENDOR_BASE}/server.js`,
    sha256: "09faf5649aec73ae706a0e6d7b65a61c3c494f20fd11f2104e74b3e586eabcd8",
  },
  {
    path: "__vendor/lakebed/database/query.js",
    url: `${VENDOR_BASE}/database/query.js`,
    sha256: "f11d3eddff17477d05fe8b4de55c4d570f025c7c0b8115c0a73f952921cf6a1b",
  },
  {
    path: "__vendor/lakebed/database/schema.js",
    url: `${VENDOR_BASE}/database/schema.js`,
    sha256: "cae38e65f125a8f00256ef98ed1201d7bbe98b156a0a493edd0cc86eb7293b75",
  },
];
const VENDOR_BARE_MAP: Record<string, string> = { "lakebed/server": "__vendor/lakebed/server.js" };

async function fetchText(url: string, runFetch: FetchFn): Promise<string> {
  const res = await runFetch(url);
  if (!res.ok) throw new Error(`vendor fetch failed (${res.status}): ${url}`);
  return res.text();
}

async function sha256bare(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data) as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fetch the pinned runtime and verify hashes (supply-chain pin). */
async function fetchVendor(runFetch: FetchFn): Promise<FileMap> {
  const out: FileMap = {};
  for (const v of VENDOR_FILES) {
    const text = await fetchText(v.url, runFetch);
    const hash = await sha256bare(text);
    if (hash !== v.sha256) {
      throw new Error(`vendor hash mismatch for ${v.url}: got ${hash}, want ${v.sha256}. Refusing to bundle.`);
    }
    out[v.path] = text;
  }
  return out;
}
const CLIENT_ENTRY_WRAPPER = (appImport: string) =>
  `import { Fragment, h, render } from "preact";\nimport { ErrorBoundary } from "lakebed/client";\nimport { App } from "${appImport}";\n\nrender(h(ErrorBoundary, {}, h(App, {})), document.getElementById("app"));`;

export type ArtifactInput = { artifact: Record<string, unknown>; clientBundle: string };

/** Assemble the deploy envelope without posting it (tested without network). */
export async function buildDeployEnvelope(
  files: FileMap,
  sandbox: Sandbox,
  opts: { fetch?: FetchFn; vendor?: FileMap } = {},
): Promise<ArtifactInput> {
  const problems = lintCapsule(files);
  if (problems.length) throw new Error(problems.join("\n"));
  const denied = deployLint(files);
  if (denied.length) throw new Error(denied.map((d) => `${d.file}: ${d.message}`).join("\n"));

  const def = await extractDefinition(files, sandbox);
  const serSchema = serializeSchema(def.schema);
  const serEndpoints = serializeEndpoints(def.endpoints);
  const diagnostics = [...serSchema.diagnostics, ...serEndpoints.diagnostics];
  if (def.auth && typeof def.auth.requireSignIn !== "boolean" && def.auth.requireSignIn !== undefined) {
    diagnostics.push(diagnostic("app.auth.requireSignIn", "requireSignIn must be a boolean."));
  }
  if (diagnostics.length) throw new Error(diagnostics.map((d) => `${d.file}: ${d.message}`).join("\n"));

  const runFetch: FetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  const vendor = opts.vendor ?? (await fetchVendor(runFetch));
  const serverFiles: FileMap = { ...vendor, ...files };
  const serverBundle = bundleEntry("server/index.ts", serverFiles, { bareMap: VENDOR_BARE_MAP });
  const serverBytes = new TextEncoder().encode(serverBundle);

  // Client entry imports the app relatively; inline from a virtual entry.
  // Browser externals are rewritten to pinned esm.sh URLs.
  const withEntry: FileMap = { ...files, "__lakebed/client-entry.tsx": CLIENT_ENTRY_WRAPPER("../client/index") };
  const clientBundle = bundleEntry("__lakebed/client-entry.tsx", withEntry, { jsx: true, shims: true });
  const clientBytes = new TextEncoder().encode(clientBundle);

  const sourceFiles = Object.keys(files)
    .filter((p) => p !== "lakebed.json" && p !== ".env.lakebed.server" && !p.startsWith("__lakebed/"))
    .sort();
  const manifest = await Promise.all(
    sourceFiles.map(async (path) => {
      const bytes = new TextEncoder().encode(files[path]);
      return { bytes: bytes.byteLength, hash: await sha256hex(bytes), path };
    }),
  );
  const schemaHash = await sha256hex(stableStringify(serSchema.schema));
  const serverHash = await sha256hex(serverBytes);
  const clientHash = await sha256hex(clientBytes);

  const handlerMap = (names: string[]) => Object.fromEntries(names.map((n) => [n, { op: "source" }]));
  const artifact: Record<string, unknown> = {
    database: { apiVersion: DATABASE_API_VERSION, indexCodecVersion: INDEX_CODEC_VERSION, schemaHash },
    name: def.name || "Lakebed Capsule",
    client: { bundleHash: clientHash, bytes: clientBytes.byteLength, entry: "/client.js" },
    createdWith: { compiler: "0.1.0", lakebed: LAKEBED_VERSION },
    format: ARTIFACT_FORMAT,
    limits: { ...ANONYMOUS_LIMITS },
    server: {
      actions: handlerMap(def.actions),
      auth: { requireSignIn: def.auth.requireSignIn === true },
      endpoints: serEndpoints.endpoints,
      helpers: {},
      imports: ["lakebed/server"],
      mutations: handlerMap(def.mutations),
      queries: handlerMap(def.queries),
      schema: serSchema.schema,
      source: {
        bytes: serverBytes.byteLength,
        bundle: toBase64(serverBytes),
        bundleHash: serverHash,
        entry: "/server.mjs",
      },
    },
    source: { files: manifest, snapshotHash: await sha256hex(stableStringify(manifest)) },
    deployTarget: "anonymous-source",
  };
  return { artifact, clientBundle: toBase64(clientBytes) };
}

/**
 * Deploy the capsule. Anonymous when no token is set (unclaimed deploys
 * expire); owned when `token` (LAKEBED_TOKEN) is given.
 */
export async function deployCapsule(
  files: FileMap,
  sandbox: Sandbox,
  opts: { api?: string; token?: string; fetch?: FetchFn; vendor?: FileMap } = {},
): Promise<DeployResult> {
  let envelope: ArtifactInput;
  try {
    envelope = await buildDeployEnvelope(files, sandbox, { fetch: opts.fetch, vendor: opts.vendor });
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) };
  }
  const api = (opts.api ?? LAKEBED_API).replace(/\/+$/, "");
  const route = opts.token ? "/v1/deploys" : "/v1/anonymous-deploys";
  const runFetch: FetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  let res: Response;
  try {
    res = await runFetch(`${api}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify({
        artifact: envelope.artifact,
        clientBundle: envelope.clientBundle,
        clientVersion: LAKEBED_VERSION,
      }),
    });
  } catch (e: any) {
    return { ok: false, message: `deploy request failed: ${e?.message ?? e}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, message: `deploy rejected (${res.status}): ${text.slice(0, 2000)}` };
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    return { ok: false, message: "deploy returned a non-JSON response" };
  }
  if (!body?.deployId || !body?.url) {
    return { ok: false, message: `deploy response missing deployId/url: ${JSON.stringify(body).slice(0, 500)}` };
  }
  return {
    ok: true,
    url: body.url,
    deployId: body.deployId,
    expiresAt: body.expiresAt,
    claimed: body.claimed === true,
  };
}
