import { AppSession } from "./session";
import { resolveAuth, resolveSession, withSession } from "./server/auth";
import { handleFiles } from "./routes/files";
import { handleChats } from "./routes/chats";
import { handleApps } from "./routes/apps";
import { handleChat } from "./routes/chat";
import { handleGithubAuth } from "./routes/github-auth";
import { handleShare } from "./routes/share";
import { handleGithubRepos } from "./routes/github-repos";
import { handleGit } from "./routes/git";
import { page } from "./server/page";

export interface Env {
  APP: DurableObjectNamespace<AppSession>;
  /** Server-side fallback; browsers normally send their own key per request. */
  OPENCODE_ZEN_KEY?: string;
  /** Owned lakebed deploys; anonymous when unset. */
  LAKEBED_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** R2 bucket for chat image attachments (bytes live here, not in DO SQLite). */
  IMAGES?: R2Bucket;
}

export { AppSession };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cookieSession = resolveSession(req);
    const resolved = await resolveAuth(env, cookieSession);
    const session = resolved.session;
    const stub = resolved.stub as unknown as DurableObjectStub<AppSession>;

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
      return new Response(page(), { headers: withSession(headers, session) });
    }

    const ctx = { url, env, session, stub };
    return (
      (await handleFiles(req, ctx)) ??
      (await handleChats(req, ctx)) ??
      (await handleApps(req, ctx)) ??
      (await handleChat(req, ctx)) ??
      (await handleGithubAuth(req, ctx)) ??
      (await handleShare(req, ctx)) ??
      (await handleGithubRepos(req, ctx)) ??
      (await handleGit(req, ctx)) ??
      new Response("not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
