/**
 * Check the wasm type checker against `fixtures/expected.json`.
 *
 *     npm run typecheck:parity          # starts wrangler dev itself
 *     npm run typecheck:parity -- --url http://localhost:8787
 *
 * `fixtures/expected.json` is generated from the *native* `tsc-rs` binary
 * (`scripts/gen-fixtures.mjs`). This script drives the same fixtures through
 * the `ts_rust.wasm` module running in a real Worker and asserts the two agree.
 *
 * That comparison is the whole point. `ts_rust.wasm` and `tsc-rs` are the same
 * compiler, so any difference is either a bug in this project's host shim (path
 * mapping, position conversion, the generated tsconfig) or a genuine
 * divergence in the port. A green run means the Worker reports what the real
 * compiler reports, which is the claim the integration rests on.
 *
 * Exit status is non-zero if any case disagrees.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** Where the parity Worker listens. */
const DEFAULT_URL = "http://localhost:8788";

const argv = process.argv.slice(2);
const urlFlag = argv.indexOf("--url");
const url = urlFlag !== -1 ? argv[urlFlag + 1] : process.env.PARITY_URL ?? DEFAULT_URL;

const expected = JSON.parse(readFileSync(join(root, "fixtures/expected.json"), "utf8"));

/** Run one case through the Worker. */
async function check(name) {
  const res = await fetch(`${url}/typecheck`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: expected[name].source }),
  });
  if (!res.ok) throw new Error(`${name}: worker returned ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(`${name}: worker failed: ${body.error ?? "unknown"}`);
  return body;
}

/**
 * Reduce a diagnostic to what both backends can be compared on: the code, the
 * one-based position, and the message text.
 *
 * Text is compared after collapsing whitespace because tsc wraps long messages
 * differently between the text reporter (stdout, width-dependent) and the JSON
 * reporter, and a wrapping difference is not a fidelity difference.
 */
const key = (d) => `${d.code}|${d.line}|${d.column}|${d.text.replace(/\s+/g, " ").trim()}`;

let failures = 0;

for (const [name, fixture] of Object.entries(expected)) {
  let body;
  try {
    body = await check(name);
  } catch (e) {
    console.log(`✗ ${name.padEnd(18)} ${e.message}`);
    failures++;
    continue;
  }

  // A compiler failure is not a mismatch to be explained away; it is a failure
  // of the thing under test.
  if (body.failure) {
    console.log(`✗ ${name.padEnd(18)} compiler failure: ${body.failure.name}: ${body.failure.message}`);
    if (body.failure.stderr) console.log(`  stderr: ${body.failure.stderr.slice(0, 400)}`);
    failures++;
    continue;
  }

  const want = fixture.diagnostics.filter((d) => d.code != null).map(key);
  const got = (body.diagnostics ?? []).map(key);

  if (want.length === got.length && want.every((k, i) => k === got[i])) {
    console.log(`✓ ${name.padEnd(18)} ${want.length ? want.map((k) => "TS" + k.split("|")[0]).join(", ") : "clean"}`);
    continue;
  }

  failures++;
  console.log(`✗ ${name.padEnd(18)} ${want.length} expected, ${got.length} reported`);
  for (const k of want) if (!got.includes(k)) console.log(`  missing: ${k}`);
  for (const k of got) if (!want.includes(k)) console.log(`  extra:   ${k}`);
}

console.log(
  failures
    ? `\n${failures} of ${Object.keys(expected).length} cases disagree with the native compiler`
    : `\nall ${Object.keys(expected).length} cases match the native compiler`,
);
process.exit(failures ? 1 : 0);