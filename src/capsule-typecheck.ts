/**
 * Capsule projects for the ts-rust type checker.
 *
 * `src/typecheck.ts` checks one file (`/app/index.ts`) against generated
 * globals. Capsules are multi-file projects that import `lakebed/*` and
 * `preact`, so this module builds the whole in-memory project: the capsule
 * files, a tsconfig, test globals, and a `node_modules` slice with the real
 * dependency declarations, fetched pinned from jsdelivr and cached for the
 * life of the isolate.
 *
 * TypeScript's own `lib.*.d.ts` is NOT fetched: ts-rust bundles its vendored
 * libs (see `skipLibCheck` in `src/host-api.ts`, same reasoning here).
 */

export type FileMap = Record<string, string>;
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const LAKEBED_VERSION = "0.0.39";
const PREACT_VERSION = "10.28.0";
const LAKEBED_CDN = `https://cdn.jsdelivr.net/npm/lakebed@${LAKEBED_VERSION}`;
const PREACT_CDN = `https://cdn.jsdelivr.net/npm/preact@${PREACT_VERSION}`;

/** Isolate-lifetime cache: versions are pinned, so entries never go stale. */
const fetchCache = new Map<string, string>();

/** Test hook: drop cached declarations between cases. Production never calls this. */
export function __clearDeclarationCache(): void {
  fetchCache.clear();
}

async function fetchText(url: string, runFetch: FetchFn): Promise<string> {
  const cached = fetchCache.get(url);
  if (cached !== undefined) return cached;
  const res = await runFetch(url);
  if (!res.ok) throw new Error(`type declaration fetch failed (${res.status}): ${url}`);
  const text = await res.text();
  fetchCache.set(url, text);
  return text;
}

type Seed = { url: string; dest: string };

/** Entry declarations every capsule project needs, before import closure. */
function seedFiles(): Seed[] {
  return [
    { url: `${LAKEBED_CDN}/dist/server.d.ts`, dest: "/app/node_modules/lakebed/dist/server.d.ts" },
    { url: `${LAKEBED_CDN}/dist/client.d.ts`, dest: "/app/node_modules/lakebed/dist/client.d.ts" },
    { url: `${LAKEBED_CDN}/package.json`, dest: "/app/node_modules/lakebed/package.json" },
    { url: `${PREACT_CDN}/src/index.d.ts`, dest: "/app/node_modules/preact/src/index.d.ts" },
    { url: `${PREACT_CDN}/hooks/src/index.d.ts`, dest: "/app/node_modules/preact/hooks/src/index.d.ts" },
    { url: `${PREACT_CDN}/jsx-runtime/src/index.d.ts`, dest: "/app/node_modules/preact/jsx-runtime/src/index.d.ts" },
    { url: `${PREACT_CDN}/package.json`, dest: "/app/node_modules/preact/package.json" },
  ];
}

/** Static import specifiers, including type-only ones (declarations need them all). */
function importSpecs(source: string): string[] {
  const specs: string[] = [];
  const re = /^\s*import\s+(?:type\s+)?(?:[^;]+?\s+from\s+)?["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    if (m[1] !== undefined) specs.push(m[1]);
  }
  return specs;
}

/**
 * Resolve one specifier to a project-absolute path, TS-style, or null when it
 * leaves the project (bare imports outside the vendored map are a lint error
 * upstream of here).
 */
function resolveToProject(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const parts: string[] = [];
  for (const seg of `${dir}/${spec}`.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const base = `/${parts.join("/")}`;
  const noJs = base.endsWith(".js") ? base.slice(0, -3) : base;
  // Prefer declarations; declaration files never execute. Existence is
  // confirmed by the fetch (404s are skipped by the caller).
  return `${noJs}.d.ts`;
}

/**
 * Fetch the `.d.ts` closure: seeds plus every relative declaration they
 * import, recursively. Returned as project-absolute path -> contents.
 */
export async function fetchDeclarations(runFetch: FetchFn): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const queue = seedFiles();
  const seen = new Set<string>();
  while (queue.length) {
    const { url, dest } = queue.pop() as Seed;
    if (seen.has(dest)) continue;
    seen.add(dest);
    let text: string;
    try {
      text = await fetchText(url, runFetch);
    } catch {
      // A missing declaration (e.g. an unlisted subpath) surfaces downstream
      // as TS2307 on the importing file, which names the real problem.
      continue;
    }
    out[dest] = text;
    for (const spec of importSpecs(text)) {
      if (!spec.startsWith(".")) continue;
      const resolved = resolveToProject(dest, spec);
      if (!resolved || seen.has(resolved)) continue;
      // Map the project path back to a CDN URL: same package, same layout.
      const urlPath = resolved
        .replace("/app/node_modules/lakebed/", `${LAKEBED_CDN}/`)
        .replace("/app/node_modules/preact/", `${PREACT_CDN}/`);
      if (urlPath === resolved) continue;
      queue.push({ url: urlPath, dest: resolved });
    }
  }
  return out;
}

const TEST_GLOBALS_DTS = `// Generated by src/capsule-typecheck.ts. Test-only globals for *.test.ts.

declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => unknown): void;
declare function expect(actual: unknown): {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toBeTruthy(): void;
  toBeNull(): void;
  toBeGreaterThan(expected: number): void;
};

/** The stub-database context tests run against; untyped on purpose. */
declare const __testCtx: any;
`;

const CAPSULE_TSCONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    types: [] as string[],
    lib: ["esnext"],
    skipLibCheck: true,
    target: "esnext",
    module: "esnext",
    moduleResolution: "bundler",
    jsx: "react-jsx",
    jsxImportSource: "preact",
  },
};

/**
 * Assemble the full in-memory project for `typecheckFiles`: capsule files
 * under `/app`, dependency declarations under `/app/node_modules`, test
 * globals, and the tsconfig `-p` points at.
 */
export async function buildCapsuleProject(files: FileMap, runFetch: FetchFn): Promise<Record<string, string>> {
  const project: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (path.startsWith("__lakebed/") || path === "lakebed.json" || path === ".env.lakebed.server") continue;
    project[`/app/${path}`] = content;
  }
  Object.assign(project, await fetchDeclarations(runFetch));
  project["/app/__test.d.ts"] = TEST_GLOBALS_DTS;
  project["/app/tsconfig.json"] = JSON.stringify(CAPSULE_TSCONFIG, null, 2);
  return project;
}
