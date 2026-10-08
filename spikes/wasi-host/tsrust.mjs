/**
 * Type-check real TypeScript inside a Cloudflare Worker, using the WASM build
 * of `pingdotgg/ts-rust` (a Rust port of Microsoft's native tsc).
 *
 * Requires `ts_rust.wasm`, which nothing publishes. Build it from source:
 *
 *   git clone --depth 1 https://github.com/pingdotgg/ts-rust
 *   rustup target add wasm32-wasip1 && brew install binaryen
 *   scripts/wasm/build.sh          # writes npm/wasm/ts_rust.wasm
 *   cp npm/wasm/ts_rust.wasm <this directory>/ts_rust.wasm
 *
 * The ABI below comes from `crates/ts_wasm/src/lib.rs`:
 *
 *   ts_input(len) -> ptr     host writes the request here
 *   ts_run() -> i32          runs it, returns the exit status
 *   ts_output() -> ptr       address of the reply
 *   ts_output_len() -> usize length of the reply
 *
 * The request is NUL-separated UTF-8: cwd, flags as a decimal number, then the
 * tsc arguments. With FLAG_DIAGNOSTICS_JSON set, the reply is a JSON array of
 * diagnostics instead of being empty.
 *
 * One instance runs one request, because the port keeps a single program per
 * process. Instantiate per run.
 */

import mod from "./ts_rust.wasm";
import { instantiate, MemoryFs } from "./wasi-shim.mjs";

const FLAG_DIAGNOSTICS_JSON = 1;

/**
 * Run tsc over an in-memory project.
 *
 * @param {Record<string,string>} files absolute path -> source text
 * @param {string[]} args tsc arguments, e.g. ["--noEmit", "-p", "/app"]
 */
export async function typecheck(files, args, { cwd = "/app" } = {}) {
  const fs = new MemoryFs(files);
  const { instance, stdout } = await instantiate(mod, fs);

  const request = [cwd, String(FLAG_DIAGNOSTICS_JSON), ...args].join("\0");
  const bytes = new TextEncoder().encode(request);

  const inputPtr = instance.exports.ts_input(bytes.length);
  new Uint8Array(instance.exports.memory.buffer, inputPtr, bytes.length).set(bytes);

  const exitCode = instance.exports.ts_run();

  // Memory can grow during the run, so re-read the buffer rather than caching it.
  const len = instance.exports.ts_output_len();
  const reply =
    len > 0
      ? new TextDecoder().decode(
          new Uint8Array(instance.exports.memory.buffer, instance.exports.ts_output(), len),
        )
      : "";

  let diagnostics = [];
  try {
    diagnostics = reply ? JSON.parse(reply) : [];
  } catch {
    diagnostics = [{ text: reply }];
  }

  return {
    exitCode,
    diagnostics,
    stdout: stdout.join(""),
    // Anything tsc emitted (the .js files) comes back through the filesystem.
    files: Object.fromEntries([...fs.files].map(([k, v]) => [k, new TextDecoder().decode(v)])),
  };
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const out = { module: "ts_rust.wasm" };
    try {
      out.moduleIsCompiledModule = mod instanceof WebAssembly.Module;
      out.imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
      out.exports = WebAssembly.Module.exports(mod).map((e) => e.name);

      if (url.pathname === "/") {
        return new Response(JSON.stringify(out, null, 2), {
          headers: { "content-type": "application/json" },
        });
      }

      // The exact case the current prototype misses: two type errors that
      // sucrase transpiles without complaint.
      const result = await typecheck(
        {
          "/app/tsconfig.json": JSON.stringify({
            compilerOptions: { strict: true, noEmit: true },
          }),
          "/app/index.ts": [
            "interface User { name: string; age: number }",
            'const u: User = { name: "ada", age: "forty" };',
            "const missing = u.emai;",
            "export { u, missing };",
          ].join("\n"),
        },
        ["-p", "/app"],
      );

      out.exitCode = result.exitCode;
      out.diagnostics = result.diagnostics.map((d) => ({
        code: d.code,
        category: d.category,
        text: d.text,
        file: d.fileName,
        line: d.start?.line,
      }));
      out.caughtTypeErrors = result.diagnostics.length;
      out.ok = true;
    } catch (e) {
      out.ok = false;
      out.error = e?.message ?? String(e);
    }
    return new Response(JSON.stringify(out, null, 2), {
      headers: { "content-type": "application/json" },
    });
  },
};