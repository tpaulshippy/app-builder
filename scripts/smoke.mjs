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
 * Cases, in order:
 *
 * 1. the default program, which must type-check clean *and* render
 * 2. a type error, which must be rejected with TS2322 and never executed
 * 3. the same program with the error fixed, to prove the gate releases
 * 4. a program that type-checks but throws, so the runtime path is still live
 * 5. `state` persisting across runs, since the DO is meant to hold one context
 *
 * A cookie jar keeps every case in one session, which is what makes 3 and 5
 * meaningful.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const argv = process.argv.slice(2);
const urlFlag = argv.indexOf("--url");
const url = urlFlag !== -1 ? argv[urlFlag + 1] : process.env.APP_URL ?? "http://localhost:8787";

const defaultCode = readFileSync(join(root, "src/default-code.ts"), "utf8").match(/DEFAULT_CODE = `([\s\S]*?)\n`;/)[1]
  // Undo the template-literal escaping so this is the program a user sees.
  .replace(/\\`/g, "`")
  .replace(/\\\$\{/g, "${");

/** One session's cookie, so runs share a Durable Object. */
let cookie = "";

async function run(source) {
  const res = await fetch(`${url}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ code: source }),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res.json();
}

let failures = 0;

/** Assert with a message, so a failure says what was expected and what happened. */
function check(label, ok, detail) {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    console.log(`✗ ${label}${detail ? `\n    ${detail}` : ""}`);
    failures++;
  }
}

// 1. The default program: clean, and it renders.
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

// 2. A type error: rejected, with a tsc-shaped diagnostic, and never executed.
const bad = `interface User { name: string; age: number }
const u: User = { name: "ada", age: "forty" };
html\`<p>\${u.age}</p>\`;
`;
const two = await run(bad);
check("type error is rejected", two.ok === false, `ok=${two.ok}`);
check("rejection reports no rendered html", (two.html ?? "") === "", JSON.stringify(two.html));
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

// 3. Fixing the error must release the gate.
const fixed = bad.replace('age: "forty"', "age: 40");
const three = await run(fixed);
check(
  "fixing the type error releases the gate and the program runs",
  three.ok === true && three.html.includes("<p>40</p>"),
  `ok=${three.ok} html=${JSON.stringify((three.html || "").slice(0, 120))}` +
    (three.diagnostics ? ` diagnostics=${JSON.stringify(three.diagnostics)}` : ""),
);

// 4. Type checks clean but throws: the runtime path must still work.
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

// 5. `state` survives across runs in the same Durable Object, which is the
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

// 6. console capture still works through the whole gated path.
const logging = `console.log("hello", { debug: true });
html\`<p>ok</p>\`;
`;
const six = await run(logging);
check(
  "console.log is captured",
  six.ok && (six.logs ?? []).some((l) => l.includes('"debug":true')),
  JSON.stringify(six.logs),
);

console.log(
  failures ? `\n${failures} of 6 end-to-end checks failed` : "\nall 6 end-to-end checks passed",
);
process.exit(failures ? 1 : 0);