import type { FileMap } from "../session";
import { TOOL_TIMEOUT_MS, withToolTimeout } from "../agent";
import { listRemoteBranches, parseRepoRef } from "../github";
import { requireAccess, sessionJson } from "../server/auth";
import type { RouteCtx } from "../server/auth";

/** Just-git commit, pull, inspect, run, and branch endpoints. */
export async function handleGit(req: Request, ctx: RouteCtx): Promise<Response | null> {
  const { url, env, session, stub } = ctx;
  if (url.pathname === "/api/git/commit" && req.method === "POST") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const as = authed.access.shared && authed.access.user
        ? { token: authed.access.token, user: authed.access.user }
        : undefined;
      const { message } = (await req.json()) as { message?: string };
      if (!message || !message.trim()) return sessionJson({ error: "commit message is required" }, session, 400);
      const r = await stub.commitPush(message.trim(), ...(as ? [as] : []));
      return sessionJson({ ...r, status: await stub.gitStatus() }, session);
    } catch (e) {
      return sessionJson({ error: (e as Error).message }, session, 500);
    }
  }

  if (url.pathname === "/api/git/pull" && req.method === "POST") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const as = authed.access.shared && authed.access.user
        ? { token: authed.access.token, user: authed.access.user }
        : undefined;
      const r = await stub.pullFromRemote(...(as ? [as] : []));
      const built = await stub.build();
      if (r.conflict) {
        // 409, but still with the conflict-marked files: the editor must
        // receive the markers it is told to resolve.
        return sessionJson({ ...r, built }, session, 409);
      }
      return sessionJson({ ...r, built }, session);
    } catch (e) {
      return sessionJson({ error: (e as Error).message }, session, 500);
    }
  }

  if (url.pathname === "/api/git/status") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      // Behind the serialized git queue server-side: bound it so a
      // stalled push/pull/fetch fails this read visibly instead of
      // hanging the panel indefinitely.
      const status = await withToolTimeout(stub.gitStatus(), TOOL_TIMEOUT_MS, "git status");
      return sessionJson({ status }, session, 200, {
        "cache-control": "no-store",
      });
    } catch (e) {
      return sessionJson({ error: (e as Error).message }, session, 500);
    }
  }

  if (url.pathname === "/api/git/log") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const log = await withToolTimeout(stub.gitLog(), TOOL_TIMEOUT_MS, "git log");
      return sessionJson({ log }, session, 200, {
        "cache-control": "no-store",
      });
    } catch (e) {
      return sessionJson({ error: (e as Error).message }, session, 500);
    }
  }

  if (url.pathname === "/api/git/run" && req.method === "POST") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const as = authed.access.shared && authed.access.user
        ? { token: authed.access.token, user: authed.access.user }
        : undefined;
      const { command } = (await req.json()) as { command?: string };
      if (!command || !command.trim()) return sessionJson({ error: "command is required" }, session, 400);
      // Same bound as the Pi tool path and the panel reads: a stalled
      // push/pull/fetch must fail visibly, not spin ghBusy forever. The
      // server-side op may still complete; push/pull/fetch retries are safe.
      const r = await withToolTimeout(stub.gitRun(command.trim(), ...(as ? [as] : [])), TOOL_TIMEOUT_MS, "git command");
      // A non-capsule repo will not build: still return the git result and
      // let the panel show the build error alongside it.
      let built: unknown = null;
      try {
        built = await stub.build();
      } catch {
        built = { ok: false, error: { name: "Build", message: "repo does not build as a capsule" } };
      }
      return sessionJson({ ...r, built }, session);
    } catch (e) {
      // Timeout (or RPC/storage failure) with a possibly still-running
      // server op: return current server files so the panel resyncs
      // instead of later overwriting the op's working-tree changes with
      // its stale copy. Best-effort — a completion landing after this
      // read can still race; the version guard in gitRun protects the
      // op's own write, not a later bulk save.
      let files: FileMap | undefined;
      try {
        files = await stub.getFiles();
      } catch {
        /* storage failure: report the error without files */
      }
      return sessionJson({ error: (e as Error).message, ...(files ? { files } : {}) }, session, 500);
    }
  }

  // Branch picker data for the linked checkout: local + remote-tracking
  // branches plus the current branch, no typing required.
  if (url.pathname === "/api/git/branches") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const as = authed.access.shared && authed.access.user
        ? { token: authed.access.token, user: authed.access.user }
        : undefined;
      const r = await withToolTimeout(stub.getBranches(...(as ? [as] : [])), TOOL_TIMEOUT_MS, "git branches");
      return sessionJson(r, session, 200, { "cache-control": "no-store" });
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

  // Create proto/<name> from HEAD and push `-u origin`. Guarded like
  // Create/Commit: the panel saves editor files first, and a mid-turn
  // request is refused instead of racing the FileMap.
  if (url.pathname === "/api/git/branch/new" && req.method === "POST") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const as = authed.access.shared && authed.access.user
        ? { token: authed.access.token, user: authed.access.user }
        : undefined;
      if (await stub.isTurnActive()) {
        return sessionJson(
          { error: "an agent turn is in progress — wait for it to finish, then retry" },
          session,
          409,
        );
      }
      const { name } = (await req.json()) as { name?: string };
      if (!name || !name.trim()) return sessionJson({ error: "branch name is required" }, session, 400);
      // The endpoint owns the branch-per-prototype contract: only proto/*
      // branches are created here, matching the delete path.
      if (!name.trim().startsWith("proto/")) {
        return sessionJson({ error: "branch name must start with proto/ (e.g. proto/my-prototype)" }, session, 400);
      }
      const r = await withToolTimeout(stub.createBranch(name.trim(), ...(as ? [as] : [])), TOOL_TIMEOUT_MS, "git branch");
      let built: unknown = null;
      try {
        built = await stub.build();
      } catch {
        built = { ok: false, error: { name: "Build", message: "repo does not build as a capsule" } };
      }
      let linked: unknown = null;
      try {
        linked = (await stub.getGitHubStatus())?.linked ?? null;
      } catch {
        /* keep null */
      }
      return sessionJson({ ...r, built, linked }, session);
    } catch (e) {
      let files: FileMap | undefined;
      try {
        files = await stub.getFiles();
      } catch {
        /* storage failure: report the error without files */
      }
      return sessionJson({ error: (e as Error).message, ...(files ? { files } : {}) }, session, 500);
    }
  }

  if (url.pathname === "/api/git/branch/switch" && req.method === "POST") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const as = authed.access.shared && authed.access.user
        ? { token: authed.access.token, user: authed.access.user }
        : undefined;
      if (await stub.isTurnActive()) {
        return sessionJson(
          { error: "an agent turn is in progress — wait for it to finish, then retry" },
          session,
          409,
        );
      }
      const { branch } = (await req.json()) as { branch?: string };
      if (!branch || !branch.trim()) return sessionJson({ error: "branch is required" }, session, 400);
      const r = await withToolTimeout(stub.switchBranch(branch.trim(), ...(as ? [as] : [])), TOOL_TIMEOUT_MS, "git checkout");
      let built: unknown = null;
      try {
        built = await stub.build();
      } catch {
        built = { ok: false, error: { name: "Build", message: "repo does not build as a capsule" } };
      }
      let linked: unknown = null;
      try {
        linked = (await stub.getGitHubStatus())?.linked ?? null;
      } catch {
        /* keep null */
      }
      return sessionJson({ ...r, built, linked }, session);
    } catch (e) {
      let files: FileMap | undefined;
      try {
        files = await stub.getFiles();
      } catch {
        /* storage failure: report the error without files */
      }
      return sessionJson({ error: (e as Error).message, ...(files ? { files } : {}) }, session, 500);
    }
  }

  if (url.pathname === "/api/git/branch/delete" && req.method === "POST") {
    try {
      const authed = await requireAccess(req, stub, session);
      if ("gated" in authed) return authed.gated;
      const as = authed.access.shared && authed.access.user
        ? { token: authed.access.token, user: authed.access.user }
        : undefined;
      if (await stub.isTurnActive()) {
        return sessionJson(
          { error: "an agent turn is in progress — wait for it to finish, then retry" },
          session,
          409,
        );
      }
      const { branch } = (await req.json()) as { branch?: string };
      if (!branch || !branch.trim()) return sessionJson({ error: "branch is required" }, session, 400);
      const r = await withToolTimeout(stub.deleteBranch(branch.trim(), ...(as ? [as] : [])), TOOL_TIMEOUT_MS, "git branch delete");
      let linked: unknown = null;
      try {
        linked = (await stub.getGitHubStatus())?.linked ?? null;
      } catch {
        /* keep null */
      }
      return sessionJson({ ...r, linked }, session);
    } catch (e) {
      let files: FileMap | undefined;
      try {
        files = await stub.getFiles();
      } catch {
        /* storage failure: report the error without files */
      }
      return sessionJson({ error: (e as Error).message, ...(files ? { files } : {}) }, session, 500);
    }
  }
  return null;
}
