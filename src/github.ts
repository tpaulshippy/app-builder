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
    scope: "repo",
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

/** Exchange an OAuth code for a user token. */
export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string> {
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
    error?: string;
    error_description?: string;
  };
  if (!body.access_token) {
    throw new Error(body.error_description ?? body.error ?? "token exchange failed");
  }
  return body.access_token;
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

/** Parse "owner/repo" user input. */
export function parseRepoRef(ref: string): { owner: string; repo: string } {
  const m = ref.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").split("/");
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
