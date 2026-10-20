import { isSafePath } from "../paths";
import { isWorktreeKey } from "../gitops";
import { isImageId, validateImageInput } from "../images";
import type { FileMap } from "../session";
import { requireAccess, sessionJson, turnConflict, withSession } from "../server/auth";
import type { RouteCtx } from "../server/auth";

/** State, files, images, and chat-admin endpoints. */
export async function handleFiles(req: Request, ctx: RouteCtx): Promise<Response | null> {
  const { url, env, session, stub } = ctx;
  if (url.pathname === "/api/state") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    const files = await stub.getFiles();
    const messages = await stub.getMessages();
    const built = await stub.build();
    // version feeds the teammate-edit reload guard; turn/share feed the
    // Sharing panel so the other member sees live state without polling.
    let version = 0;
    let turn = null;
    let share = null;
    try {
      if (typeof stub.getFilesVersion === "function") version = await stub.getFilesVersion();
      if (typeof stub.getTurnStatus === "function") turn = await stub.getTurnStatus();
      const s = stub as { getShareStatus?: (viewerMemberId?: string | null) => Promise<unknown> };
      if (typeof s.getShareStatus === "function") share = await s.getShareStatus(authed.access.memberId);
    } catch {
      /* best-effort extras: files/messages/built above are the state */
    }
    return sessionJson({ files, messages, built, version, turn, share }, session, 200, { "cache-control": "no-store" });
  }

  if (url.pathname === "/api/build" && req.method === "POST") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    return sessionJson({ built: await stub.build() }, session);
  }

  if (url.pathname === "/api/file" && req.method === "POST") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    // Same clobber hazard as the bulk save: read-mutate-write of the whole
    // map races an agent turn's write_file persists.
    const conflict = await turnConflict(stub, session);
    if (conflict) return conflict;
    const { path, content, baseVersion } = (await req.json()) as { path?: string; content?: string; baseVersion?: unknown };
    // null and undefined both mean "no base" (see /api/files in github-repos).
    const base = baseVersion ?? undefined;
    const key = (path ?? "").trim() || "index.ts";
    if (!isSafePath(key)) {
      return sessionJson({ error: "unsafe path" }, session, 400);
    }
    if (!isWorktreeKey(key)) {
      return sessionJson({ error: "refused path inside .git" }, session, 400);
    }
    // Teammate-edit guard: on shared playgrounds the version is required
    // (an omitted version could silently overwrite a teammate's save), and
    // the compare-and-write runs atomically in the DO — edge
    // check-then-set would still race concurrent saves.
    const saver = stub as {
      saveFileIfVersion?: (
        path: string,
        content: string,
        base: number | undefined,
      ) => Promise<{ ok: boolean; files: FileMap; version: number }>;
      getFilesVersion?: () => Promise<number>;
    };
    if (authed.access.shared && base === undefined) {
      let version = 0;
      try {
        if (typeof saver.getFilesVersion === "function") version = await saver.getFilesVersion();
      } catch {
        /* best-effort */
      }
      return sessionJson(
        { error: "shared save needs the files version — reload and retry", files: await stub.getFiles(), version },
        session,
        409,
      );
    }
    if (typeof saver.saveFileIfVersion === "function") {
      const saved = await saver.saveFileIfVersion(key, content ?? "", base as number | undefined);
      if (!saved.ok) {
        return sessionJson(
          { error: "teammate edited — reload: files changed since you loaded them, your copy is stale", files: saved.files, version: saved.version },
          session,
          409,
        );
      }
      return sessionJson({ files: saved.files, built: await stub.build(), version: saved.version }, session);
    }
    const files = { ...(await stub.getFiles()) };
    files[key] = content ?? "";
    await stub.setFiles(files);
    let version = 0;
    try {
      if (typeof saver.getFilesVersion === "function") version = await saver.getFilesVersion();
    } catch {
      /* best-effort */
    }
    return sessionJson({ files, built: await stub.build(), version }, session);
  }

  // Chat image attachments: bytes live in R2 (via the session object), the
  // transcript keeps only `{ id, mimeType }` refs, and the model receives
  // inline base64 through Pi's UserInput on the next turn.
  if (url.pathname === "/api/images" && req.method === "POST") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return sessionJson({ error: "expected a JSON body" }, session, 400);
    }
    const { data, mimeType } = (body ?? {}) as { data?: unknown; mimeType?: unknown };
    try {
      if (typeof data !== "string") throw new Error("image data is required");
      if (typeof mimeType !== "string") throw new Error("image mimeType is required");
      const saved = await stub.saveImage(data, mimeType);
      return sessionJson(
        { id: saved.id, url: `/api/images/${saved.id}`, mimeType: saved.mimeType, size: saved.size },
        session,
      );
    } catch (e) {
      return sessionJson({ error: e instanceof Error ? e.message : String(e) }, session, 400);
    }
  }

  const imageMatch = url.pathname.match(/^\/api\/images\/([A-Za-z0-9-]+)$/);
  if (imageMatch && req.method === "DELETE") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    const id = imageMatch[1] as string;
    try {
      await stub.deleteImage(id);
      return sessionJson({ ok: true }, session);
    } catch (e) {
      return sessionJson({ error: e instanceof Error ? e.message : String(e) }, session, 400);
    }
  }
  if (imageMatch && req.method === "GET") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    const id = imageMatch[1] as string;
    if (!isImageId(id)) return sessionJson({ error: "bad image id" }, session, 400);
    const stored = await stub.getImage(id);
    if (!stored) return sessionJson({ error: "image not found" }, session, 404);
    let bytes: Uint8Array;
    try {
      const checked = validateImageInput(stored.data, stored.mimeType);
      bytes = Uint8Array.from(atob(checked.data), (c) => c.charCodeAt(0));
    } catch {
      return sessionJson({ error: "image unreadable" }, session, 500);
    }
    // `bytes.buffer` may be a SharedArrayBuffer over a pool: slice to the
    // exact view before responding.
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(body, {
      headers: withSession(
        new Headers({
          "content-type": stored.mimeType,
          "cache-control": "private, max-age=3153600",
        }),
        session,
      ),
    });
  }

  if (url.pathname === "/api/reset" && req.method === "POST") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    return sessionJson(await stub.reset(), session);
  }

  // Clear agent context only; capsule files are left untouched. The chat
  // transcript persists per session in the Durable Object, so without this
  // a refresh restores an invisible history that still consumes context.
  if (url.pathname === "/api/clear-chat" && req.method === "POST") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    await stub.clearChat();
    return sessionJson({ ok: true }, session);
  }
  return null;
}
