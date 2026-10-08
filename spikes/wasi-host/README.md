# WASM host spike

Answers one question: **can a `wasm32-wasip1` module run inside a Cloudflare Worker?**

Yes. This directory is the evidence and the reusable harness.

## Why it is not obvious

Workers blocks V8 code generation, which rules out the usual approach:

```
eval()                       ✗
new Function                 ✗
WebAssembly.compile          ✗   ← compiles bytes to a Module at runtime
WebAssembly.compileStreaming ✗
```

But `WebAssembly.instantiate()` with an **already-compiled** module is permitted. Importing a
`.wasm` file through the bundler hands you a `WebAssembly.Module`, so the compile step never runs
and the restriction does not apply. That is the only door in.

## Result

`probe.mjs` runs a real `wasm32-wasip1` module in `wrangler dev` against real workerd:

```
moduleIsCompiledModule: true
imports:  5, all wasi_snapshot_preview1
ts_run(21) -> 42
ts_run(5)  -> 10
stdout:    ["ts_run received 21\n", "ts_run received 5\n"]
ok:        true
```

## What the module actually needs

A Rust `wasm32-wasip1` binary imports exactly five WASI functions through std:

| Import | Why |
| --- | --- |
| `fd_write` | stdout, fd 1 |
| `proc_exit` | Go panic reporting |
| `clock_time_get` | `SystemTime::now` |
| `environ_get` | std init |
| `environ_sizes_get` | std init |

`wasi-shim.mjs` implements all five in about 90 lines. It is the whole WASI surface.

## The part that matters for ts-rust

`crates/ts_wasm` does **not** use WASI file syscalls. Its filesystem is injected by the host:

```rust
#[link(wasm_import_module = "ts_host")]
unsafe extern "C" {
    fn fs(op: u32, ptr: *const u8, len: usize) -> i32;
    fn fs_take(ptr: *mut u8);
}
```

So there is no `path_open` and no `fd_read`. `MemoryFs` in `wasi-shim.mjs` implements the eight
ops (`Read`, `Stat`, `ReadDir`, `Realpath`, `Write`, `Append`, `Remove`, `Chtimes`) over a `Map`,
which is enough to type-check a small project. That indirection is what makes the port usable
outside Node — a WASI-filesystem build would have been unusable on Workers.

The protocol is two steps: `fs` returns a length and stashes the bytes, `fs_take` copies them in.
`-1` means failure, `-2 - n` means an `n`-byte error message is waiting.

## Running the probe

```sh
cd spikes/wasi-host
./build.sh                              # needs cargo + the wasm32-wasip1 target
npx wrangler dev -c wrangler.probe.jsonc
```

## Running the real compiler

`tsrust.mjs` implements the actual `ts_rust.wasm` ABI and type-checks a project with two deliberate
type errors. It needs the module, which **nothing publishes** — no npm package, no release asset,
and `ts_rust.wasm` is gitignored upstream. Build it on a machine with roughly 25 GB free:

```sh
git clone --depth 1 https://github.com/pingdotgg/ts-rust
cd ts-rust
rustup target add wasm32-wasip1
brew install binaryen                      # or a binaryen 132+ release
WASM_PROFILE=release scripts/wasm/build.sh # writes npm/wasm/ts_rust.wasm, 4.2 MB
cp npm/wasm/ts_rust.wasm <app-builder>/spikes/wasi-host/
cd <app-builder>/spikes/wasi-host
npx wrangler dev -c wrangler.tsrust.jsonc
```

`GET /` reports the module's real import surface. `GET /typecheck` runs tsc over an in-memory
project and returns the diagnostics.

Upstream ships only `linux-x64` and `darwin-arm64` binaries, so on any other architecture —
including `aarch64` — a from-source build is the only route.

## What is still unproven

- **The real module's import list.** The probe shows five. The compiler will add `ts_host.fs` and
  `ts_host.fs_take` (which we supply, not shim) and may pull further std imports. Read them off
  `GET /` once built.
- **Instance reuse.** `crates/ts_wasm/src/lib.rs` says the port keeps one program per process
  (`core::set_prog`), so *"the host makes a new instance for each."* Every type-check therefore
  costs a fresh instantiation. Fine for an agent build loop, not on a request path.
- **Size and cold start.** 4.2 MB raw, 1.8 MB gzip. Instantiate lazily inside the Durable Object,
  the way `src/sandbox.ts` does for QuickJS, or it eats the 1-second Worker startup budget.

## Files

| File | Role |
| --- | --- |
| `wasi-shim.mjs` | The five WASI functions, the `ts_host` filesystem, `MemoryFs` |
| `probe.mjs` | Runs the stand-in module. Proves the mechanism, builds in seconds |
| `tsrust.mjs` | The real `ts_rust.wasm` ABI and a type-check harness |
| `rust/` | Source for the stand-in module |
| `build.sh` | Builds it to `build/wasmprobe.wasm` |

See `docs/ts-rust-integration.md` for how this slots into the app.