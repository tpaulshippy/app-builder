import { validateImageRefs } from "../images";
import { requireAccess, sessionJson, withSession } from "../server/auth";
import type { RouteCtx } from "../server/auth";

/** Agent chat turn endpoint. */
export async function handleChat(req: Request, ctx: RouteCtx): Promise<Response | null> {
  const { url, env, session, stub } = ctx;
  // The agent loop runs in Pi (Durable Object PiHarness): validate and
  // resolve BYOK at the edge, forward to the object, stream its SSE back
  // with the session cookie.
  if (url.pathname === "/api/chat" && req.method === "POST") {
    // GitHub login comes before the API-key check: anonymous visitors get
    // the login gate, not the key prompt.
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    const actor = authed.access.actor;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return sessionJson({ error: "expected a JSON body" }, session, 400);
    }
    if (!body || typeof body !== "object") {
      return sessionJson({ error: "expected a JSON body" }, session, 400);
    }
    const { message, key, gateway, model, images } = body as {
      message?: unknown;
      key?: string;
      gateway?: string;
      model?: string;
      images?: unknown;
    };
    if (typeof message !== "string" || !message.trim()) {
      return sessionJson({ error: "empty message" }, session, 400);
    }
    let imageRefs: { id: string }[];
    try {
      imageRefs = validateImageRefs(images);
    } catch (e) {
      return sessionJson({ error: e instanceof Error ? e.message : String(e) }, session, 400);
    }
    const bodyKey = typeof key === "string" ? key.trim() : "";
    const apiKey =
      req.headers.get("x-provider-key")?.trim() || bodyKey || env.OPENCODE_ZEN_KEY?.trim();
    if (!apiKey) {
      return sessionJson(
        { error: "no API key — enter one below (stored only in this browser)" },
        session,
        401,
      );
    }
    // withSession: the forwarded DO response carries no cookies, so a
    // first request must still set ab_session or the next request lands
    // on another object. A rejected forward (dead object, RPC failure)
    // still answers as an SSE error frame with the cookie, never a bare
    // 500 that also drops the session.
    let res: Response;
    try {
      res = await stub.fetch(
        new Request(new URL("/pi-harness", url.origin), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, apiKey, gateway, model, images: imageRefs, author: actor, memberId: authed.access.memberId }),
        }),
      );
    } catch (e) {
      const frame = `data: ${JSON.stringify({ type: "error", message: e instanceof Error ? e.message : String(e) })}\n\n`;
      return new Response(frame, {
        headers: withSession(
          new Headers({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" }),
          session,
        ),
      });
    }
    const headers = withSession(new Headers(res.headers), session);
    return new Response(res.body, { status: res.status, headers });
  }
  return null;
}
