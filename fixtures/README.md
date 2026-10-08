# Fixtures

Expected diagnostics for a set of programs, and the machinery that keeps them
honest.

## What is here

| File | Role |
| --- | --- |
| `cases.ts` | The programs, and what each one pins down |
| `expected.json` | The diagnostics the **native** `tsc-rs` binary produced |
| `../scripts/gen-fixtures.mjs` | Regenerates `expected.json` |
| `../scripts/parity.mjs` | Compares the **wasm** build against `expected.json` |

## Why the expectations come from the native binary

They are not hand-written. `gen-fixtures.mjs` runs the real `tsc-rs` release
binary over each case and records what it said; `parity.mjs` then drives the same
cases through `ts_rust.wasm` running in a Worker and asserts the two agree.

`ts_rust.wasm` and `tsc-rs` are the same compiler, so any difference is either a
bug in this project's host shim — path mapping, position conversion, the
generated tsconfig — or a real divergence in the port. A green run means the
Worker reports what the real compiler reports, which is the claim the whole
integration rests on. Hand-written expectations would have made that circular.

## Why there is a Worker at all

The comparison runs against real workerd rather than plain node so it exercises
the target runtime: `WebAssembly.compile` is blocked on Cloudflare Workers (it
works fine in node), and the host filesystem is a `MemoryFs` implemented in
`src/wasi-shim.ts`. So `scripts/parity-worker.mjs` exposes the *same*
`src/typecheck.ts` the app uses over HTTP, and `parity.mjs` drives that. It is
not a test double.

## Regenerating

```sh
curl -sL https://github.com/pingdotgg/ts-rust/releases/download/v0.1.0/tsc-rs-0.1.0-darwin-arm64.tar.gz | tar xz
TSC_RS=$PWD/tsc-rs-0.1.0-darwin-arm64/tsc npm run fixtures
```

Linux uses the `linux-x64` asset. Other architectures need the from-source build
in [`../docs/ts-rust-integration.md`](../docs/ts-rust-integration.md).

`gen-fixtures.mjs` reports whether `expected.json` changed. If it did, commit it
alongside whatever change to `src/host-api.ts` caused the change — a diff there
means the compiler's view of a user program moved.

## Running the comparison

```sh
npm run parity:worker      # terminal 1
npm run typecheck:parity   # terminal 2
```

## What the cases pin down

Most are regression guards for `src/host-api.ts`, not just examples:

| Case | Pins |
| --- | --- |
| `default` | The starting program type-checks clean. Breaks if the generated `globals.d.ts` stops matching the host API — which would give every new user a type error before they typed anything. |
| `implicit-any` | `strict: true`. Without it this parameter is implicitly `any` and nothing is reported. |
| `state-is-any` | The deliberate looseness of `state`. Under `unknown` this would error; it passing is the documented cost of `state.runs = (state.runs ?? 0) + 1`. |
| `html-signature` | `html`'s declared shape is a real contract, not `any`. |
| `unknown-global` | The host API is a closed set, so a typo gets `TS2552 ... Did you mean 'html'?`. |
| `syntax-error` | `tsc` and sucrase agree about what parses, so the two paths cannot disagree. |
| `assign-wrong-type`, `unknown-property`, `null-strictness` | The classes of error this integration exists to catch. |

## One deliberate divergence

`gen-fixtures.mjs` passes `-p <tempdir>` rather than `-p /app`. The native binary
resolves its project against the real filesystem, and `/app` exists only inside
the wasm module's `MemoryFs`. The sources and compiler options are byte-identical,
which is what the comparison rests on.