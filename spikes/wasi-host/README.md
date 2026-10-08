# WASM host spike

Answers one question: **can a `wasm32-wasip1` module run inside a Cloudflare
Worker?**

Yes. This directory is the evidence and the harness.

**The shim has moved.** `wasi-shim.mjs` became `src/wasi-shim.ts`, because the
real compiler needs it in production, not just in a spike. The two files had
already diverged — the spike's version hardcoded five WASI imports and the module
imports twenty-three, which is a link error at instantiate time, not a graceful
degradation. `tsrust.mjs` now imports the production shim so the evidence and the
app cannot drift apart.

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

That five-import figure is the *probe*, a stand-in module. The real compiler
needs twenty-three; see below.

## What the module actually needs

A Rust `wasm32-wasip1` binary imports a small set of WASI functions through std:

| Import | Why |
| --- | --- |
| `fd_write` | stdout, fd 1 |
| `proc_exit` | Go panic reporting |
| `clock_time_get` | `SystemTime::now` |
| `environ_get` | std init |
| `environ_sizes_get` | std init |

`src/wasi-shim.ts` implements all of them, and builds the import object from
`WebAssembly.Module.imports(mod)` rather than hardcoding names — anything
unimplemented becomes `ENOSYS`. A missing import would otherwise be a link error
thrown from `WebAssembly.instantiate`.

Two of those five need care on Workers specifically:

- **`clock_time_get` must not use `Date.now()`.** Workers freezes it to the time
  of the last I/O so code cannot measure its own runtime. ts-rust's own note on
  its reference host explains the consequence: tsc leaves out a timing row of
  zero.
- **`fd_write` must handle fd 2.** Rust's panic hook prints there, along with
  every `unported: <name> <count>` line. Those counters are how you tell a
  complete port from one that silently skipped a check on your input, so dropping
  stderr throws away the only evidence.

## The part that matters for ts-rust

`crates/ts_wasm` does **not** use WASI file syscalls. Its filesystem is injected by the host:

```rust
#[link(wasm_import_module = "ts_host")]
unsafe extern "C" {
    fn fs(op: u32, ptr: *const u8, len: usize) -> i32;
    fn fs_take(ptr: *mut u8);
}
```

So there is no `path_open` and no `fd_read`. `MemoryFs` in `src/wasi-shim.ts`
implements the eight
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

`tsrust.mjs` implements the `ts_rust.wasm` ABI and type-checks a project with two deliberate
type errors. It needs the module, which **nothing publishes** — no npm package, no release asset,
and `ts_rust.wasm` is gitignored upstream.

`src/ts_rust.wasm` is the built module, and this directory reaches it through a
symlink so there is one copy in the repository. Build it as described in
[`../../docs/ts-rust-integration.md`](../../docs/ts-rust-integration.md), then
link it in — the symlink itself is gitignored, so a fresh checkout needs this
by hand:

```sh
cd spikes/wasi-host
ln -s ../../src/ts_rust.wasm ts_rust.wasm
npx wrangler dev -c wrangler.tsrust.jsonc
```

`GET /` reports the module's real import surface. `GET /typecheck` runs tsc over an in-memory
project and returns the diagnostics.

The real import list, measured:

```
ts_host.fs_take, ts_host.fs,
wasi_snapshot_preview1.random_get, environ_get, environ_sizes_get,
  clock_time_get, fd_close, fd_fdstat_get, fd_filestat_get,
  fd_filestat_set_times, fd_prestat_get, fd_prestat_dir_name, fd_read,
  fd_readdir, fd_write, path_create_directory, path_filestat_get,
  path_open, path_readlink, path_remove_directory, path_unlink_file,
  proc_exit, sched_yield
```

Twenty-three. `fs`/`fs_take` are the pair that matters — they provide the
compiler's filesystem, the injected host interface described above — while
`clock_time_get` supplies tsc timing and `fd_write` carries panic and
`unported` output. The `path_*` and `fd_read`/`fd_readdir` group is dead
weight: it is there because Rust's std imports it, not because the compiler
calls it.

Upstream ships only `linux-x64` and `darwin-arm64` binaries, so on any other architecture —
including `aarch64` — a from-source build is the only route.

## What is still unproven

- **Instance reuse.** `crates/ts_wasm/src/lib.rs` says the port keeps one program per process
  (`core::set_prog`), so *"the host makes a new instance for each."* Measured at ~2 ms,
  against a ~70 ms check — so it costs almost nothing, but it is still per-run.
- **Memory.** `crates/ts_wasm/build.rs` sets `-zstack-size=33554432`: a 32 MiB
  shadow stack as the first region of every instance, before any user code is
  read. Measured peak is 68.6 MiB, which does not fit alongside the 64 MiB
  QuickJS cap in a 128 MiB isolate. See the integration doc.

## Files

| File | Role |
| --- | --- |
| `../../src/wasi-shim.ts` | The WASI functions, the `ts_host` filesystem, `MemoryFs` |
| `probe.mjs` | Runs the stand-in module. Proves the mechanism, builds in seconds |
| `tsrust.mjs` | The real `ts_rust.wasm` ABI and a type-check harness |
| `rust/` | Source for the stand-in module |
| `build.sh` | Builds it to `build/wasmprobe.wasm` |

See [`../../docs/ts-rust-integration.md`](../../docs/ts-rust-integration.md) for
how this slots into the app.