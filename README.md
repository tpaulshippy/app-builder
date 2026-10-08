# app-builder

An agent chat that writes Lakebed capsules, and runs the full dev cycle — build,
test, lint, deploy — **inside a single Cloudflare Worker isolate**. Describe what
you want; it edits `server/index.ts` and `client/index.tsx`, checks its work with
a shell, and deploys to lakebed.

Live: **https://app-builder.pshippy-245.workers.dev**

```
you ─▶ muse-spark-1.3-contributor (BYOK, browser localStorage)
         │  tools: bash read_file write_file
         ▼
   Durable Object ──▶ just-bash ──▶ build · tests · lint · deploy
   files · chat      ──▶ QuickJS (WASM) ──▶ capsule server + stub DB
   one JS runtime         │
   one shell              └──▶ lakebed anonymous API ──▶ live *.lakebed.app
```

## Layout

| File | Role |
| --- | --- |
| `src/agent.ts` | The agent loop: Responses API, three tools, streaming events |
| `src/bash.ts` | just-bash backend: one shell per session, custom `build`/`tests`/`lint`/`deploy` |
| `src/capsule.ts` | Capsule runtime: `lakebed/server` stub + in-memory DB, build/test in QuickJS |
| `src/lakebed.ts` | In-isolate deploy: mini-bundler, artifact assembly, lakebed API POST |
| `src/session.ts` | One Durable Object per session — files, chat history, QuickJS + bash |
| `src/sandbox.ts` | Compile, execute in QuickJS, capture logs, enforce limits |
| `src/index.ts` | Routing and the chat UI (BYOK key input, capsule preview) |
| `spikes/wasi-host/` | Proof that a `wasm32-wasip1` module runs in a Worker |
| `docs/ts-rust-integration.md` | Plan for full `tsc` diagnostics via wasm |

The agent loop runs in the Worker: it is almost entirely waiting on the API, and waiting on network
does not count toward CPU time. The QuickJS runtime lives in the Durable Object because that has to
survive between requests.

## The capsule API

```ts
// server/index.ts
import { capsule, mutation, query, table, string, userId } from "lakebed/server";

export default capsule({
  schema: { todos: table({ text: string(), ownerId: userId() }).index("by_owner", ["ownerId"]) },
  queries: {
    todos: query(async (ctx) => {
      const { userId } = ctx.auth.requireIdentity();
      return ctx.db.todos.withIndex("by_owner", (q) => q.eq("ownerId", userId)).collect();
    }),
  },
  mutations: {
    addTodo: mutation(async (ctx, text: string) => ctx.db.todos.insert({ text, ownerId: ctx.auth.requireIdentity().userId })),
  },
});
```

```tsx
// client/index.tsx
import { createClient } from "lakebed/client";
import type app from "../server/index";
const client = createClient<typeof app>();
export function App() {
  const todos = client.useQuery("todos"); // undefined until first result
  /* ... */
}
```

## Configuration

Auth is BYOK: enter the API key in the composer box. It is kept in the browser's
`localStorage` and sent with each chat request; the Worker never stores it.
`OPENCODE_ZEN_KEY` remains as a server-side fallback secret. `LAKEBED_TOKEN` is
an optional Worker secret for owned lakebed deploys — without it, `deploy`
publishes anonymous preview deploys, which expire (currently ~7 days).

```sh
npm install
npx wrangler secret put OPENCODE_ZEN_KEY   # optional fallback
npx wrangler secret put LAKEBED_TOKEN      # optional, owned deploys
./deploy.sh
npm run check        # syntax-checks the inline UI script against the dev server
```

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

## Capsule dev loop

The agent works in a shell, not bespoke file tools. `bash` runs just-bash
commands against `/app`; `read_file`/`write_file` move whole files without
quoting pain:

| Command | What it does, all in the isolate |
| --- | --- |
| `build` | Validate the capsule, execute `server/index.ts` in QuickJS against a stub `lakebed/server` with an in-memory DB, smoke-run every query |
| `tests` | Run `*.test.ts` in the isolate (`describe`/`it`/`expect`, `__testCtx` for DB access) |
| `lint` | Parse, import, and anonymous-deploy checks — mirrors what deploy enforces |
| `deploy` | Assemble the lakebed artifact and POST it (anonymous, or owned with `LAKEBED_TOKEN`) |

Standard shell commands (`ls`, `cat`, `grep`, `sed`, `jq`, pipes) work too —
that is the point of just-bash: one shell tool instead of N bespoke ones.
`console.log/warn/error` from builds and tests is captured per run.

Local capsule state is in-memory and resets on rebuild — the same contract as
`lakebed dev`.

## What works, and what does not

Verified in `wrangler dev` against real workerd, plus real anonymous deploys:

| Behaviour | Result |
| --- | --- |
| TypeScript + JSX (sucrase, `disableESTransforms`) | ✅ |
| just-bash shell (`ls`, pipes, `jq`, custom commands) | ✅ 56 ms round-trip |
| `build`: capsule executes, every query smoke-run | ✅ tables + rows in ~60 ms |
| `tests`: `describe`/`it`/`expect` vs stub DB | ✅ insert → `withIndex` → `collect` |
| `lint`: parse, imports, anonymous-deploy rules | ✅ predicts deploy acceptance |
| `deploy`: artifact accepted, app serves | ✅ queries + mutations live in browser |
| `await` on already-settled values | ✅ |
| `console.*` capture | ✅ |
| Runtime errors with real stack traces | ✅ |
| Runaway loop | ✅ stopped at ~2s, context survives |
| Allocation bomb | ✅ stopped at 64 MB, context survives |
| `await` on real I/O or a timer | ❌ reported as `Unsupported` |
| `test` as a custom command name | ❌ POSIX builtin wins — the command is `tests` |

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

## Deploy: what the isolate can and cannot build

`lakebed build` uses esbuild (native binary), which cannot run in a Worker. The
isolate instead assembles the deploy artifact with pure TS and POSTs it to the
lakebed API — verified end to end against real anonymous deploys:

- Server bundle: relative files inlined, sucrase-transformed, with the real
  `lakebed/server` runtime (pinned `lakebed@0.0.39` files, hash-verified at
  deploy time) vendored in. Deploys are rejected if a vendor hash drifts.
- Client bundle: JSX compiled to `h()`, browser externals rewritten to pinned
  esm.sh URLs (`preact@10.28.0`, `lakebed@0.0.39` client). One shared preact
  instance — two copies break hooks state.
- Schema, endpoints, and auth are extracted by executing the server entry in
  QuickJS and serialized in the exact artifact shape; the control plane
  re-validates, so a local `lint` predicts acceptance.

Constraints this implies: capsules may only import relative files, `lakebed/*`,
and `preact`; top-level names must not collide across inlined files; Tailwind
classes render unstyled (no CSS compiler in the isolate — the platform injects
its own browser build); server code must already satisfy the anonymous rules
(no `while`, `eval`, dynamic `import()`, server `fetch`, or `globalThis`).

## Notes and limits

- **Lint, not full type checking.** Sucrase strips types without checking them.
  `lint` catches parse errors, bad imports, and every anonymous-deploy rule, but
  a wrong type annotation still sails through. See
  [`docs/ts-rust-integration.md`](docs/ts-rust-integration.md) for real `tsc`
  diagnostics via wasm, and [`spikes/wasi-host/`](spikes/wasi-host/) for the
  proof that a `wasm32-wasip1` module runs here.
- **No npm installs.** Capsules import relative files, `lakebed/*`, and `preact`.
- **Interpreted, so slow.** QuickJS-in-Wasm is roughly 10–50x slower than native V8. Fine for
  this workload, not for hot paths.
- **Eviction loses the runtimes.** A Durable Object can be evicted, taking the
  QuickJS globals and bash FS with it. Files and chat persist in SQLite storage
  and re-seed on next use.
- **BYOK key lives in `localStorage`.** Convenient and server-stateless, but any
  script running on the page origin can read it. Do not use a funded key on an
  untrusted network.
- Session is chosen by a cookie; there is no auth. Add it before exposing
  this anywhere real.
## Known limits

- **Contributor tier trains on prompts.** `muse-spark-1.3-contributor-free`
  exchanges steep discounts for permission to train on usage. A 429 means rate
  limited; a 401 means the browser key is missing or wrong.
- **Anonymous deploys expire** (~7 days at time of writing) and disable
  server-side `fetch` and hosted env. Claim the deploy and redeploy with
  `LAKEBED_TOKEN` for the full platform.
- **The client preview is server state, not pixels.** `client/index.tsx` needs a
  browser DOM, so the Preview tab shows query results; the deployed URL is the
  visual check.
- **`process ram` / `process cpu` in the header are blank.** Neither is
  observable from inside a Worker, and inventing numbers would be worse.
