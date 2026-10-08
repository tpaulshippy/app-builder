/**
 * The program the editor starts with.
 *
 * It lives here rather than inline in `index.ts` so the fixture generator can
 * import it and prove that the default program type-checks clean. A default
 * that fails `tsc` would make the first thing a new user sees a type error.
 *
 * It doubles as a worked example of the whole host API: `state` for anything
 * that must survive a re-run, `console.*` for the log pane, `html` for output.
 */

export const DEFAULT_CODE = `// TypeScript is type-checked by tsc (ts-rust, compiled to
// WebAssembly), then executed inside a QuickJS VM compiled to WebAssembly.
// V8's eval() is disabled on Cloudflare Workers; this VM has its own, and V8
// never sees it.
//
// Type errors are rejected before the code runs, so what you see rendered is
// what the compiler accepted.
//
// state survives across Update clicks. Same isolate, same context.

interface Visitor {
  name: string;
  visits: number;
}

state.runs = (state.runs ?? 0) + 1;

const visitors: Visitor[] = [
  { name: "ada", visits: 3 },
  { name: "grace", visits: 7 },
  { name: "katherine", visits: 5 },
];

const ranked: Visitor[] = [...visitors].sort((a, b) => b.visits - a.visits);

console.log("rendering", ranked.length, "visitors on run", state.runs);

html\`
  <h1>Run \${state.runs}</h1>
  <p class="muted">Type-checked and executed inside a Cloudflare Worker.</p>
  <ul>
    \${ranked.map((v) => "<li><b>" + v.name + "</b><span>" + v.visits + " visits</span></li>").join("")}
  </ul>
\`;
`;