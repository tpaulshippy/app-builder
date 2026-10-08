/**
 * Fixtures for the type checker.
 *
 * Each case pairs TypeScript source with the diagnostics `tsc` must produce
 * for it. `expected.json` is generated from the *native* `tsc-rs` binary
 * (see `scripts/gen-fixtures.mjs`), and `scripts/parity.mjs` then asserts that
 * the `ts_rust.wasm` build reports the same codes in the same places.
 *
 * Generating expectations from the native binary rather than hand-writing them
 * is deliberate: it makes the wasm build's fidelity a measured claim instead of
 * an assertion. If the port's diagnostics drift, the parity check fails.
 *
 * These cases are also the regression net for `src/host-api.ts`. `default`
 * fails if the generated `globals.d.ts` stops declaring the host API, and
 * `implicit-any` fails if `strict` is ever dropped from the compiler options.
 */

import { DEFAULT_CODE } from "../src/default-code.ts";

export type FixtureCase = {
  /** Slug, used as the fixture key and in the parity report. */
  name: string;
  /** What this case pins down. */
  about: string;
  /** The program handed to the type checker. */
  source: string;
};

export const CASES: FixtureCase[] = [
  {
    name: "default",
    about:
      "The program the editor starts with must type-check clean. If this fails, " +
      "the generated globals.d.ts no longer matches the host API.",
    source: DEFAULT_CODE,
  },
  {
    name: "assign-wrong-type",
    about:
      "The exact case sucrase missed, from docs/ts-rust-integration.md: a string " +
      "assigned to a number field. TS2322.",
    source: [
      "interface User { name: string; age: number }",
      'const u: User = { name: "ada", age: "forty" };',
      "const missing = u.emai;",
      "export { u, missing };",
    ].join("\n"),
  },
  {
    name: "unknown-property",
    about: "A misspelled property. TS2339, and the value is undefined at runtime.",
    source: [
      "interface User { name: string }",
      "declare const u: User;",
      "export const email = u.emai;",
    ].join("\n"),
  },
  {
    name: "implicit-any",
    about:
      "Pins `strict: true`. Without it this parameter is implicitly any and no " +
      "diagnostic is reported at all.",
    source: "export function greet(name) { return `hi ${name}`; }",
  },
  {
    name: "unknown-global",
    about:
      "Pins that the host API is a closed set: a name that is not declared is an " +
      "error, so a typo in `html` is caught rather than silently undefined.",
    source: "export const x = htmll`<p>typo</p>`;",
  },
  {
    name: "html-signature",
    about:
      "Pins the declared shape of `html`: wrong argument types are rejected, so " +
      "the declaration is a real contract and not `any`. TS2345.",
    source: "html(1, 2);",
  },
  {
    name: "state-is-any",
    about:
      "Pins the deliberate looseness of `state`. Under `unknown` this is an error; " +
      "it passing is the documented cost of making the idiomatic increment " +
      "`state.runs = (state.runs ?? 0) + 1` ergonomic.",
    source: "state.runs.toFixed();",
  },
  {
    name: "syntax-error",
    about:
      "A parse error, not a type error. The sandbox already catches these via " +
      "sucrase as `compileError`; this pins that tsc agrees, so the two paths " +
      "cannot disagree about whether a program parses. TS1110.",
    source: "export const x: = 1;",
  },
  {
    name: "null-strictness",
    about:
      "strictNullChecks, which is the strictness people actually feel. A null " +
      "where a string is required. TS2322 — and only under strictNullChecks, " +
      "so disabling that flag (and nothing else) makes this case clean.",
    source: "export const s: string = null;",
  },
  {
    name: "no-dom",
    about:
      "The host API is not a browser: document must not resolve. Without the " +
      "dom lib this is TS2584; with it, an accepted program would throw in " +
      "the QuickJS sandbox instead.",
    source: "document.title = 'x';",
  },
];