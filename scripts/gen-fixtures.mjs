/**
 * Generate `fixtures/expected.json` from the native `tsc-rs` binary.
 *
 *     npx tsc-rs            # or: TSC_RS=/path/to/tsc node --experimental-strip-types scripts/gen-fixtures.mjs
 *
 * Expectations come from the real compiler rather than being written by hand,
 * so `scripts/parity.mjs` can treat the wasm build's output as a measured
 * claim instead of an assumption. The native binary and the wasm module are the
 * same compiler; the only thing under test is whether the wasm build agrees.
 *
 * Where the binary comes from: `ts-rust` publishes `linux-x64` and
 * `darwin-arm64` release tarballs, so this runs without a Rust toolchain or the
 * 25 GB wasm build. See `fixtures/README.md`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CASES } from "../fixtures/cases.ts";
import { projectFiles, APP_DIR } from "../src/host-api.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const TSC = process.env.TSC_RS ?? "tsc-rs";

/**
 * One diagnostic as `tsc` prints it:
 *
 *     index.ts(2,32): error TS2322: Type 'string' is not assignable to type 'number'.
 *
 * The position is one-based on both axes. tsc prints a multi-line code frame
 * instead of this when stdout is a terminal; the parity harness runs it
 * non-interactively, so we always get the single-line form.
 */
const DIAGNOSTIC_RE = /^(\S.*?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;

function parse(stdout) {
  const diagnostics = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const m = DIAGNOSTIC_RE.exec(line);
    if (!m) {
      // A global diagnostic (no file position) or a message we do not model.
      diagnostics.push({ file: null, line: null, column: null, category: "error", code: null, text: line });
      continue;
    }
    const [, file, ln, col, category, code, text] = m;
    diagnostics.push({
      file,
      line: Number(ln),
      column: Number(col),
      category,
      code: Number(code.slice(2)),
      text,
    });
  }
  return diagnostics;
}

/**
 * Run the native compiler over one case, in a throwaway directory populated
 * from `projectFiles` so the fixtures exercise the same generated project the
 * Worker builds.
 *
 * The files are written with the same layout they get in the wasm host, but
 * the project path passed on the command line is the temp directory rather
 * than `/app`. The native binary resolves its project against the real
 * filesystem; `/app` only exists inside the wasm module's `MemoryFs`. The
 * sources and compiler options are byte-identical, which is what the parity
 * claim rests on.
 */
function check(name, source) {
  const dir = mkdtempSync(join(tmpdir(), "app-builder-fixture-"));
  try {
    for (const [path, text] of Object.entries(projectFiles(source))) {
      writeFileSync(join(dir, path.slice(APP_DIR.length + 1)), text);
    }
    let stdout = "";
    let status = 0;
    try {
      stdout = execFileSync(TSC, ["-p", dir], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // tsc exits non-zero when it has diagnostics. That is the normal path.
      stdout = e.stdout ?? "";
      status = e.status ?? 1;
    }
    return { diagnostics: parse(stdout), status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `tsc-rs` is not on PATH by default; fail loudly rather than writing garbage. */
try {
  execFileSync(TSC, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
} catch {
  console.error(
    `error: \`${TSC}\` is not runnable.\n` +
      `Set TSC_RS to the tsc-rs binary, or download a release:\n` +
      `  https://github.com/pingdotgg/ts-rust/releases (v0.1.0, darwin-arm64 or linux-x64)`,
  );
  process.exit(1);
}

const out = {};
let failures = 0;

for (const testCase of CASES) {
  const { diagnostics } = check(testCase.name, testCase.source);
  out[testCase.name] = { about: testCase.about, source: testCase.source, diagnostics };

  const summary = diagnostics.length
    ? diagnostics.map((d) => (d.code ? `TS${d.code}` : d.text)).join(", ")
    : "clean";
  console.log(`${diagnostics.length ? "!" : " "} ${testCase.name.padEnd(18)} ${summary}`);

  // The default program is the one case that must be clean. If it is not, the
  // generated globals.d.ts has drifted from the host API and every new user
  // would meet a type error before they typed anything.
  if (testCase.name === "default" && diagnostics.length) {
    console.error("\nerror: the default program does not type-check.");
    failures++;
  }
}

const target = join(root, "fixtures/expected.json");
const previous = (() => {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
})();
const next = JSON.stringify(out, null, 2) + "\n";
writeFileSync(target, next);

if (previous === null) {
  console.log(`\nwrote ${target} (${CASES.length} cases)`);
} else if (previous === next) {
  console.log(`\n${target} is unchanged`);
} else {
  console.log(`\n${target} changed — commit it alongside any change to src/host-api.ts`);
}

process.exit(failures ? 1 : 0);