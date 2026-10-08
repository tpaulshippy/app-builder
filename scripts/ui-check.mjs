/**
 * Verify the diagnostics UI renders what the API returns.
 *
 *     npm run dev            # terminal 1
 *     npm run ui-check       # terminal 2
 *
 * The server side of a type error is covered by `scripts/smoke.mjs`. This
 * covers the client side: that the page's `renderDiagnostics` turns a real API
 * response into escaped, tsc-shaped HTML with the offending span underlined.
 *
 * It extracts the `<script>` the Worker serves and runs its helpers against a
 * live `/api/run` response, in a DOM stub. That keeps the assertion on the real
 * rendered string rather than on a reimplementation of the escaping, which is
 * where a bug would actually hide.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const argv = process.argv.slice(2);
const urlFlag = argv.indexOf("--url");
const url = urlFlag !== -1 ? argv[urlFlag + 1] : process.env.APP_URL ?? "http://localhost:8787";

const page = await (await fetch(`${url}/`)).text();

// The Worker inlines the client script as the last <script> block.
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts.length) {
  console.error("error: no inline <script> found on the page");
  process.exit(1);
}
const client = scripts[scripts.length - 1];

// Pull out just the helpers under test, so this does not need a full DOM or a
// live click handler.
const needed = ["const esc =", "const squiggle =", "function renderDiagnostic(", "function renderDiagnostics("];
for (const name of needed) {
  if (!client.includes(name)) {
    console.error(`error: ${name} is missing from the served script — did the page build?`);
    process.exit(1);
  }
}

const start = client.indexOf("const esc =");
const end = client.indexOf("runBtn.addEventListener");
const helpers = client.slice(start, end);

/** Get a real diagnostic from the running app rather than inventing one. */
const source = `interface User { name: string; age: number }
const u: User = { name: "ada", age: "forty" };
html\`<p>\${u.age}</p>\`;
`;
const apiRes = await fetch(`${url}/api/run`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: source }),
});
const api = await apiRes.json();

if (!api.diagnostics?.length) {
  console.error(`error: the API returned no diagnostics to render: ${JSON.stringify(api).slice(0, 300)}`);
  process.exit(1);
}

const render = new Function(`${helpers}\nreturn renderDiagnostics;`)();
const out = render(api.diagnostics);

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`✓ ${label}`);
  else {
    console.log(`✗ ${label}${detail ? `\n    ${detail}` : ""}`);
    failures++;
  }
};

const d = api.diagnostics[0];
check("summary counts the errors", /1 type error/.test(out), out.slice(0, 120));
check("renders the file and one-based position", out.includes(`${d.file}(${d.line},${d.column})`), out.slice(0, 200));
check("renders the diagnostic code", out.includes("TS" + d.code));
check("renders the message text", out.includes(d.text.replace(/&/g, "&amp;")), out.slice(0, 400));
check("renders the offending source line", (d.sourceLines ?? []).every((l) => !l.text || out.includes(l.text.trim())), JSON.stringify(d.sourceLines));
check("draws an underline for the span", /diag-squiggle">[^<]*~/.test(out), out.match(/diag-squiggle">([^<]*)</)?.[1]);
check("no raw angle brackets from user text leak into the markup", !/<(script|img|iframe)/i.test(out));

// The escaping is the security-relevant part: a diagnostic message quoting user
// code must not become markup.
const injected = render([
  {
    code: 2322,
    category: "error",
    text: 'Type \'<img src=x onerror=alert(1)>\' is not assignable',
    file: "index.ts",
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 5,
    sourceLines: [{ line: 1, text: "const x = <img src=x onerror=alert(1)>;" }],
    related: [],
  },
]);
check(
  "escapes angle brackets in diagnostic text",
  injected.includes("&lt;img") && !injected.includes("<img"),
  injected.slice(0, 300),
);

console.log(failures ? `\n${failures} of 8 UI checks failed` : "\nall 8 UI checks passed");
console.log("\n--- rendered markup ---\n" + out);
process.exit(failures ? 1 : 0);