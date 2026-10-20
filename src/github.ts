/**
 * GitHub OAuth and REST helpers.
 *
 * The Worker never sees a GitHub password. The browser is redirected to
 * github.com, GitHub redirects back to `/api/github/callback` with a one-time
 * code, and the Worker exchanges that code for a token server-side. The token
 * lives in the session's Durable Object storage, never in the page.
 */

export type GitHubUser = {
  login: string;
  id: number;
  avatarUrl?: string;
};

export type GitHubRepoInfo = {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
};

/**
 * OAuth scopes requested at login.
 *
 * `repo` covers clone/push on user repos, but pushing commits that touch
 * `.github/workflows/*` is rejected with 403 unless `workflow` is granted
 * too — a systemic clone-works/push-403s trap. Request both up front.
 * Existing sessions logged in under `repo` alone must Log out/in again.
 */
export const OAUTH_SCOPE = "repo workflow";

const API = "https://api.github.com";

function envError(name: string): Error {
  return new Error(`${name} is not set on this Worker (wrangler secret)`);
}

export function loginUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: OAUTH_SCOPE,
    state: opts.state,
  });
  return `https://github.com/login/oauth/authorize?${q.toString()}`;
}

export function requireEnv(env: Record<string, string | undefined>): {
  clientId: string;
  clientSecret: string;
} {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (!clientId) throw envError("GITHUB_CLIENT_ID");
  if (!clientSecret) throw envError("GITHUB_CLIENT_SECRET");
  return { clientId, clientSecret };
}

/**
 * What kind of user token this is. Only the prefix class is ever exposed —
 * never the token. It matters because GitHub forbids GitHub-App user tokens
 * (`ghu_`) for git Smart HTTP entirely (REST works, clone of public repos
 * works, every push 403s "denied to <user>"), while OAuth-App tokens (`gho_`)
 * push fine. A push-403 with kind `github-app` means the worker's
 * GITHUB_CLIENT_ID belongs to a GitHub App, not an OAuth App.
 */
export function tokenKind(token: string | null): "oauth" | "github-app" | "other" | "missing" {
  if (!token) return "missing";
  if (token.startsWith("gho_")) return "oauth";
  if (token.startsWith("ghu_")) return "github-app";
  return "other";
}

/** Fail fast for token kinds GitHub forbids for git push. */
export function assertGitCapableToken(token: string): void {
  if (tokenKind(token) === "github-app") {
    throw new Error(
      `This login used a GitHub App credential, which GitHub forbids for git push (every push 403s, while the API and cloning keep working). Create an OAuth App — GitHub Settings → Developer settings → OAuth Apps, not GitHub Apps — set its client id/secret as GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET on the Worker (docs/github-setup.md), then Log out and back in on the GitHub tab and retry. Nothing was committed.`,
    );
  }
}

/** Exchange an OAuth code for a user token, plus the scopes GitHub granted. */
export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ token: string; grantedScopes: string[] }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const body = (await res.json()) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!body.access_token) {
    throw new Error(body.error_description ?? body.error ?? "token exchange failed");
  }
  return { token: body.access_token, grantedScopes: parseGrantedScope(body.scope) };
}

/** The exchange response names granted scopes comma- and/or space-separated. */
export function parseGrantedScope(scope: unknown): string[] {
  if (typeof scope !== "string" || !scope.trim()) return [];
  return scope
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function api<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "app-builder",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function getUser(token: string): Promise<GitHubUser> {
  const u = await api<{ login: string; id: number; avatar_url?: string }>(token, "/user");
  return { login: u.login, id: u.id, avatarUrl: u.avatar_url };
}

export async function listRepos(token: string, limit = 30): Promise<GitHubRepoInfo[]> {
  const repos = await api<
    Array<{
      full_name: string;
      name: string;
      private: boolean;
      default_branch: string;
      html_url: string;
      owner: { login: string };
    }>
  >(token, `/user/repos?per_page=${Math.min(100, Math.max(1, limit))}&sort=updated`);
  return repos.map((r) => ({
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    defaultBranch: r.default_branch ?? "main",
    htmlUrl: r.html_url,
  }));
}

/**
 * Remote branch names for an arbitrary repo (used by the New-chat picker).
 * REST, not git: the repo is not cloned yet, so there is no local checkout
 * to list from. Returns at most `limit` names, default branch first. The
 * default branch is always present even when it falls outside the first page.
 */
export async function listRemoteBranches(
  token: string,
  owner: string,
  repo: string,
  limit = 100,
): Promise<{ branches: string[]; defaultBranch: string }> {
  // One round trip, not two: the metadata and branch-page requests are
  // independent. A metadata failure propagates — guessing `main` would point
  // the picker at a branch that may not exist.
  const [access, branches] = await Promise.all([
    getRepo(token, owner, repo),
    api<Array<{ name: string }>>(
      token,
      `/repos/${owner}/${repo}/branches?per_page=${Math.min(100, Math.max(1, limit))}`,
    ),
  ]);
  const names = branches.map((b) => b.name).filter((n) => typeof n === "string" && n.length > 0);
  const def = access.defaultBranch ?? "main";
  if (!names.includes(def)) names.unshift(def);
  names.sort((a, b) => (a === def ? -1 : b === def ? 1 : a.localeCompare(b)));
  return { branches: names.slice(0, limit), defaultBranch: def };
}

export async function createRepo(
  token: string,
  opts: { name: string; private?: boolean; description?: string },
): Promise<GitHubRepoInfo> {
  const name = opts.name.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    throw new Error(`invalid repo name: ${opts.name}`);
  }
  const r = await api<{
    full_name: string;
    name: string;
    private: boolean;
    default_branch: string;
    html_url: string;
    owner: { login: string };
  }>(token, "/user/repos", {
    method: "POST",
    body: JSON.stringify({
      name,
      private: opts.private ?? false,
      description: opts.description ?? "",
      auto_init: false,
    }),
  });
  return {
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    defaultBranch: r.default_branch ?? "main",
    htmlUrl: r.html_url,
  };
}

/** Parse "owner/repo" user input, tolerating common paste forms. */
export function parseRepoRef(ref: string): { owner: string; repo: string } {
  let s = ref.trim();
  // SSH form: git@github.com:owner/repo(.git)
  const ssh = s.match(/^git@[^:]+:(.+)$/);
  if (ssh) s = ssh[1] as string;
  // Strip scheme + host: https://github.com/, http://github.com/, www., trailing slashes.
  s = s
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const m = s.split("/");
  if (m.length !== 2 || !m[0] || !m[1] || !/^[\w.-]+$/.test(m[0]) || !/^[\w.-]+$/.test(m[1])) {
    throw new Error(`expected "owner/repo", got ${JSON.stringify(ref)}`);
  }
  if (m[0] === "." || m[0] === ".." || m[1] === "." || m[1] === "..") {
    throw new Error(`expected "owner/repo", got ${JSON.stringify(ref)}`);
  }
  return { owner: m[0], repo: m[1] };
}

export function remoteUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/** Best-effort cleanup: delete a repo that was created but never pushed to. */
export async function deleteRepo(token: string, owner: string, repo: string): Promise<void> {
  const res = await fetch(`${API}/repos/${owner}/${repo}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "app-builder",
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`cleanup delete failed: ${res.status}`);
  }
}

/**
 * Whether the repo already holds commits. Only the known empty-repository
 * response (409 "Git Repository is EMPTY") proves emptiness; anything else —
 * other 409s, malformed payloads, probe failures — is unknown (null), and
 * callers must fail safe since absence of evidence is not evidence of
 * emptiness.
 */
export async function repoHasCommits(token: string, owner: string, repo: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${API}/repos/${owner}/${repo}/commits?per_page=1`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "app-builder",
      },
    });
    if (res.status === 409) {
      // Only the known empty-repository response proves emptiness; any
      // other 409 stays unknown so cleanup can never delete on an
      // unrecognized API response.
      const text = await res.text().catch(() => "");
      return /git repository is empty/i.test(text) ? false : null;
    }
    if (!res.ok) return null;
    const list = (await res.json()) as unknown;
    // A 200 with an empty or malformed list is anomalous (empty repos 409),
    // so it stays unknown rather than counting as confirmed empty.
    return Array.isArray(list) && list.length > 0 ? true : null;
  } catch {
    return null;
  }
}

/**
 * Delete-branch guard for the promote path (see `deleteBranch`).
 *
 * `sourceDefaultBranch` is the source repo's actual default (fetched via
 * `getRepo` by the caller, best-effort): deleting it strands the source
 * repo, so it is always refused. The hard-coded `main`/`master` refusal only
 * applies when the default is unknown — a stale branch literally named
 * `main` in a repo whose default is e.g. `develop` is deletable. `HEAD` is
 * never a deletable branch. Deleting the branch the new repo was just
 * pushed to is refused: the names must differ.
 */
export function assertDeletableBranch(
  branch: string,
  destBranch: string | null,
  sourceDefaultBranch: string | null = null,
): void {
  if (!branch || !branch.trim()) throw new Error("branch name is required");
  if (branch === "HEAD") {
    throw new Error(`refusing to delete "HEAD": never delete a default branch through promote`);
  }
  if (sourceDefaultBranch) {
    if (branch === sourceDefaultBranch) {
      throw new Error(
        `refusing to delete ${JSON.stringify(branch)}: it is the source repo's default branch — old branch left intact`,
      );
    }
  } else if (["main", "master"].includes(branch)) {
    throw new Error(
      `refusing to delete ${JSON.stringify(branch)}: the source default is unknown, so common default names are protected — old branch left intact`,
    );
  }
  if (destBranch !== null && branch === destBranch) {
    throw new Error(
      `refusing to delete ${JSON.stringify(branch)}: it matches the new repo's default branch — old branch left intact`,
    );
  }
}

export async function deleteBranch(token: string, owner: string, repo: string, branch: string): Promise<void> {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "app-builder",
  };
  const ref = `heads/${branch.split("/").map((s) => encodeURIComponent(s)).join("/")}`;
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/refs/${ref}`, {
    method: "DELETE",
    headers,
  });
  if (res.status === 404) {
    // Ambiguous on its own: GitHub 404s a missing ref and an inaccessible
    // repo alike. Confirm with a read before calling the branch gone.
    const check = await fetch(`${API}/repos/${owner}/${repo}/git/refs/${ref}`, { headers });
    if (check.status === 404) return; // Ref truly missing: already deleted.
    if (check.ok) {
      throw new Error(
        `delete of ${owner}/${repo}@${branch} returned 404 but the branch still exists — delete it manually`,
      );
    }
    throw new Error(
      `delete of ${owner}/${repo}@${branch} returned 404 and the branch state could not be confirmed (${check.status}) — check it manually`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`delete of ${owner}/${repo}@${branch} failed: ${res.status} ${text.slice(0, 200)}`.trim());
  }
}

export type GitHubRepoAccess = {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  /** Present when the token can see the repo; false push explains clone-ok/push-403. */
  permissions?: { push: boolean; pull: boolean; admin: boolean };
};

/**
 * Read a repo as the logged-in user, surfacing auth failures as actionable
 * errors. A public repo clones fine with no write access (or even a stale
 * token, which GitHub ignores for anonymous reads), so a later push 403s
 * cryptically — callers pre-check with this to say why before git runs.
 */
export async function getRepo(token: string, owner: string, repo: string): Promise<GitHubRepoAccess> {
  const res = await fetch(`${API}/repos/${owner}/${repo}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "app-builder",
    },
  });
  if (res.status === 401) {
    throw new Error(
      `GitHub rejected the stored credential (401) for ${owner}/${repo}: the token is expired or revoked — Log out and back in on the GitHub tab, then retry`,
    );
  }
  if (res.status === 404) {
    throw new Error(
      `GitHub shows no repo ${owner}/${repo} for this login (404): it is private, deleted, or this account cannot see it — check the name or log in as a user with access`,
    );
  }
  if (res.status === 403) {
    throw new Error(
      `GitHub refused repo metadata (403) for ${owner}/${repo}: the token may lack access or be rate-limited — Log out and back in on the GitHub tab, then retry`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API /repos/${owner}/${repo} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const r = (await res.json()) as {
    full_name: string;
    private: boolean;
    default_branch: string;
    html_url: string;
    permissions?: { push: boolean; pull: boolean; admin: boolean };
  };
  return {
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch ?? "main",
    htmlUrl: r.html_url,
    permissions: r.permissions,
  };
}

/**
 * Fail fast when the push is doomed: read access (clone) does not imply
 * write access (push). Returns void when access is fine or unknowable
 * (network hiccup — let the git attempt report the real error instead).
 */
export async function assertPushAccess(
  token: string,
  owner: string,
  repo: string,
  login: string,
): Promise<void> {
  let access: GitHubRepoAccess;
  try {
    access = await getRepo(token, owner, repo);
  } catch (e) {
    // Definitive auth answers propagate; anything else (network, 5xx)
    // stays out of the way of the real git attempt.
    if (e instanceof Error && /401|404|403/.test(e.message)) throw e;
    return;
  }
  if (access.permissions && access.permissions.push === false) {
    throw new Error(
      `GitHub refused push access: @${login} can read (clone) ${owner}/${repo} but cannot push to it. ` +
        `Ask the owner for collaborator access, open a fork instead, or log in as a user with write access. ` +
        `If you can push in a browser, Log out and back in on the GitHub tab to refresh the token, then retry.`,
    );
  }
}

/**
 * OAuth scopes granted to the stored token, read from the scope headers
 * GitHub sends on authed API calls. Never throws: unknown scopes are `[]`,
 * and callers only act on a *known*-missing scope, never on unknown.
 */
export async function getTokenScopes(token: string): Promise<string[]> {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "app-builder",
  };
  // `/user` is the fallback because it is the one endpoint proven to work
  // with the stored token (login and every pre-check hit it): if scopes are
  // readable anywhere, they are readable there.
  for (const path of ["/rate_limit", "/user"]) {
    try {
      const res = await fetch(`${API}${path}`, { headers });
      if (!res.ok) continue;
      const scopes = parseScopeHeaders(res.headers);
      if (scopes.length) return scopes;
    } catch {
      /* try the next endpoint */
    }
  }
  return [];
}

function parseScopeHeaders(headers: Headers): string[] {
  const raw =
    headers.get("x-oauth-scopes") ?? headers.get("x-accepted-github-permissions") ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Read-only probe of the git Smart HTTP endpoint just-git pushes to.
 * just-git reports a failed POST as bare `HTTP <status> pushing to <url>`,
 * discarding GitHub's body — this replays the safe half (discovery GET) to
 * separate "credential rejected for git" (401) from "credential fine, the
 * pushed content was refused" (200 here + 403 on POST: workflow scope or a
 * repo rule). Never throws; network failure is `status 0`.
 */
export async function probeGitPushDiscovery(
  token: string,
  owner: string,
  repo: string,
): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(`${remoteUrl(owner, repo)}/info/refs?service=git-receive-pack`, {
      headers: {
        authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
        "user-agent": "app-builder",
      },
    });
    const body = (await res.text().catch(() => "")).slice(0, 300).trim();
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

/** True when the file set includes GitHub Actions workflow files. */
export function touchesWorkflows(fileKeys: string[]): boolean {
  return fileKeys.some((k) => k === ".github/workflows" || k.startsWith(".github/workflows/"));
}

/**
 * Fail before committing when the push is doomed by scope: a token without
 * `workflow` pushing `.github/workflows/*` is refused with 403 (verified
 * live against github.com with a repo-only OAuth token). Unknown scopes
 * never block — the git attempt reports the real error instead.
 */
export function assertWorkflowScope(scopes: string[], fileKeys: string[]): void {
  if (scopes.length > 0 && !scopes.includes("workflow") && touchesWorkflows(fileKeys)) {
    throw new Error(
      `This push touches .github/workflows/* files but the token scopes (${scopes.join(", ")}) lack \`workflow\` — GitHub refuses it with 403. Log out and back in on the GitHub tab to grant \`${OAUTH_SCOPE}\`, then retry. Nothing was committed.`,
    );
  }
}

/**
 * Precise follow-up for a failed push, computed only on failure (two small
 * read-only requests). The common trap: the REST pre-check passes (the user
 * owns the repo) yet the git POST 403s — almost always a token that predates
 * the `workflow` scope pushing workflow files, which no collaborator-access
 * message will fix.
 */
export async function diagnosePushFailure(
  token: string,
  opts: { login: string; owner: string; repo: string; fileKeys: string[] },
): Promise<string> {
  const { login, owner, repo } = opts;
  const where = `${owner}/${repo}`;
  // A GitHub-App user token explains every push 403 at once (and the
  // "unknown" live scopes — permission-model tokens send no OAuth header).
  // Return it standalone: no further probing can change the answer.
  try {
    assertGitCapableToken(token);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const workflows = touchesWorkflows(opts.fileKeys);
  const [scopes, probe] = await Promise.all([
    getTokenScopes(token),
    probeGitPushDiscovery(token, owner, repo),
  ]);
  const lines: string[] = [];
  if (scopes.length) {
    lines.push(`token scopes: ${scopes.join(", ")}`);
    if (!scopes.includes("workflow")) {
      lines.push(
        workflows
          ? `this push includes .github/workflows/* files, which GitHub rejects with 403 when the token lacks the \`workflow\` scope — Log out and back in on the GitHub tab to grant \`${OAUTH_SCOPE}\`, then retry`
          : `the token lacks the \`workflow\` scope (logins before the scope fix granted only \`repo\`) — harmless until a push touches .github/workflows/*, then GitHub 403s it; Log out and back in on the GitHub tab to grant \`${OAUTH_SCOPE}\``,
      );
    }
  } else {
    lines.push(`token scopes: unknown (could not read them — transient network issue, retry the push)`);
  }
  if (probe.status === 200) {
    lines.push(
      `git push endpoint: reachable as @${login} (discovery 200), so the credential works for git and the 403 came from the pushed content` +
        (workflows ? ` (this push touches .github/workflows/* — see scopes above)` : "") +
        ` or a repo rule (branch protection, ruleset). If re-login does not fix it, push the same commit from a desktop git client to see GitHub's exact message.`,
    );
  } else if (probe.status === 401) {
    lines.push(
      `git push endpoint: 401, the stored credential is rejected for git — Log out and back in on the GitHub tab to refresh the token, then retry`,
    );
  } else if (probe.status === 403) {
    lines.push(
      `git push endpoint: 403 even for discovery${probe.body ? ` — GitHub says: ${probe.body}` : ""} — Log out and back in on the GitHub tab, then retry`,
    );
  } else if (probe.status > 0) {
    lines.push(`git push endpoint: ${probe.status}${probe.body ? ` ${probe.body}` : ""}`);
  }
  return `Push diagnostics for @${login} on ${where}:\n- ` + lines.join("\n- ");
}
