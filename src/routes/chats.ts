import type { FileMap } from "../session";
import { isWorktreeKey } from "../gitops";
import { parseRepoRef } from "../github";
import { requireAccess, sessionJson, turnConflict } from "../server/auth";
import type { RouteCtx } from "../server/auth";

/** Chat history snapshots, resume, and admin. */
export async function handleChats(req: Request, ctx: RouteCtx): Promise<Response | null> {
  const { url, env, session, stub } = ctx;
  // Named chat checkpoints: snapshot the current messages + files, list
  // them newest-first, or restore one into the live session.
  if (url.pathname === "/api/chats" && req.method === "GET") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    // Current link rides along so the picker can show it without a second
    // round-trip; best-effort for stub shapes that lack getGitHubStatus.
    let linked: unknown = null;
    try {
      linked = (await stub.getGitHubStatus())?.linked ?? null;
    } catch {
      linked = null;
    }
    return sessionJson({ chats: await stub.listChats(), linked }, session, 200, { "cache-control": "no-store" });
  }

  if (url.pathname === "/api/chats/snapshot" && req.method === "POST") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    let title = "";
    let files: FileMap | undefined;
    try {
      const body = (await req.json()) as { title?: unknown; files?: unknown };
      title = body.title as string ?? "";
      // The Code tab keeps unsaved edits in browser memory: the snapshot
      // button sends its file map so the checkpoint captures them. Validate
      // like the bulk-save endpoint; omitted means "persisted state" (Pi
      // turns, auto-checkpoints, older clients).
      if (body.files !== undefined) {
        if (!body.files || typeof body.files !== "object" || Array.isArray(body.files)) {
          return sessionJson({ error: "expected { files }" }, session, 400);
        }
        for (const key of Object.keys(body.files as FileMap)) {
          if (!isWorktreeKey(key) || typeof (body.files as FileMap)[key] !== "string") {
            return sessionJson({ error: `refused path: ${key}` }, session, 400);
          }
        }
        files = { ...(body.files as FileMap) };
      }
    } catch {
      /* empty body: default title */
    }
    try {
      return sessionJson({ chat: await stub.snapshotChat(typeof title === "string" ? title : "", files, authed.access.actor ?? undefined) }, session);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = message.startsWith("chat snapshot too large") ? 413
        : message.startsWith("an agent turn is in progress") ? 409
        : 500;
      return sessionJson({ error: message }, session, status);
    }
  }

  const renameMatch = url.pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]{8,64})\/?rename$/);
  if (renameMatch && req.method === "POST") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    let title = "";
    try {
      title = ((await req.json()) as { title?: unknown }).title as string ?? "";
    } catch {
      /* empty body: title required below */
    }
    if (typeof title !== "string" || !title.trim()) {
      return sessionJson({ error: "snapshot title is required" }, session, 400);
    }
    try {
      return sessionJson({ chat: await stub.renameChat(renameMatch[1] as string, title) }, session);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status =
        message === "chat snapshot not found" ? 404
        : message.startsWith("chat snapshot too large") ? 413
        : 500;
      return sessionJson({ error: message }, session, status);
    }
  }

  const resumeMatch = url.pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]{8,64})\/?resume$/);
  if (resumeMatch && req.method === "POST") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    try {
      // resumeChat builds under its own lock, so the response always
      // describes the session it restored.
      return sessionJson(await stub.resumeChat(resumeMatch[1] as string, authed.access.actor ?? undefined), session);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = message === "chat snapshot not found" ? 404 : message.startsWith("chat snapshot too large") ? 413 : 500;
      return sessionJson({ error: message }, session, status);
    }
  }

  const deleteMatch = url.pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]{8,64})\/delete\/?$/);
  if (deleteMatch && req.method === "POST") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    try {
      return sessionJson(await stub.deleteChat(deleteMatch[1] as string), session);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = message === "chat snapshot not found" ? 404 : 500;
      return sessionJson({ error: message }, session, status);
    }
  }

  // Start a fresh chat session, optionally bound to a repo: an optional
  // title snapshots the current chat first, an optional repoRef clones the
  // repo, then the agent context clears so the new session starts clean.
  if (url.pathname === "/api/chats/start" && req.method === "POST") {
    const authed = await requireAccess(req, stub, session);
    if ("gated" in authed) return authed.gated;
    // Same clobber hazard as the bulk file save: cloning replaces the whole
    // FileMap, so refuse while an agent turn is writing instead of racing
    // it and losing either side's files.
    const conflict = await turnConflict(stub, session);
    if (conflict) return conflict;
    const as = authed.access.shared && authed.access.user
      ? { token: authed.access.token, user: authed.access.user }
      : undefined;
    let body: { repoRef?: unknown; branch?: unknown; title?: unknown } = {};
    try {
      const parsed = (await req.json()) as typeof body;
      if (parsed && typeof parsed === "object") body = parsed;
    } catch {
      /* empty body: fresh chat with no repo */
    }
    const repoRef = typeof body.repoRef === "string" ? body.repoRef.trim() : "";
    const branch = typeof body.branch === "string" ? body.branch.trim() : "";
    const title = typeof body.title === "string" ? body.title : "";
    try {
      if (title.trim()) await stub.snapshotChat(title, undefined, authed.access.actor ?? undefined);
      let cloned: { files?: unknown; meta?: unknown } | null = null;
      if (repoRef) {
        const { owner, repo } = parseRepoRef(repoRef);
        cloned = await stub.cloneFromGitHub({ owner, repo, branch: branch || undefined, ...(as ? { as } : {}) });
      } else {
        // No repo picked: drop a stale link so the fresh chat, its header
        // badge, and its snapshots do not inherit the previous repo.
        await stub.unlinkRepo();
      }
      await stub.clearChat();
      const built = await stub.build();
      let linked: unknown = cloned?.meta ?? null;
      try {
        linked = (await stub.getGitHubStatus())?.linked ?? linked;
      } catch {
        /* stub without status: keep the clone meta */
      }
      return sessionJson({ files: await stub.getFiles(), built, linked }, session);
    } catch (e) {
      const message = (e as Error).message;
      const status = message.startsWith("chat snapshot too large") ? 413 : 500;
      return sessionJson({ error: message }, session, status);
    }
  }
  return null;
}
