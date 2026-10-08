# app-builder

TypeScript compiled **and executed inside a single Cloudflare Worker isolate**. Type in a
textarea, hit **Update output**, see it rendered.

This is the mechanism from Theo Browne's lakebed demo, built small enough to read in one sitting.

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

So ship a JavaScript engine as WebAssembly:

```
┌─ one V8 isolate ────────────────────────────────────┐
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

## Notes and limits

- **tsc-rs is not used here.** `tsc-rs` (a TypeScript compiler in Rust, MIT, 100% emit parity
  with tsc) is the interesting choice long-term because it is *retargetable* — you can point its
  emitter at your own IR instead of JavaScript, which is what makes a self-hosted capsule runtime
  like lakebed's "tiny IR" possible. It needs a Rust toolchain and is not vendored here, so this
  uses sucrase: pure JavaScript, no native binary, runs in-isolate.
- **No npm imports.** App code runs against a small host API (`html`, `state`, `console`). A
  bundler plus a resolver would be the next layer.
- **Interpreted, so slow.** QuickJS-in-Wasm is roughly 10–50x slower than native V8. Fine for
  this workload, not for hot paths.
- **Eviction loses `state`.** A Durable Object can be evicted, taking in-memory globals with it.
  Persisting `state` to the DO's SQLite storage is the obvious next step.
- **Rendered HTML is injected with `innerHTML`.** Acceptable here because the author is the only
  person whose code reaches their own browser. A real platform needs a sandboxed frame.
- Session is chosen by the caller via `x-ab-session`; there is no auth. Add it before exposing
  this anywhere real.