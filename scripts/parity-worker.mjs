/**
 * Parity harness: the real `src/typecheck.ts` behind an HTTP endpoint.
 *
 *     npx wrangler dev -c scripts/wrangler.parity.jsonc
 *     npm run typecheck:parity
 *
 * `scripts/parity.mjs` posts the fixtures here and compares what comes back
 * with what the native `tsc-rs` binary reported. This worker runs the *same*
 * module the app uses, not a copy, so a green parity run says something about
 * `src/typecheck.ts` rather than about a test double.
 *
 * It deliberately has no Durable Object: the point is to exercise the checker
 * in isolation from the sandbox.
 */

import { createTypeChecker } from "../src/typecheck.ts";
import { CASES } from "../fixtures/cases.ts";

const checker = createTypeChecker();

export default {
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" && req.method === "GET") {
      return Response.json({
        worker: "app-builder type-check parity",
        cases: CASES.map((c) => ({ name: c.name, about: c.about })),
        usage: "POST /typecheck {\"source\": \"...\"}",
      });
    }

    if (url.pathname === "/typecheck" && req.method === "POST") {
      let source;
      try {
        const body = await req.json();
        if (typeof body?.source !== "string") throw new Error("expected { source: string }");
        source = body.source;
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 400 });
      }

      const startedAt = Date.now();
      const result = await checker.typecheck(source);
      return Response.json({ ok: true, durationMs: Date.now() - startedAt, ...result });
    }

    return new Response("not found", { status: 404 });
  },
};