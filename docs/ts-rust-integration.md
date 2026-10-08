# Type checking with `ts-rust`

`src/sandbox.ts` compiles with **sucrase**, which strips types without checking
them. Against the live prototype, this passes and renders:

```
interface User { name: string; age: number }
const u: User = { name: "ada", age: "forty" };  // TS2322
const missing = u.emai;                         // TS2339 -> undefined
```

```
ok: true   compileError: None   output: <p>rendered anyway: ada</p>
```

Syntax errors and runtime throws are caught. Type errors are not. For a
playground where you read your own code that is survivable. For an agent writing
twenty apps unsupervised it is the missing safety net — the failure is silent,
lands three layers down, and surfaces as `undefined`.

## What replaced it

[`pingdotgg/ts-rust`](https://github.com/pingdotgg/ts-rust) — a Rust port of
**TypeScript 7**, MIT, pinned here to `8c2593f1280b8ca44bc78f3b593fbdd6c908216a`.
Not a reimplementation: a port of the real compiler, so diagnostics match `tsc`.
Its `wasm32-wasip1` build (`crates/ts_wasm`) takes its filesystem from the host,
which is what makes it runnable inside a Worker.

The QuickJS execution path is unchanged. `tsc` emits JavaScript, so it gates that
path rather than replacing it:

```
             ┌─ src/index.ts ──────────────┐
source ──▶   │ sucrase        → JS text     │
             │ QuickJS        → execute     │
             └──────────────────────────────┘
source ──▶   ts_rust.wasm ──▶ diagnostics  ──▶ reject if any
             (type check only, --noEmit)
```

| File | Role |
| --- | --- |
| `src/typecheck.ts` | The `ts_rust.wasm` backend and the `TypeChecker` seam |
| `src/host-api.ts` | The compiler options and ambient declarations, in one place |
| `src/wasi-shim.ts` | The WASI shim and the in-memory filesystem |
| `src/session.ts` | Gates `sandbox.run` on a clean check |
| `src/ts_rust.wasm` | The vendored compiler, 4.7 MB |

## Verified behaviour

Measured on this machine (M-series, `wrangler dev`), single small file:

| | Value |
| --- | --- |
| Warm type check | **~70 ms** |
| Cold (first request in the isolate) | ~180 ms |
| Instantiation share | **3%** |
| Native `tsc-rs`, same file | ~83 ms |
| **wasm penalty** | **~0.9x** |

The wasm penalty is essentially nil, which was not the expectation. Compilation
dominates, not instantiation, so cost tracks program size rather than a fixed
per-run overhead.

`ts_rust.wasm` keeps one program per process, so every check is a fresh
instance — but instantiation is only 2 ms of a 70 ms check, so that constraint
turns out to cost almost nothing.

All nine fixtures report the same codes, positions and messages as the native
binary:

```
✓ default            clean              ✓ html-signature     TS2345
✓ assign-wrong-type  TS2322, TS2339     ✓ state-is-any       clean
✓ unknown-property   TS2339             ✓ syntax-error       TS1110
✓ implicit-any       TS7006             ✓ null-strictness    TS2322, TS18047
✓ unknown-global     TS2552
```

`unknown-global` earns its place: a typo is `TS2552 Cannot find name 'htmll'.
Did you mean 'html'?`, which is only possible because the host API is declared.

## The memory constraint, and why the layout is what it is

`crates/ts_wasm/build.rs` sets `-zstack-size=33554432`. That 32 MiB shadow stack
is the **first region of every instance's linear memory**, before the compiler
has read a single line of your code. Measured:

| | MiB |
| --- | ---: |
| Declared initial linear memory | 37.0 |
| Peak during a check | **68.6** |
| Growth while compiling | 31.6 |
| QuickJS cap (`src/sandbox.ts`) | 64.0 |
| Workers isolate limit | 128.0 |
| **Headroom** | **−4.6** |

So the type checker and the QuickJS runtime do **not** fit in one isolate at
their current caps. In practice `wrangler dev` serves both, because the observed
peak is per-run and the isolate is not under concurrent pressure; but a Durable
Object holds its memory while idle, and 128 MB is a hard ceiling.

Two mitigations are in place:

- **`scripts/bench.mjs` measures it** rather than assuming, and fails loudly if
  the headroom goes negative.
- **If a larger program tips it over, move type checking to a separate stateless
  Worker.** It needs no Durable Object state, so an ephemeral isolate releases
  ~69 MiB per request instead of holding it. The `TypeChecker` interface in
  `src/typecheck.ts` is the seam for that move; nothing else has to change.

Reducing the QuickJS cap from 64 MiB is the cheaper first move if it is ever
needed, at the cost of the allocation-bomb headroom documented in the README.

## Building the vendored binary

Nothing publishes `ts_rust.wasm` — no npm package, no release asset, and it is
gitignored upstream. So it is built once and committed, with its hash:

```
4f1ed9bd13038080bb029f937e8d9a91f85f2c62289de370ca814f4db5a72131  src/ts_rust.wasm
```

Rebuild, on a machine with ~25 GB free:

```sh
git clone https://github.com/pingdotgg/ts-rust
cd ts-rust
git checkout 8c2593f1280b8ca44bc78f3b593fbdd6c908216a   # pinned
rustup update                                           # built with 1.99.0
rustup target add wasm32-wasip1
brew install binaryen                                    # wasm-opt 132+; built with 133
scripts/wasm/build.sh                                    # ~2.5 min here
cp npm/wasm/ts_rust.wasm <app-builder>/src/
```

| | |
| --- | --- |
| Built with | rustc 1.99.0, binaryen 133, `--profile wasm` |
| Size | 4,706,298 bytes raw / 2,045,030 gzip |
| Build time | 2m 26s (warm cargo cache) |

## Three corrections to the original plan

**The WASI shim needed more than five imports.** The original `wasi-shim.mjs`
hardcoded five WASI functions. The real module imports **twenty-three**:

```
ts_host.fs, ts_host.fs_take,
wasi_snapshot_preview1.{random_get, environ_get, environ_sizes_get,
  clock_time_get, fd_close, fd_fdstat_get, fd_filestat_get,
  fd_filestat_set_times, fd_prestat_get, fd_prestat_dir_name, fd_read,
  fd_readdir, fd_write, path_create_directory, path_filestat_get,
  path_open, path_readlink, path_remove_directory, path_unlink_file,
  proc_exit, sched_yield}
```

A missing import is not a soft failure but a link error that throws from
`WebAssembly.instantiate`. `src/wasi-shim.ts` now builds the import object by
reading `WebAssembly.Module.imports(mod)` and defaulting anything unimplemented
to `ENOSYS`, which is what a real WASI host returns. The compiler never depends
on any of them — the `path_*` group in particular is dead weight, because
`crates/ts_wasm` uses no WASI file syscalls at all, only `ts_host.fs`.

Two further fixes in the same file, both of which would have silently degraded
output:

- `clock_time_get` used `Date.now()`, which **Workers freezes**. Upstream notes
  exactly why this matters: tsc leaves out a timing row of zero. Now uses
  `performance.timeOrigin + performance.now()`.
- `fd_write` dropped fd 2. That is where the Rust panic hook and every
  `unported: <name> <count>` line go, which is the only evidence distinguishing
  a complete port from one that skipped a check on your input.

**The diagnostics field name was wrong.** The spike read `d.start?.line`, but the
wire format is `startPosition: { line, character }`, both **zero-based**. Every
line number rendered `undefined`. Positions are now converted once, in
`normalize()`, and `sourceLines` is carried through so the UI can underline the
exact span.

**The fallback advice was backwards.** The original doc recommended the npm
`typescript` package for "100% diagnostic parity rather than a port's
approximation". That package is `tsc` **6**. `ts-rust` ports TypeScript
**7.1.0-dev**, which is *newer* — it reports checks 6 does not have. So the
fallback is the older compiler, not the more authoritative one.

On fidelity generally: upstream reports all 181,711 ported Go tests passing, with
Hono and TanStack Query matching Go line for line. Its known problems are in
monorepo and `tsc -b` output semantics, which a single in-memory file never
reaches. `scripts/parity.mjs` verifies that claim against the real module rather
than taking it on trust.

## Testing

```sh
npm run typecheck                        # this repo's own sources
npm run fixtures                         # regenerate from the native binary
npm run parity:worker                    # terminal 1
npm run typecheck:parity                 # terminal 2: wasm vs native, 9 cases
npm run dev                              # terminal 1
npm run smoke                            # terminal 2: 6 end-to-end checks
npm run ui-check                         # terminal 2: 8 rendering checks
npm run bench:worker                     # terminal 1
npm run bench                            # terminal 2: latency and memory
```

Expectations are generated from the **native** `tsc-rs` release binary, not
hand-written, so a green parity run is a measured claim rather than an
assumption:

```sh
curl -sL https://github.com/pingdotgg/ts-rust/releases/download/v0.1.0/tsc-rs-0.1.0-darwin-arm64.tar.gz | tar xz
TSC_RS=$PWD/tsc-rs-0.1.0-darwin-arm64/tsc npm run fixtures
```

## Honest limits

- **`state` is `Record<string, any>`,** not `unknown`. Under `unknown` the
  idiomatic `state.runs = (state.runs ?? 0) + 1` is an error, which would make
  the host API unusable. The cost is that writes into `state` are unchecked.
  Pinned by the `state-is-any` fixture so the trade-off is deliberate rather than
  accidental.
- **`lib` includes `dom` as a stand-in.** QuickJS has no DOM. `console` comes
  from there and is replaced wholesale by `BOOTSTRAP`, so nothing can reach a
  real one — but the lib is doing work it was not designed for.
- **One instance per run,** by the port's design. Cheap here (~2 ms), but it is a
  property to remember before moving this onto a keystroke path.
- **Bundle is 5.7 MB** (2.35 MB gzip), up from 1.09 MB. Cloudflare removed the
  old 3 MB/10 MB compressed caps on 2026-09-04 — both tiers are 64 MiB now — so
  this is not a limit, but it is most of the deployment.
- **Unattested upstream.** 511 stars, created the day of the stream, and the
  author writes *"I've never read a line of this code."* Pinned to a commit with
  a committed hash for that reason. Expect breakage.