import type { FileMap } from "../session";
import { createRepo, deleteRepo, listRemoteBranches, listRepos, parseRepoRef, remoteUrl } from "../github";
import { isWorktreeKey } from "../gitops";
import { TOOL_TIMEOUT_MS, withToolTimeout } from "../agent";
import { requireAccess, sessionJson, turnConflict } from "../server/auth";
import type { RouteCtx } from "../server/auth";

/** GitHub repo list, open, create, and promote. */
export async function handleGithubRepos(req: Request, ctx: RouteCtx): Promise<Response | null> {
  const { url, env, session, stub } = ctx;
  if (url.pathname === "/api/github/repos") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      return sessionJson({ repos: await listRepos(authed.access.token) }, session, 200, {
        "cache-control": "no-store",
      });
    } catch (e) {
      return sessionJson({ error: (e as Error).message }, session, 500);
    }
  }

  // Bulk-save the editor's in-memory file map without building. The panel
  // calls this before commit/create so unsaved browser edits are not
  // silently omitted from the push.
  if (url.pathname === "/api/files" && req.method === "POST") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      // The browser snapshot can lag an active agent turn; replacing the
      // whole FileMap then would discard already-persisted agent edits.
      const conflict = await turnConflict(stub, session);
      if (conflict) return conflict;
      const { files: incoming, baseVersion } = (await req.json()) as { files?: FileMap; baseVersion?: unknown };
      if (!incoming || typeof incoming !== "object") {
        return sessionJson({ error: "expected { files }" }, session, 400);
      }
      for (const key of Object.keys(incoming)) {
        if (!isWorktreeKey(key) || typeof incoming[key] !== "string") {
          return sessionJson({ error: `refused path: ${key}` }, session, 400);
        }
      }
      const saver = stub as {
        saveFilesIfVersion?: (
          files: FileMap,
          base: number | undefined,
        ) => Promise<{ ok: boolean; files?: FileMap; version: number }>;
        getFilesVersion?: () => Promise<number>;
        getFiles?: () => Promise<FileMap>;
      };
      // Same required-version + atomic-compare rule as /api/file: on
      // shared playgrounds an omitted version could silently overwrite a
      // teammate's save, and edge check-then-set still races.
      if (authed.access.shared && baseVersion === undefined) {
        let version = 0;
        let files: FileMap = {};
        try {
          if (typeof saver.getFilesVersion === "function") version = await saver.getFilesVersion();
          if (typeof saver.getFiles === "function") files = await saver.getFiles();
        } catch {
          /* best-effort */
        }
        return sessionJson(
          { error: "shared save needs the files version — reload and retry", files, version },
          session,
          409,
        );
      }
      if (typeof saver.saveFilesIfVersion === "function") {
        const saved = await saver.saveFilesIfVersion({ ...incoming }, baseVersion as number | undefined);
        if (!saved.ok) {
          return sessionJson(
            { error: "teammate edited — reload: files changed since you loaded them, your copy is stale", files: saved.files, version: saved.version },
            session,
            409,
          );
        }
        let files: FileMap = { ...incoming };
        try {
          if (typeof saver.getFiles === "function") files = await saver.getFiles();
        } catch {
          /* best-effort */
        }
        return sessionJson({ files, version: saved.version }, session);
      }
      await stub.setFiles({ ...incoming });
      let version = 0;
      try {
        if (typeof saver.getFilesVersion === "function") version = await saver.getFilesVersion();
      } catch {
        /* best-effort */
      }
      return sessionJson({ files: await stub.getFiles(), version }, session);
    } catch (e) {
      return sessionJson({ error: (e as Error).message }, session, 500);
    }
  }

  if (url.pathname === "/api/github/create" && req.method === "POST") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      // The acting member's own token (never another member's): on a shared
      // playground a member without write access gets the collaborator
      // error from assertPushAccess, not an owner-token push.
      const token = authed.access.token;
      const as = authed.access.shared && authed.access.user
        ? { token, user: authed.access.user }
        : undefined;
      const { name, private: isPrivate, description, message } = (await req.json()) as {
        name?: string;
        private?: boolean;
        description?: string;
        message?: string;
      };
      if (!name || !name.trim()) return sessionJson({ error: "repo name is required" }, session, 400);
      const created = await createRepo(token, { name, private: isPrivate, description });
      const meta = {
        owner: created.owner,
        repo: created.name,
        branch: created.defaultBranch || "main",
        remoteUrl: remoteUrl(created.owner, created.name),
      };
      try {
        const pushed = await stub.pushCurrentToRemote({
          remoteUrl: meta.remoteUrl,
          meta,
          message: message || "initial commit from app-builder",
          ...(as ? { as } : {}),
        });
        return sessionJson({ repo: created, meta, output: pushed.output, files: await stub.getFiles() }, session);
      } catch (pushErr) {
        // The repo already exists at this point: say so explicitly, and
        // remove the empty shell so a retry does not collide with it.
        let cleaned = false;
        try {
          await deleteRepo(token, created.owner, created.name);
          cleaned = true;
        } catch {
          /* report below; the repo stays for manual deletion */
        }
        return sessionJson(
          {
            error:
              `repo ${created.fullName} was created but the initial push failed: ${(pushErr as Error).message}` +
              (cleaned ? " The empty repo was deleted, so retrying is safe." : " Delete it on GitHub before retrying."),
          },
          session,
          500,
        );
      }
    } catch (e) {
      return sessionJson({ error: (e as Error).message }, session, 500);
    }
  }

  if (url.pathname === "/api/github/promote" && req.method === "POST") {
    try {
      const {
        name,
        private: isPrivate,
        description,
        deleteSourceBranch,
        includeUncommitted,
      } = (await req.json()) as {
        name?: string;
        private?: boolean;
        description?: string;
        deleteSourceBranch?: boolean;
        includeUncommitted?: boolean;
      };
      if (!name || !name.trim()) return sessionJson({ error: "repo name is required" }, session, 400);
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const token = authed.access.token;
      // On shared playgrounds the push is attributed to the acting member
      // (their own token, never the owner's).
      const as = authed.access.shared && authed.access.user
        ? { token: authed.access.token, user: authed.access.user }
        : undefined;
      // No linked branch, no promote: fail before creating the shell
      // instead of creating it and deleting it again on the way out.
      const linked = (await stub.getGitHubStatus())?.linked ?? null;
      if (!linked) {
        return sessionJson({ error: "no linked repo: open a repo first, then promote its branch" }, session, 400);
      }
      const created = await createRepo(token, { name, private: isPrivate, description });
      const meta = {
        owner: created.owner,
        repo: created.name,
        branch: created.defaultBranch || "main",
        remoteUrl: remoteUrl(created.owner, created.name),
      };
      try {
        const promoted = await stub.promoteBranchToRepo({
          remoteUrl: meta.remoteUrl,
          meta,
          deleteSourceBranch: deleteSourceBranch === true,
          includeUncommitted: includeUncommitted === true,
          ...(as ? { as } : {}),
        });
        return sessionJson(
          {
            repo: created,
            meta,
            output: promoted.output,
            deletedSource: promoted.deletedSource,
            files: await stub.getFiles(),
          },
          session,
        );
      } catch (pushErr) {
        // Same shell-cleanup contract as Create: the repo already exists,
        // so remove the empty shell (or say how to) instead of leaving a
        // name that collides with the retry.
        let cleaned = false;
        try {
          await deleteRepo(token, created.owner, created.name);
          cleaned = true;
        } catch {
          /* report below; the repo stays for manual deletion */
        }
        return sessionJson(
          {
            error:
              `repo ${created.fullName} was created but promoting the branch failed: ${(pushErr as Error).message}` +
              (cleaned ? " The empty repo was deleted, so retrying is safe." : " Delete it on GitHub before retrying."),
          },
          session,
          500,
        );
      }
    } catch (e) {
      return sessionJson({ error: (e as Error).message }, session, 500);
    }
  }

  if (url.pathname === "/api/github/open" && req.method === "POST") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const as = authed.access.shared && authed.access.user
        ? { token: authed.access.token, user: authed.access.user }
        : undefined;
      const { ref, branch } = (await req.json()) as { ref?: string; branch?: string };
      if (!ref || !ref.trim()) return sessionJson({ error: "owner/repo is required" }, session, 400);
      const { owner, repo } = parseRepoRef(ref);
      const cloned = await stub.cloneFromGitHub({ owner, repo, branch: branch?.trim() || undefined, ...(as ? { as } : {}) });
      const built = await stub.build();
      return sessionJson({ ...cloned, built }, session);
    } catch (e) {
      return sessionJson({ error: (e as Error).message }, session, 500);
    }
  }
  // Remote branch names for an arbitrary repo (New-chat picker): the repo
  // is not cloned yet, so this reads the GitHub API, not the checkout.
  if (url.pathname === "/api/github/branches") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const ref = url.searchParams.get("ref") ?? "";
      if (!ref.trim()) return sessionJson({ error: "ref is required" }, session, 400);
      const { owner, repo } = parseRepoRef(ref);
      const token = authed.access.token;
      const r = await withToolTimeout(
        listRemoteBranches(token, owner, repo),
        TOOL_TIMEOUT_MS,
        "github branches",
      );
      return sessionJson(r, session, 200, { "cache-control": "no-store" });
    } catch (e) {
      return sessionJson({ error: (e as Error).message }, session, 500);
    }
  }


  return null;
}
