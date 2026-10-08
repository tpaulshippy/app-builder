/**
 * End-to-end smoke test of the real app: `POST /api/run` against `wrangler dev`.
 *
 *     npm run dev            # terminal 1
 *     npm run smoke          # terminal 2
 *
 * `scripts/parity.mjs` proves the type checker matches the native compiler, and
 * `scripts/bench.mjs` measures it. Neither exercises the part that matters most:
 * that the Durable Object gates `sandbox.run`, that a rejected program produces
 * tsc-shaped diagnostics in the API response, and that a clean program still
 * renders. This walks the whole path.
 *
 * Scenarios, in order:
 *
 * 1. the default program, which must type-check clean *and* render
 * 2. a type error, which must be rejected with TS2322 and never executed
 * 3. the same program with the error fixed, to prove the gate releases
 * 4. a program that type-checks but throws, so the runtime path is still live
 * 5. `state` persisting across runs, since the DO is meant to hold one context
 * 6. console capture through the whole gated path
 * 7. concurrent runs in one session, to prove the per-session type-check queue
 *
 * A cookie jar keeps every case in one session, which is what makes 3, 5
 * and 7 meaningful.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const argv = process.argv.slice(2);
const urlFlag = argv.indexOf("--url");
const url =
  urlFlag !== -1 && argv[urlFlag + 1]
    ? argv[urlFlag + 1]
    : process.env.APP_URL ?? "http://localhost:8787";

const defaultCode = readFileSync(join(root, "src/default-code.ts"), "utf8").match(/DEFAULT_CODE = `([\s\S]*?)\n`;/)[1]
  // Undo the template-literal escaping so this is the program a user sees.
  .replace(/\\`/g, "`")
  .replace(/\\\$\{/g, "${");

/** One session's cookie, so runs share a Durable Object. */
let cookie = "";

/**
 * One gated run. Transport failures (connection refused, non-JSON body, HTTP
 * error status) come back as a failed result rather than throwing, so one
 * downed case does not abort the remaining scenarios with a raw stack trace.
 */
async function run(source) {
  try {
    const res = await fetch(`${url}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ code: source }),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    if (!res.ok) {
      return { ok: false, html: "", logs: [], diagnostics: [], transportError: `HTTP ${res.status}` };
    }
    return await res.json();
  } catch (e) {
    return { ok: false, html: "", logs: [], diagnostics: [], transportError: e?.message ?? String(e) };
  }
}

let failures = 0;
let failedScenarios = 0;
let currentScenarioFailed = false;

/** Assert with a message, so a failure says what was expected and what happened. */
function check(label, ok, detail) {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    console.log(`✗ ${label}${detail ? `\n    ${detail}` : ""}`);
    failures++;
    currentScenarioFailed = true;
  }
}

/**
 * Fail distinctly when the server never answered. Without this, a dead server
 * makes "rejected" assertions pass for the wrong reason: the transport-failure
 * shape is `{ok:false, html:""}`, which is exactly what a rejection looks
 * like, and the scenario would print green ticks for a check that never ran.
 */
function mustReach(label, res) {
  check(`${label}: server responded`, !res.transportError, res.transportError);
  return !res.transportError;
}

/** Mark the boundary between scenarios, so the summary counts scenarios. */
function scenario(label) {
  if (currentScenarioFailed) failedScenarios++;
  currentScenarioFailed = false;
  console.log(`\n--- ${label} ---`);
}

function endScenarios() {
  if (currentScenarioFailed) failedScenarios++;
  currentScenarioFailed = false;
}

scenario("1. default program");
const one = await run(defaultCode);
check(
  "default program is accepted and renders",
  one.ok && one.html.includes("<h1>Run 1</h1>"),
  `ok=${one.ok} diagnostics=${one.diagnostics?.length} html=${JSON.stringify((one.html || "").slice(0, 120))}` +
    (one.diagnostics ? ` first=${JSON.stringify(one.diagnostics[0])}` : "") +
    (one.typecheckError ? ` typecheckError=${JSON.stringify(one.typecheckError)}` : ""),
);
check(
  "default program reports no diagnostics",
  (one.diagnostics ?? []).length === 0,
  JSON.stringify(one.diagnostics),
);
console.log(`    typecheck ${one.typecheckMs}ms, run ${one.durationMs}ms`);

scenario("2. type error is rejected");
const bad = `interface User { name: string; age: number }
const u: User = { name: "ada", age: "forty" };
html\`<p>\${u.age}</p>\`;
`;
const two = await run(bad);
mustReach("typecheck endpoint", two);
check(
  "type error is rejected",
  two.ok === false && !two.transportError,
  `ok=${two.ok} transportError=${two.transportError}`,
);
check(
  "rejection reports no rendered html",
  (two.html ?? "") === "" && !two.transportError,
  JSON.stringify(two.html),
);
const d = two.diagnostics?.[0];
check(
  "diagnostic is tsc-shaped: TS2322 with file, line and column",
  d?.code === 2322 && d?.file === "index.ts" && d?.line === 2 && typeof d?.column === "number" && d?.column > 0,
  JSON.stringify(d),
);
check(
  "diagnostic carries the source line for display",
  (d?.sourceLines ?? []).some((l) => l.text.includes('age: "forty"')),
  JSON.stringify(d?.sourceLines),
);
console.log(`    ${d ? `index.ts(${d.line},${d.column}) error TS${d.code}: ${d.text}` : "(no diagnostic)"}`);

scenario("3. fixed program is released");
const fixed = bad.replace('age: "forty"', "age: 40");
const three = await run(fixed);
check(
  "fixing the type error releases the gate and the program runs",
  three.ok === true && three.html.includes("<p>40</p>"),
  `ok=${three.ok} html=${JSON.stringify((three.html || "").slice(0, 120))}` +
    (three.diagnostics ? ` diagnostics=${JSON.stringify(three.diagnostics)}` : ""),
);

scenario("4. runtime throw after a clean check");
const throwing = `const n: number = 1;
html\`<p>before</p>\`;
throw new Error("boom from user code");
`;
const four = await run(throwing);
check(
  "a program that type-checks but throws reports a runtime error",
  four.ok === false && four.error?.message === "boom from user code" && (four.diagnostics ?? []).length === 0,
  JSON.stringify({ ok: four.ok, error: four.error, diagnostics: four.diagnostics }),
);

scenario("5. state persists across runs");
// `state` survives across runs in the same Durable Object, which is the
// property the prototype exists to demonstrate, and which the type checker
// must not have broken by getting in the way.
const counter = `const n: number = (state.n ?? 0) + 1;
state.n = n;
html\`<p>\${n}</p>\`;
`;
const runs = [];
for (let i = 0; i < 3; i++) runs.push(await run(counter));
check(
  "state increments 1 -> 2 -> 3 across runs in one session",
  runs.every((r) => r.ok) && runs.map((r) => (r.html || "").match(/<p>(\d+)<\/p>/)?.[1]).join(",") === "1,2,3",
  runs.map((r) => (r.ok ? (r.html || "").match(/<p>(\d+)<\/p>/)?.[1] : `err:${JSON.stringify(r.error ?? r.diagnostics)}`)).join(","),
);

scenario("6. console capture");
// console capture still works through the whole gated path.
const logging = `console.log("hello", { debug: true });
html\`<p>ok</p>\`;
`;
const six = await run(logging);
check(
  "console.log is captured",
  six.ok && (six.logs ?? []).some((l) => l.includes('"debug":true')),
  JSON.stringify(six.logs),
);

scenario("7. concurrent runs in one session stay consistent");
// Type checks are serialized per session: two `ts_rust.wasm` instances peak at
// ~69 MiB each, which does not fit a 128 MiB isolate twice over, and the
// shared QuickJS globals are reset per run. Fired concurrently, N increments
// must still come back as exactly 1..N — no duplicates, no lost updates. The
// increments use their own key so the earlier sequential runs do not shift
// the numbering.
const burst = `const n: number = (state.burst ?? 0) + 1;
state.burst = n;
html\`<p>\${n}</p>\`;
`;
const CONCURRENT = 4;
const raced = await Promise.all(Array.from({ length: CONCURRENT }, () => run(burst)));
const seen = raced.map((r) => (r.html || "").match(/<p>(\d+)<\/p>/)?.[1]).sort();
check(
  `4 concurrent runs report 1,2,3,4 exactly once`,
  raced.every((r) => r.ok) && seen.join(",") === "1,2,3,4",
  raced
    .map((r) =>
      r.ok
        ? (r.html || "").match(/<p>(\d+)<\/p>/)?.[1]
        : `err:${JSON.stringify(r.transportError ?? r.error ?? r.diagnostics ?? r.typecheckError)}`,
    )
    .join(","),
);

endScenarios();

console.log(
  failures
    ? `\n${failures} failing assertion(s) across ${failedScenarios} of 7 scenarios`
    : "\nall 7 end-to-end scenarios passed",
);
process.exit(failures ? 1 : 0);