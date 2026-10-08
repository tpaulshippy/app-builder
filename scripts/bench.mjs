/**
 * Measure a type check in a real Worker: latency and memory.
 *
 *     npm run bench:worker        # terminal 1
 *     npm run bench               # terminal 2
 *
 * These are the two numbers that decide whether this is shippable, and the
 * phase plan flagged both as things to measure rather than assume.
 *
 * **Latency.** `ts_rust.wasm` keeps one program per process, so every run pays
 * a fresh instantiation of a 4.7 MB module. The split between instantiate and
 * compile matters: if instantiation dominates, the cost is per-run overhead the
 * design already accepts; if compile dominates, a bigger program gets worse
 * fast.
 *
 * **Memory.** `crates/ts_wasm/build.rs` sets `-zstack-size=33554432`, so a
 * 32 MiB shadow stack is the first region of every instance's linear memory.
 * Workers allows 128 MB per isolate and `src/sandbox.ts` caps QuickJS at
 * 64 MiB in the same Durable Object, so the two coexist in one budget. That is
 * the constraint most likely to bite, and the phase plan called it the top
 * risk.
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
    : process.env.BENCH_URL ?? "http://localhost:8788";

/** Timed runs after the cold one. */
const RUNS = 5;

/**
 * Native baseline for the same fixture, in milliseconds. Historical: measured
 * on the author's M-series machine with `scripts/gen-fixtures.mjs`'s binary,
 * not on this machine, so the wasm-penalty ratio below is only comparable
 * across runs on the same hardware.
 *
 * Set TSC_RS to the tsc-rs binary to measure the baseline here instead: the
 * script times the same source through the native compiler in a temp project
 * built from the same `projectFiles`, and the ratio becomes a same-machine
 * comparison.
 */
const HISTORICAL_NATIVE_MS = 83;

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { projectFiles, APP_DIR } from "../src/host-api.ts";

function measureNative(source) {
  const tsc = process.env.TSC_RS;
  if (!tsc) return null;
  const dir = mkdtempSync(join(tmpdir(), "app-builder-bench-"));
  try {
    for (const [path, text] of Object.entries(projectFiles(source))) {
      writeFileSync(join(dir, path.slice(APP_DIR.length + 1)), text);
    }
    const times = [];
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now();
      try {
        execFileSync(tsc, ["-p", dir], { stdio: ["ignore", "ignore", "ignore"] });
      } catch {
        // tsc exits non-zero when it has diagnostics; that is the normal path.
      }
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fixtures = JSON.parse(readFileSync(join(root, "fixtures/expected.json"), "utf8"));

async function timeOne(source) {
  const startedAt = performance.now();
  const res = await fetch(`${url}/typecheck`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  });
  const roundTrip = performance.now() - startedAt;
  const body = await res.json();

  if (!body.ok) throw new Error(`worker failed: ${body.error}`);
  // A compiler failure is the thing under test failing, so surface it rather
  // than reporting a fast time for a broken run.
  if (body.failure) {
    throw new Error(`compiler failure: ${body.failure.name}: ${body.failure.message}${body.failure.stderr ? `\n${body.failure.stderr}` : ""}`);
  }
  return { roundTrip, ...body };
}

const source = fixtures["assign-wrong-type"].source;
const cold = await timeOne(source);

const warm = [];
for (let i = 0; i < RUNS; i++) warm.push(await timeOne(source));

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const warmTotal = warm.map((r) => r.durationMs);
const warmInstantiate = warm.map((r) => r.timing.instantiateMs);
const warmCompile = warm.map((r) => r.timing.compileMs);

const MIB = 1024 * 1024;
const peakMiB = cold.timing.peakPages * 65536 / MIB;
const initialMiB = cold.timing.memoryPages * 65536 / MIB;

console.log(`\nsource: fixtures/assign-wrong-type (${source.length} bytes), ${cold.diagnostics.length} diagnostics\n`);

console.log("--- latency ---");
console.log(`cold (first request in the isolate): ${cold.durationMs}ms`);
console.log(`  instantiate: ${cold.timing.instantiateMs}ms   compile: ${cold.timing.compileMs}ms`);
console.log(`warm: median ${median(warmTotal).toFixed(0)}ms   mean ${mean(warmTotal).toFixed(0)}ms   min ${Math.min(...warmTotal)}ms`);
console.log(`  instantiate: median ${median(warmInstantiate).toFixed(0)}ms   compile: median ${median(warmCompile).toFixed(0)}ms`);
const nativeMs = measureNative(source);
if (nativeMs == null) {
  console.log(`native tsc-rs, same file: ~${HISTORICAL_NATIVE_MS}ms (historical M-series reference, not this machine)`);
  console.log(`wasm penalty: ~${(mean(warmTotal) / HISTORICAL_NATIVE_MS).toFixed(1)}x (against that reference)`);
  console.log(`(set TSC_RS to measure the native baseline on this machine instead)`);
} else {
  console.log(`native tsc-rs CLI, same file, same machine: ~${nativeMs.toFixed(0)}ms (median of ${RUNS}, end to end incl. process spawn)`);
  console.log(`wasm penalty: ~${(mean(warmTotal) / nativeMs).toFixed(1)}x (in-worker check vs CLI spawn; startup dominates the native side)`);
}

const overheadShare = median(warmInstantiate) / median(warmTotal);
console.log(
  `instantiation is ${(overheadShare * 100).toFixed(0)}% of each type check — ` +
    (overheadShare > 0.8
      ? "dominated by instantiation, which is the cost of one-program-per-process"
      : "dominated by compilation, so cost grows with program size"),
);

console.log("\n--- memory, one ts_rust.wasm instance ---");
console.log(`declared initial linear memory: ${initialMiB.toFixed(1)} MiB (${cold.timing.memoryPages} pages)`);
console.log(`peak during the run:            ${peakMiB.toFixed(1)} MiB (${cold.timing.peakPages} pages)`);
console.log(`growth while compiling:         ${(peakMiB - initialMiB).toFixed(1)} MiB`);
console.log("\nbudget in the Durable Object:");
console.log(`  ts_rust.wasm peak:  ${peakMiB.toFixed(1)} MiB`);
console.log(`  QuickJS cap:        64.0 MiB (src/sandbox.ts)`);
console.log(`  Workers isolate:   128.0 MiB`);
const headroom = 128 - peakMiB - 64;
console.log(`  headroom:           ${headroom.toFixed(1)} MiB`);

console.log(
  headroom > 8
    ? "\nComfortable. The compiler and the QuickJS runtime coexist without eviction."
    : headroom > 0
      ? "\nTight. Larger programs could push the isolate over 128 MB and trigger eviction.\n" +
        "If that happens, move type checking to a separate stateless Worker: it needs no\n" +
        "Durable Object state, so an ephemeral isolate releases the memory per request."
      : "\nOver budget. These two do not fit in one isolate; type checking must move to a\n" +
        "separate Worker.",
);

console.log(
  "\nThe Durable Object instantiates per run and drops the previous instance, so this\n" +
    "is peak-per-run, not accumulated growth.",
);

// An over-budget memory check that exits 0 reads as a pass to every caller.
// Fail loudly so CI cannot treat it as green.
if (headroom <= 0) process.exit(1);