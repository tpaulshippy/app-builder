/**
 * Probe harness: proves a `wasm32-wasip1` module runs in a Cloudflare Worker.
 *
 * This is the stand-in for `ts_rust.wasm` — a 61 KB module compiled from
 * `rust/src/lib.rs` that writes to stdout and exports a function, built to
 * exercise the same imports a real Rust `wasip1` binary pulls in. It runs
 * without needing the 1.3M-line compiler to be built first.
 *
 * For the real compiler see `tsrust.mjs`.
 */

import mod from "./build/wasmprobe.wasm";
import { instantiate } from "./wasi-shim.mjs";

export default {
  async fetch() {
    const out = { module: "wasmprobe (stand-in for ts_rust.wasm)" };
    try {
      out.moduleIsCompiledModule = mod instanceof WebAssembly.Module;
      out.imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
      out.exports = WebAssembly.Module.exports(mod).map((e) => e.name);

      const { instance, stdout } = await instantiate(mod, undefined);

      out.ts_output_len = instance.exports.ts_output_len();
      out.ts_run_21 = instance.exports.ts_run(21);
      out.ts_run_5 = instance.exports.ts_run(5);
      out.stdout = stdout;
      out.ok = instance.exports.ts_run(21) === 42;
    } catch (e) {
      out.ok = false;
      out.error = e?.message ?? String(e);
    }
    return new Response(JSON.stringify(out, null, 2), {
      headers: { "content-type": "application/json" },
    });
  },
};