#!/usr/bin/env node
/**
 * Syntax-check the inline client script in the served page.
 *
 * The UI lives in a template literal in src/index.ts, so a stray backtick or a
 * `\"` escape silently breaks the emitted JavaScript: the page renders its
 * static HTML, the script never runs, and the only symptom is a dead UI with no
 * error anywhere. Both happened during development. This catches it.
 *
 * Extracts the script from the live dev server, so it checks what is actually
 * shipped rather than a copy.
 */

import { writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:8900/";

// Bound the fetch: a wedged dev server can accept TCP and never answer, which
// otherwise hangs this script forever with no output (seen with a stale
// `wrangler dev` holding the port). Fail fast and say how to start one.
let html;
try {
  html = await fetch(url, { signal: AbortSignal.timeout(15_000) }).then((r) => {
    if (!r.ok) throw new Error(`${url} returned ${r.status}`);
    return r.text();
  });
} catch (e) {
  if (e instanceof DOMException && e.name === "TimeoutError") {
    console.error(`timed out waiting for ${url} — is a dev server running there? (try: npx wrangler dev --port 8900)`);
  } else {
    console.error(`could not fetch ${url}: ${e.message} — start a dev server first (npx wrangler dev --port 8900)`);
  }
  process.exit(1);
}

const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (blocks.length === 0) {
  console.error("no inline <script> block found in the served page");
  process.exit(1);
}
const script = blocks.at(-1);

const dir = mkdtempSync(join(tmpdir(), "inline-js-"));
const file = join(dir, "app.js");
writeFileSync(file, script);

try {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  console.log(`inline script OK (${script.length} chars, ${blocks.length} block(s))`);
} catch (e) {
  console.error("inline script has a syntax error:\n");
  console.error(e.stderr?.toString() || e.message);
  process.exit(1);
}