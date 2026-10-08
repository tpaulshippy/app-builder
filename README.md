# app-builder

An agent chat that writes TypeScript, **type-checks it with `tsc` and runs it inside a single
Cloudflare Worker isolate**, and shows you the result. Describe what you want; it edits `index.ts`,
builds, reads its own output, and iterates.

Live: **https://app-builder.pshippy-245.workers.dev**

```
you ─▶ space-bunny-free (opencode zen)
         │  tools: list_files read_file write_file build read_logs
         ▼
   Durable Object ──▶ QuickJS (WASM) ──▶ rendered output ──┐
   files · chat · one JS runtime      ◀── console + errors ──┘
```

This is the mechanism from Theo Browne's lakebed demo, small enough to read in one sitting.

## Layout

| File | Role |
| --- | --- |
| `src/agent.ts` | The agent loop: Zen API, five tools, streaming events |
| `src/session.ts` | One Durable Object per session — files, chat history, one QuickJS runtime, the type gate |
| `src/sandbox.ts` | Compile, execute in QuickJS, capture logs, enforce limits |
| `src/typecheck.ts` | `ts_rust.wasm`: `tsc` 7 as WebAssembly, the type gate |
| `src/wasi-shim.ts` | The WASI imports and the compiler's in-memory filesystem |
| `src/host-api.ts` | The compiler options and ambient declarations user programs get |
| `src/index.ts` | Routing and the chat UI |
| `spikes/wasi-host/` | Proof that a `wasm32-wasip1` module runs in a Worker |
| `docs/ts-rust-integration.md` | How `tsc` got wired in, and what it costs |

The agent loop runs in the Worker: it is almost entirely waiting on the API, and waiting on network
does not count toward CPU time. The QuickJS runtime lives in the Durable Object because that has to
survive between requests.

## The program API

```ts
interface Habit { name: string; log: boolean[] }

state.runs = (state.runs ?? 0) + 1;   // persists between builds, same isolate
console.log("built", state.runs);      // captured and shown to the agent
html`<h1>Run ${state.runs}</h1>`;      // the output channel
```

## Configuration

`OPENCODE_ZEN_KEY` is a Worker secret. Locally, put it in `.dev.vars` (gitignored).

```sh
npm install
npx wrangler secret put OPENCODE_ZEN_KEY
./deploy.sh
npm run check        # syntax-checks the inline UI script against the dev server
```

Programs are checked by `tsc` itself — the TypeScript 7 compiler, compiled to WebAssembly — before
anything runs. A wrong type is reported with its code, position and the offending line, and the
program is rejected. Roughly 70 ms.

## The problem

Cloudflare Workers blocks V8's code generation:

```
eval()                      ✗ blocked
new Function                ✗ blocked
WebAssembly.compile         ✗ blocked
WebAssembly.compileStreaming ✗ blocked
```

That is a Spectre mitigation. It closes the usual "transpile TypeScript, then `eval` it in the
same isolate" path, which is why most Worker setups deploy a new isolate per version instead.

## The workaround

The ban is on *V8's* codegen, not on running untrusted JavaScript. Workers explicitly permits
`WebAssembly.instantiate()` with a **pre-compiled** module — that is not string-to-native
compilation, it is just calling code that was compiled before deploy.

So ship two WebAssembly modules:

```
┌─ one V8 isolate ────────────────────────────────────┐
│                                                      │
│  ts_rust.wasm  (4.7 MB)   tsc 7, type checks         │
│       │  23 WASI imports, host-supplied filesystem    │
│       ▼                                              │
│  diagnostics ──▶ reject if any                       │
│                                                      │
│  quickjs.wasm  (492 KB, pre-compiled, instantiated)  │
│       │  has its own eval() that V8 never sees        │
│       ▼                                              │
│  sucrase  ── TypeScript ──▶ JavaScript text          │
│       │                                              │
│       ▼                                              │
│  QuickJS.evalCode(js)  ──▶ runs, mutates globals     │
│       ▲                                              │
│       └── swap the source, same runtime, same context│
└──────────────────────────────────────────────────────┘
```

Editing the app re-runs `evalCode` in the *same* runtime. No new isolate, no `wrangler deploy`,
no Worker Loader. Globals from the previous run are still there.

## Layout

| File | Role |
| --- | --- |
| `src/sandbox.ts` | The QuickJS harness: compile, execute, capture, guard |
| `src/session.ts` | One Durable Object per session, holding one QuickJS runtime |
| `src/typecheck.ts` | `tsc` in WebAssembly: the type gate |
| `src/wasi-shim.ts` | The WASI shim and the compiler's in-memory filesystem |
| `src/host-api.ts` | The compiler options and ambient declarations user programs get |
| `src/index.ts` | Worker routing, HTML UI |

Each session maps to a Durable Object, so the runtime and its context survive across requests
and across isolate restarts of the outer Worker.

## Program API

```ts
interface Visitor { name: string; visits: number }

state.runs = (state.runs ?? 0) + 1;          // persists across runs, same isolate

const visitors: Visitor[] = [{ name: "ada", visits: 3 }];
console.log("hello", { debug: true });      // captured and shown

html`<h1>Run ${state.runs}</h1>`;            // the output channel
```

- `html` — tagged template, **appends** to the output. This is the only output channel. A bare
  trailing expression is not: function bodies evaluate to `undefined` in strict mode, so
  completion values do not survive the wrapper.
- `state` — plain object, persists for the life of the session. Top-level `const` does not,
  because each run is wrapped in its own async IIFE.
- `console.log/warn/error` — captured, cleared per run.

## What works, and what does not

Verified in `wrangler dev` against real workerd:

| Behaviour | Result |
| --- | --- |
| **Type checking, with tsc's codes and positions** | ✅ ~70 ms, matches the native compiler on 9 fixtures |
| TypeScript (interfaces, enums, generics, annotations) | ✅ |
| `html` output, appending across calls | ✅ |
| `state` persistence across runs, same isolate | ✅ 1 → 2 → 3 |
| `await` on already-settled values | ✅ `(async () => { await Promise.resolve(41); return 42 })()` |
| `console.*` capture | ✅ |
| Runtime errors with real stack traces | ✅ |
| Runaway loop | ✅ stopped at ~2s, context survives |
| Allocation bomb | ✅ stopped at 64 MB, context survives |
| `await` on real I/O or a timer | ❌ reported as `Unsupported` |

The VM is synchronous — `@cf-wasm/quickjs` ships only a `RELEASE_SYNC` build, no Asyncify
variant. So `await` works only for values that settle immediately. Pending promises are detected
and reported rather than hanging.

## Three platform quirks that cost real debugging time

**1. `Date.now()` is frozen, so wall-clock timeouts cannot work.** The Workers security model
locks `Date.now()` to the time of the last I/O so code cannot measure its own runtime. An
interrupt handler is *host-side* JavaScript, so `Date.now() - startedAt > 2000` never becomes
true and a runaway loop kills the isolate. Fixed by counting interrupt polls instead —
deterministic, ~4,200 ticks/second measured, budgeted at 8,000 (~2s).

**2. The per-eval `shouldInterrupt` option is silently ignored.** `ctx.evalCode(code, file, {
shouldInterrupt })` does nothing in this binding. `rt.setInterruptHandler(fn)` works. Same for
`memoryLimitBytes` per eval — use `rt.setMemoryLimit(bytes)`.

**3. `ctx.dump()` returns `undefined` on a handle from `getPromiseState()`.** Even when the
promise is `fulfilled`, dumping `state.value` yields nothing. Reading a plain global works fine.
The harness therefore passes results back through globals (`__out`, `__err`, `__done`) rather
than through a settled promise.

## Deploy

**One-time prerequisite.** Every Workers deploy needs a `workers.dev` subdomain registered on the
account, *even when you attach a custom domain* — the API returns `10063` without one. No scoped
API token can create it: `POST /accounts/:id/workers/subdomain` answers `10405 "Method not allowed
for this authentication scheme"`. Open the Workers page once and it is created:

```
https://dash.cloudflare.com/<ACCOUNT_ID>/workers/onboarding
```

Then:

```sh
./deploy.sh
```

It reads `CLOUDFLARE_WORKER_API_TOKEN` from the environment or `~/shared_config`. The token needs
**Workers Scripts: Edit**. Wrangler creates the `AppSession` Durable Object namespace on first
deploy, so nothing needs setting up by hand.

Ctrl/Cmd+Enter re-runs from the browser.

## Testing

The repo's own sources, then the three layers of the type gate:

```sh
npm run typecheck                        # this repo
npm run parity:worker                    # terminal 1
npm run typecheck:parity                 # terminal 2 — wasm vs native tsc, 9 fixtures
npm run dev                              # terminal 1
npm run smoke                            # terminal 2 — 6 end-to-end checks
npm run ui-check                         # terminal 2 — 8 rendering checks
npm run bench                            # latency and memory, after bench:worker
```

Fixture expectations are generated from the native `tsc-rs` release binary, not
hand-written, so a green parity run is a measured claim. See
[`fixtures/README.md`](fixtures/README.md).

## Notes and limits

- **Type checking is real, and it costs ~70 ms.** `tsc` 7 compiled to WebAssembly,
  with the filesystem supplied by the host. Diagnostics match the native compiler
  on all nine fixtures. See [`docs/ts-rust-integration.md`](docs/ts-rust-integration.md)
  for the measurements and the three corrections to the original plan, and
  [`spikes/wasi-host/`](spikes/wasi-host/) for the proof that a `wasm32-wasip1`
  module runs here.
- **The compiler and the sandbox do not both fit in one isolate.** `ts_rust.wasm`
  reserves a 32 MiB shadow stack and peaks at 68.6 MiB; QuickJS is capped at
  64 MiB; the isolate limit is 128 MiB. It works today, but a bigger program tips
  it over, and the fix is a separate stateless Worker for the type check.
- **`state` is `Record<string, any>`,** not `unknown`, so `state.runs = (state.runs ?? 0) + 1`
  works. Writes into it are unchecked.
- **No npm imports.** App code runs against a small host API (`html`, `state`, `console`). A
  bundler plus a resolver would be the next layer.
- **Interpreted, so slow.** QuickJS-in-Wasm is roughly 10–50x slower than native V8. Fine for
  this workload, not for hot paths.
- **Eviction loses `state`.** A Durable Object can be evicted, taking in-memory globals with it.
  Persisting `state` to the DO's SQLite storage is the obvious next step.
- **Rendered HTML is injected with `innerHTML`.** Acceptable here because the author is the only
  person whose code reaches their own browser. A real platform needs a sandboxed frame.
- Session is chosen by a cookie; there is no auth. Add it before exposing this anywhere real.

### Timings are local-dev readings

`typecheck` and `bundle` in the header come from `performance.now()` deltas. Workers freezes both
`Date.now()` and `performance.now()` between I/O events, so on a deployed Worker these read `0 ms`.
Under `wrangler dev` the clock advances and they are real, which is where the ~70 ms figure and
`npm run bench` come from. `process ram` and `process cpu` are blank for the same class of reason:
nothing is observable from inside the Worker.

## Known limits

- **`space-bunny-free` is rate limited.** The Zen free tier returns
  `429 FreeUsageLimitError` under load; the UI surfaces it in the transcript. A
  429 rather than a 401 confirms the secret is configured correctly. Swap
  `MODEL` in `src/agent.ts` for a paid model to lift it.
- **No storage.** The Database tab is a placeholder; the agent only writes
  `index.ts`.
- **Rendered output is injected into a shadow root**, with `<script>` stripped.
  Its styles are scoped so they cannot restyle the chat, and `:root` is
  rewritten to `:host` so the app's custom properties still resolve.
- **`process ram` / `process cpu` in the header are blank.** Neither is
  observable from inside a Worker, and inventing numbers would be worse.
- **The agent can be talked into a bad layout.** It has no preview feedback, so
  a runaway element height will not be noticed. A future pass could screenshot
  the preview and hand the image back.
