import { APP_SHIM_JS } from "../app-shim";
import { buildAppBundle } from "../lakebed";
import type { AppKind, AppState } from "../app-runtime";
import { APP_CORS, corsJson, requireAccess, requireLogin, resolveSidForRequest, sessionJson, withSession } from "../server/auth";
import { SID_RE } from "../server/auth";
import { appDoc } from "../server/page";
import type { RouteCtx } from "../server/auth";

/** Sandboxed app runtime endpoints and harness status. */
export async function handleApps(req: Request, ctx: RouteCtx): Promise<Response | null> {
  const { url, env, session, stub } = ctx;
  if (url.pathname === "/api/app-shim.js") {
    return new Response(APP_SHIM_JS, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
        ...APP_CORS,
      },
    });
  }

  // Live app view endpoints. The iframe runs sandboxed to an opaque origin
  // with no cookies, so it cannot present `ab_member`. It presents a
  // short-lived preview capability minted by the cookie-authenticated
  // parent instead (POST /api/share/preview): a bare `?sid=` — which the
  // invite URL discloses — never suffices on its own.
  if (url.pathname === "/api/app-state" || url.pathname === "/api/app-mutate") {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: APP_CORS });
  }

  /**
   * Preview capability check for the sandboxed iframe. Stubs that predate
   * preview tokens (tests, older shapes) fall back to the object-token
   * gate; real objects always enforce the capability.
   */
  const checkPreview = async (
    sidStub: {
      getGitHubToken?: () => Promise<string | null>;
      checkPreviewToken?: (preview: unknown) => Promise<{ memberId: string | null } | null>;
    },
    preview: unknown,
  ): Promise<Response | null> => {
    if (typeof sidStub.checkPreviewToken === "function") {
      const grant = await sidStub.checkPreviewToken(preview).catch(() => null);
      if (!grant) {
        return corsJson(
          { ok: false, error: { name: "Auth", message: "preview expired or invalid — reload the preview" } },
          401,
        );
      }
      return null;
    }
    return null;
  };

  if (url.pathname === "/api/app-state") {
    const sid = url.searchParams.get("sid") ?? "";
    const sidStub = await resolveSidForRequest(env, req, sid, stub);
    if (!sid) return corsJson({ ok: false, error: { name: "Session", message: "bad sid" } }, 400);
    if (!sidStub) {
      // Unknown shape or revoked bearer: indistinguishable from bad sid.
      return SID_RE.test(sid)
        ? corsJson({ ok: false, error: { name: "Auth", message: "github login required" } }, 401)
        : corsJson({ ok: false, error: { name: "Session", message: "bad sid" } }, 400);
    }
    if (!(await sidStub.getGitHubToken())) {
      return corsJson({ ok: false, error: { name: "Auth", message: "github login required" } }, 401);
    }
    const previewGate = await checkPreview(sidStub, url.searchParams.get("preview"));
    if (previewGate) return previewGate;
    return corsJson(await sidStub.appState());
  }

  if (url.pathname === "/api/app-mutate" && req.method === "POST") {
    let body: { sid?: unknown; preview?: unknown; kind?: unknown; name?: unknown; args?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return corsJson({ ok: false, error: { name: "Request", message: "expected a JSON body" } }, 400);
    }
    if (typeof body.sid !== "string" || !SID_RE.test(body.sid)) {
      return corsJson({ ok: false, error: { name: "Session", message: "bad sid" } }, 400);
    }
    const mutateStub = await resolveSidForRequest(env, req, body.sid, stub);
    if (!mutateStub) {
      return corsJson({ ok: false, error: { name: "Auth", message: "github login required" } }, 401);
    }
    if (!(await mutateStub.getGitHubToken())) {
      return corsJson({ ok: false, error: { name: "Auth", message: "github login required" } }, 401);
    }
    const mutateGate = await checkPreview(mutateStub, body.preview);
    if (mutateGate) return mutateGate;
    if (body.kind !== "mutation" && body.kind !== "action") {
      return corsJson({ ok: false, error: { name: "Request", message: "kind must be mutation or action" } }, 400);
    }
    if (typeof body.name !== "string" || !body.name) {
      return corsJson({ ok: false, error: { name: "Request", message: "name must be a non-empty string" } }, 400);
    }
    if (body.args !== undefined && !Array.isArray(body.args)) {
      return corsJson({ ok: false, error: { name: "Request", message: "args must be an array" } }, 400);
    }
    const kind: AppKind = body.kind;
    return corsJson(
      await mutateStub.appMutate(kind, body.name, body.args ?? []),
    );
  }

  if (url.pathname === "/api/app") {
    const sid = url.searchParams.get("sid") ?? "";
    if (!SID_RE.test(sid)) return new Response("bad sid", { status: 400 });
    const appStub = await resolveSidForRequest(env, req, sid, stub);
    if (!appStub) {
      return new Response("github login required", { status: 401 });
    }
    if (!(await appStub.getGitHubToken())) {
      return new Response("github login required", { status: 401 });
    }
    // The served document embeds live state: gate the capability like the
    // JSON endpoints, or the sid alone (disclosed by invite URLs) loads it.
    if (typeof appStub.checkPreviewToken === "function") {
      const grant = await appStub.checkPreviewToken(url.searchParams.get("preview")).catch(() => null);
      if (!grant) return new Response("preview expired or invalid — reload the preview", { status: 401 });
    }
    const previewParam = url.searchParams.get("preview") ?? "";
    const appFiles = await appStub.getFiles();
    // The RPC stub type does not preserve the discriminated union, so
    // restore it: at runtime this is plain data in exactly this shape.
    const state = (await appStub.appState()) as AppState;
    let bundle: string | null;
    let bundleError: string | null = null;
    try {
      bundle = buildAppBundle(appFiles, `${url.origin}/api/app-shim.js`);
    } catch (e: any) {
      bundle = null;
      bundleError = e?.message ?? String(e);
    }
    return new Response(
      appDoc(bundle, {
        sid,
        preview: previewParam,
        api: { state: `${url.origin}/api/app-state`, mutate: `${url.origin}/api/app-mutate` },
        state: state.ok ? { tables: state.tables, queries: state.queries } : null,
        error: state.ok ? (bundleError ? { message: bundleError } : null) : state.error,
      }),
      {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      },
    );
  }

  // Pi boot probe (no key needed): forwards to the object's /pi-status.
  // Gated like every other session API: it answers for the caller's object.
  if (url.pathname === "/api/pi-harness-status" && req.method === "GET") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    const res = await stub.fetch(new Request(new URL("/pi-status", url.origin), { method: "GET" }));
    const headers = withSession(new Headers(res.headers), session);
    // Probes must never cache: busyflips live while runs come and go.
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  }
  return null;
}
