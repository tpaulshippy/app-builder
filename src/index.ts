import { AppSession, type ChatMessage, type FileMap } from "./session";
import { canonicalIdForGithubUser, isCanonicalId, parseSessionValue } from "./session-key";
import { isSafePath } from "./paths";
import { DEFAULT_GATEWAY, DEFAULT_MODEL, GO_MODELS, TOOL_TIMEOUT_MS, ZEN_MODELS, withToolTimeout } from "./agent";
import { APP_SHIM_JS } from "./app-shim";
import { buildAppBundle } from "./lakebed";
import type { AppKind, AppState } from "./app-runtime";
import {
  createRepo,
  deleteRepo,
  exchangeCode,
  getTokenScopes,
  getUser,
  listRemoteBranches,
  listRepos,
  loginUrl,
  parseRepoRef,
  remoteUrl,
  requireEnv,
  tokenKind,
} from "./github";
import type { GitHubUser } from "./github";
import { MEMBER_COOKIE, turnBusyError } from "./share";
import type { ShareState } from "./share";
import { isWorktreeKey } from "./gitops";
import { inlineLocalAssets, pickPreviewHtml, resolveAssetRef } from "./preview-assets";
import { markdownToHtml } from "./markdown";
import { isImageId, validateImageInput, validateImageRefs } from "./images";

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

import {
  APP_CORS,
  LOGIN_REQUIRED,
  LOGIN_STATE_COOKIE,
  SESSION_COOKIE,
  SID_RE,
  corsJson,
  parseInviteCode,
  readCookie,
  requireAccess,
  requireLogin,
  resolveAuth,
  resolveSession,
  resolveSid,
  resolveSidForRequest,
  sessionJson,
  stubShare,
  turnConflict,
  withMember,
  withSession,
} from "./server/auth";
import type { Access, AuthStub, StubLike } from "./server/auth";
import { handleFiles } from "./routes/files";
import { handleChats } from "./routes/chats";
import { handleApps } from "./routes/apps";
import { handleChat } from "./routes/chat";
import { handleGithubAuth } from "./routes/github-auth";
import { handleShare } from "./routes/share";
import { handleGithubRepos } from "./routes/github-repos";
import { handleGit } from "./routes/git";
import { appDoc } from "./server/page";
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

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;


const page = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>app-builder</title>
<style>
  :root {
    --bg:#08090a; --panel:#0e1011; --panel2:#141617; --edge:#232627;
    --fg:#e8eaeb; --dim:#7d8285; --faint:#4a4f52; --accent:#d8f06a;
    --ok:#7ee787; --err:#ff7b72; --warn:#e3b341;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; margin:0; }
  body { background:var(--bg); color:var(--fg); font:13px/1.55 var(--sans); display:flex; flex-direction:column; overflow:hidden;
         height:100vh; height:100dvh; }

  /* top bar */
  header { display:flex; align-items:center; gap:2px; padding:0 10px; min-height:38px;
           border-bottom:1px solid var(--edge); background:var(--panel); flex:0 0 auto;
           overflow-x:auto; scrollbar-width:none; white-space:nowrap; }
  header::-webkit-scrollbar { display:none; }
  .tab { padding:5px 11px; border-radius:6px; color:var(--dim); cursor:pointer; font-size:12.5px; }
  .tab:hover { background:var(--panel2); color:var(--fg); }
  .tab[aria-selected="true"] { background:var(--panel2); color:var(--fg); }
  .tab.add { color:var(--faint); }
  .metrics { margin-left:auto; display:flex; gap:16px; align-items:center;
             font:10.5px/1 var(--mono); text-transform:uppercase; letter-spacing:.6px; color:var(--faint); }
  .metrics b { color:var(--dim); font-weight:600; }
  .metrics .built { color:var(--ok); text-transform:none; letter-spacing:0; font-size:11.5px; }
  .metrics .failed { color:var(--err); text-transform:none; letter-spacing:0; font-size:11.5px; }

  /* single-pane layout: one tab visible at a time */
  main { flex:1; display:flex; flex-direction:column; min-height:0; min-width:0; }
  #chat[hidden], #pane[hidden] { display:none; }

  /* chat view */
  #chat { flex:1; border:0; display:flex; flex-direction:column; min-height:0; min-width:0; background:var(--bg); }
  #chathdr, #log, #composer { width:100%; max-width:880px; margin-left:auto; margin-right:auto; }
  #chathdr { display:flex; align-items:center; gap:8px; padding:8px 14px 0; flex:0 0 auto; min-width:0;
             overflow:hidden; white-space:nowrap;
             font:10px/1 var(--mono); text-transform:uppercase; letter-spacing:1px; color:var(--faint); }
  #chathdr > span:first-child { flex:0 0 auto; }
  #newchat { margin-left:auto; background:transparent; color:var(--dim); border:1px solid var(--edge);
             border-radius:6px; padding:4px 9px; font:10.5px/1.4 var(--mono); cursor:pointer;
             flex:0 0 auto; white-space:nowrap; }
  #newchat:hover { color:var(--fg); border-color:#3a4043; }
  #newchat:disabled { opacity:.4; cursor:default; }
  #history { padding:16px 20px; max-width:880px; width:100%; margin:0 auto; overflow-y:auto; }
  #history .hrow { display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap; }
  #history .hhead { font:10px/1 var(--mono); text-transform:uppercase; letter-spacing:1px;
           color:var(--faint); margin:2px 0 8px; }
  #history input { flex:1; background:var(--panel); border:1px solid var(--edge); border-radius:6px;
           color:var(--fg); padding:5px 8px; font:11.5px var(--sans); }
  #history button { background:var(--panel2); color:var(--fg); border:1px solid var(--edge);
           border-radius:6px; padding:5px 10px; font-size:11.5px; cursor:pointer; }
  #history button.primary { background:var(--accent); color:#111; border:0; font-weight:600; }
  #history button:disabled { opacity:.45; cursor:default; }
  #history .item .repo { display:inline-block; font:10px/1.6 var(--mono); color:var(--accent);
           border:1px solid var(--edge); border-radius:5px; padding:1px 7px; margin-top:4px; }
  #history select { background:var(--panel); border:1px solid var(--edge); border-radius:6px;
           color:var(--fg); padding:5px 8px; font-size:11.5px; max-width:100%; }
  #repobadge { flex:0 0 auto; background:transparent; cursor:pointer; font:13px/1 var(--mono);
           color:var(--accent); border:1px solid var(--edge); border-radius:5px; padding:3px 7px; }
  #repobadge:hover { color:var(--fg); border-color:#3a4043; }
  #repobadge.none { color:var(--faint); }
  #history .item { border:1px solid var(--edge); border-radius:7px; padding:7px 9px; margin-bottom:6px;
           background:var(--panel); }
  #history .item .t { font-size:12.5px; font-weight:600; cursor:pointer; }
  #history .item .t:hover { text-decoration:underline; }
  #history .item .t:focus-visible { outline:1px solid var(--accent); outline-offset:2px; }
  #history button.icon { padding:5px 9px; font-size:14px; line-height:1; }
  #history .item .m { font:10.5px/1.5 var(--mono); color:var(--faint); margin-top:2px; }
  #history .item .p { font-size:12px; color:var(--dim); margin-top:3px;
           white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #log { flex:1; overflow-y:auto; padding:14px 14px 8px; min-width:0; }
  .who { font:10px/1 var(--mono); text-transform:uppercase; letter-spacing:1px; color:var(--faint); margin:2px 0 8px; }
  .msg { margin:0 0 14px; white-space:pre-wrap; overflow-wrap:anywhere; min-width:0; }
  .msg.user { color:var(--fg); }
  .msg.agent { color:#c9ced1; white-space:normal; }
  .msg.agent p { margin:0 0 8px; }
  .msg.agent p:last-child { margin-bottom:0; }
  .msg.agent h1, .msg.agent h2, .msg.agent h3, .msg.agent h4 { margin:10px 0 6px; line-height:1.3; }
  .msg.agent h1:first-child, .msg.agent h2:first-child, .msg.agent h3:first-child, .msg.agent p:first-child { margin-top:0; }
  .msg.agent h1 { font-size:15px; } .msg.agent h2 { font-size:14px; }
  .msg.agent h3, .msg.agent h4 { font-size:13px; }
  .msg.agent ul, .msg.agent ol { margin:4px 0 8px 18px; padding:0; }
  .msg.agent li { margin:2px 0; }
  .msg.agent code { font-family:var(--mono); font-size:12px; background:var(--panel2);
    border:1px solid var(--edge); border-radius:5px; padding:1px 5px; overflow-wrap:anywhere; }
  .msg.agent pre { background:var(--panel); border:1px solid var(--edge); border-radius:7px;
    padding:9px 11px; overflow:auto; margin:6px 0 10px; }
  .msg.agent pre code { background:transparent; border:0; padding:0; white-space:pre; display:block; }
  .msg.agent blockquote { border-left:2px solid var(--edge); margin:4px 0 8px; padding:2px 0 2px 10px; color:var(--dim); }
  .msg.agent a { color:var(--accent); }
  .msg.agent hr { border:0; border-top:1px solid var(--edge); margin:10px 0; }
  .msg.agent strong { color:var(--fg); }
  .tool { display:flex; gap:7px; align-items:flex-start; color:var(--dim); font-size:12.5px; margin:3px 0; min-width:0; }
  .tool .mark { color:var(--ok); font-family:var(--mono); flex:0 0 auto; }
  .tool > span:last-child { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; white-space:pre-wrap; }
  .tool.bad .mark { color:var(--err); }
  .model { font:10.5px/1 var(--mono); text-transform:uppercase; letter-spacing:.7px; color:var(--faint); margin:6px 0 2px; }
  .err { color:var(--err); font-size:12.5px; }
  .thinking { color:var(--faint); font-style:italic; }

  #composer { flex:0 0 auto; padding:8px 12px 12px; }
  #box { border:1px solid var(--edge); border-radius:10px; background:var(--panel); padding:9px 10px 7px;
         min-width:0; overflow:hidden; }
  #input { width:100%; border:0; outline:0; resize:none; background:transparent; color:var(--fg);
           font:13px/1.5 var(--sans); min-height:38px; max-height:140px; }
  #input::placeholder { color:var(--faint); }
  .crow { display:flex; align-items:center; gap:4px; margin-top:2px; min-width:0; flex-wrap:nowrap; }
  .crow > * { min-width:0; }
  .badge { display:flex; align-items:center; gap:5px; font:10.5px/1 var(--mono); color:var(--dim); }
  .badge .star { color:var(--accent); font-size:12px; }
  #send { margin-left:auto; width:32px; height:32px; border-radius:50%; border:0; cursor:pointer;
          background:var(--accent); color:#111; font-size:16px; line-height:1; display:grid; place-items:center;
          flex:0 0 auto; }
  #send:disabled { opacity:.4; cursor:default; }
  #box:focus-within { border-color:#3a4043; }
  #gh #apikey { background:var(--panel); border:1px solid var(--edge); border-radius:6px;
           color:var(--fg); padding:6px 9px; font:12.5px var(--sans); min-width:220px; flex:1; }
  #gh #apikey::placeholder { color:var(--faint); }
  #gh #gateway { background:var(--panel); color:var(--fg); border:1px solid var(--edge);
            border-radius:6px; padding:6px 9px; font:12.5px var(--sans); min-width:0; max-width:160px; }
  #model { flex:1 1 auto; min-width:0; max-width:none; background:transparent; color:var(--dim);
            border:0; outline:0; padding:6px 2px; font:13px/1.5 var(--sans); cursor:pointer;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #attach { background:transparent; color:var(--fg); border:0; border-radius:8px; width:32px; height:32px;
            font-size:22px; line-height:1; cursor:pointer; flex:0 0 auto; display:grid; place-items:center; }
  #attach:hover { color:var(--accent); }
  #attach:disabled { opacity:.4; cursor:default; }
  #pending { display:flex; gap:8px; flex-wrap:wrap; margin-top:6px; }
  #pending[hidden] { display:none; }
  #pending .thumb { position:relative; width:64px; height:64px; border:1px solid var(--edge);
            border-radius:8px; overflow:hidden; background:var(--panel2); flex:0 0 auto; }
  #pending .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
  #pending .thumb button { position:absolute; top:2px; right:2px; width:18px; height:18px; border-radius:50%;
            border:0; background:rgba(0,0,0,.65); color:#fff; font-size:11px; line-height:1; cursor:pointer; }
  #pending .thumb .thumbwait { width:100%; height:100%; display:grid; place-items:center;
            color:var(--faint); font-size:18px; }
  #pending .thumb.uploading { opacity:.5; }
  .msg .imgs { display:flex; gap:8px; flex-wrap:wrap; margin-top:6px; }
  .msg .imgs img { max-width:min(100%, 320px); max-height:220px; border:1px solid var(--edge);
            border-radius:8px; display:block; object-fit:contain; background:var(--panel); }

  /* content pane (preview / code / database / logs) */
  #pane { flex:1; overflow-y:auto; overflow-x:hidden; position:relative; min-height:0; min-width:0; }
  #appwrap { position:absolute; inset:0; }
  #appwrap iframe { width:100%; height:100%; border:0; display:block; background:#08090a; }
  #preview { padding:26px 30px; }
  #preview h1 { font-size:20px; margin:0 0 4px; letter-spacing:-.2px; }
  #preview .muted { color:var(--dim); margin:0 0 18px; font-size:13px; }
  #preview ul { list-style:none; padding:0; margin:0; }
  #preview li { border:1px solid var(--edge); background:var(--panel); border-radius:7px;
                padding:9px 12px; margin-bottom:6px; }
  #logs { padding:10px 14px; font:12px/1.6 var(--mono); white-space:pre-wrap; color:var(--dim); }
  #logs .warn { color:var(--warn); } #logs .error { color:var(--err); }
  .empty { color:var(--faint); padding:40px 30px; }
  .banner { background:rgba(255,123,114,.07); border:1px solid rgba(255,123,114,.35);
            border-radius:7px; padding:11px 13px; color:#ffa39b; font:12px/1.6 var(--mono);
            white-space:pre-wrap; margin:0 30px 16px; }
  .banner b { color:var(--err); }
  /* type errors never block the build, so they get their own amber strip
     rather than reusing the red build-failure banner. */
  .diag { background:rgba(227,179,65,.07); border:1px solid rgba(227,179,65,.35);
            border-radius:7px; padding:11px 13px; color:#e8d5a2; font:12px/1.6 var(--mono);
            white-space:pre-wrap; margin:12px 16px 0; }
  .diag b { color:var(--warn); }

  /* code view */
  #code { display:grid; grid-template-columns:180px 1fr; height:100%; min-height:0; min-width:0; }
  #tree { border-right:1px solid var(--edge); overflow:auto; padding:8px 0; background:var(--panel); }
  #tree div { padding:5px 12px; cursor:pointer; color:var(--dim); font:12px var(--mono); }
  #tree div[aria-current="true"] { background:var(--panel2); color:var(--fg); }
  #editor { border:0; outline:0; resize:none; width:100%; height:100%; max-width:100%; padding:14px 16px;
            background:var(--bg); color:var(--fg); font:12.5px/1.65 var(--mono); tab-size:2; }
  #savebar { position:absolute; right:18px; bottom:16px; display:flex; gap:8px; align-items:center; }
  #snapname { background:var(--panel); border:1px solid var(--edge); border-radius:6px;
           color:var(--fg); padding:6px 9px; font:12px var(--sans); width:170px; }
  #snapbtn { background:var(--panel2); color:var(--fg); border:1px solid var(--edge);
           border-radius:6px; padding:6px 12px; font-size:12px; cursor:pointer; white-space:nowrap; }
  #snapbtn:disabled { opacity:.45; cursor:default; }
  #save { background:var(--accent); color:#111; border:0; border-radius:6px; padding:6px 13px;
          font-weight:600; font-size:12px; cursor:pointer; }
  /* github panel */
  #gh { padding:22px 26px; max-width:640px; overflow:auto; height:100%; }
  #gh h2 { font-size:15px; margin:0 0 4px; }
  #gh p.hint { color:var(--dim); margin:0 0 14px; font-size:12.5px; }
  #gh .row { display:flex; gap:8px; align-items:center; margin:8px 0; flex-wrap:wrap; }
  #gh input[type=text] { background:var(--panel); border:1px solid var(--edge); border-radius:6px;
    color:var(--fg); padding:6px 9px; font:12.5px var(--sans); min-width:220px; }
  #gh button { background:var(--panel2); color:var(--fg); border:1px solid var(--edge);
    border-radius:6px; padding:6px 12px; font-size:12px; cursor:pointer; }
  #gh button.primary { background:var(--accent); color:#111; border:0; font-weight:600; }
  #gh button:disabled { opacity:.45; cursor:default; }
  #gh pre.out { background:var(--panel); border:1px solid var(--edge); border-radius:7px;
    padding:10px 12px; font:11.5px/1.6 var(--mono); white-space:pre-wrap; color:var(--dim);
    max-height:220px; overflow:auto; }
  #gh .repo { padding:6px 10px; border:1px solid var(--edge); border-radius:6px; margin:4px 0;
    cursor:pointer; color:var(--dim); font:12px var(--mono); }
  #gh .repo:hover { color:var(--fg); background:var(--panel2); }
  #gh .subtabs { display:flex; gap:6px; margin:12px 0 16px; flex-wrap:wrap; }
  #gh .subtab { background:transparent; border:1px solid var(--edge); border-radius:16px;
    padding:6px 13px; font-size:12px; color:var(--dim); cursor:pointer; }
  #gh .subtab[aria-selected="true"] { background:var(--accent); color:#111; border-color:transparent; font-weight:600; }
  #gh .card { border:1px solid var(--edge); background:var(--panel); border-radius:8px;
    padding:12px 13px; margin:10px 0; }
  #gh .card h3 { margin:0 0 4px; font-size:13px; }
  #gh .card p.hint { margin:0 0 10px; }
  #gh .check { display:inline-flex; gap:6px; align-items:center; font-size:12.5px;
    color:var(--dim); white-space:nowrap; cursor:pointer; }
  #gh .check input { accent-color:var(--accent); width:15px; height:15px; }
  #gh details.tok { margin:6px 0 0; }
  #gh details.tok summary { cursor:pointer; color:var(--dim); font-size:12px; }
  #gh .savefoot { position:sticky; bottom:0; background:var(--bg); padding:10px 0 4px;
    border-top:1px solid var(--edge); margin-top:10px; }

  /* login gate: anonymous visitors see this instead of the app */
  #gate { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
         gap:10px; text-align:center; padding:40px 24px; min-height:0; }
  #gate[hidden] { display:none; }
  #gate h1 { font-size:24px; margin:0 0 2px; letter-spacing:-.3px; }
  #gate p { color:var(--dim); margin:0 0 8px; max-width:440px; }
  #gate button.primary { background:var(--accent); color:#111; border:0; border-radius:8px;
         padding:10px 18px; font-weight:600; font-size:14px; cursor:pointer; }
  #gate .hint { font-size:12px; color:var(--faint); }

  /* iOS Safari auto-zooms on focus when the field is <16px. Keep 16px on touch. */
  @media (pointer:coarse), (max-width:768px) {
    body { font-size:16px; }
    input, textarea, select, button { font-size:16px; }
    #input, #apikey, #editor, #snapname { font-size:16px; }
    #history input, #history button, #history button.icon, #history select,
    #gateway, #gh #gateway, #model, #gh input, #gh input[type=text], #gh input[type=password], #gh button, #gh #apikey,
    #snapbtn, #save, #send, #attach, #newchat, #repobadge,
    #gate button.primary { font-size:16px; }
  }

  /* Narrow screens (iPhone SE is 375px): one tab fills the screen, hide
     non-essential header stats, enlarge touch targets, respect the notch. */
  @media (max-width:768px) {
    header { padding-top:env(safe-area-inset-top); }
    .metrics { gap:10px; }
    .metrics span:not(#m-built) { display:none; }
    .tab.add { display:none; }
    .tab { padding:10px 12px; }
    #chat, #pane { flex:1; min-height:0; }
    #composer { padding-bottom:calc(8px + env(safe-area-inset-bottom)); }
    #send { width:40px; height:40px; font-size:18px; flex:0 0 auto; }
    #attach { width:40px; height:40px; }
    #preview { padding:16px; }
    .banner { margin:0 16px 12px; }
    #code { grid-template-columns:1fr; grid-template-rows:auto 1fr; }
    #tree { display:flex; overflow-x:auto; border-right:0; border-bottom:1px solid var(--edge); padding:4px 6px; }
    #tree div { white-space:nowrap; padding:10px 12px; }
    #savebar { right:12px; bottom:12px; }
    #save { padding:12px 18px; }
  }
</style>
</head>
<body>
<header>
  <span class="tab" data-view="chat" role="tab" tabindex="0" aria-selected="true">Chat</span>
  <span class="tab" data-view="history" role="tab" tabindex="0">History</span>
  <span class="tab" data-view="preview" role="tab" tabindex="0">Preview</span>
  <span class="tab" data-view="code" role="tab" tabindex="0">Code</span>
  <span class="tab" data-view="database" role="tab" tabindex="0" style="display:none">Database</span>
  <span class="tab" data-view="logs" role="tab" tabindex="0">Logs</span>
  <span class="tab" data-view="github" role="tab" tabindex="0">Settings</span>
  <span class="tab add">+</span>
  <div class="metrics">
    <span>process ram <b>—</b></span>
    <span>process cpu <b>—</b></span>
    <span>typecheck <b>—</b></span>
    <span>bundle <b id="m-bundle">—</b></span>
    <span id="m-built" class="built">idle</span>
  </div>
</header>
<main>
  <section id="chat">
    <div id="chathdr"><span>Chat</span><button id="repobadge" class="none" title="No repo linked — tap to open Settings" aria-label="Linked repo — open Settings">⎇</button><button id="newchat" title="Clear agent context (code is kept)">New chat</button></div>
    <div id="log"></div>
    <div id="composer">
      <div id="box">
        <textarea id="input" placeholder="What do you want to build? (paste images to attach — Enter for newline, ⌘/Ctrl+Enter to send)" rows="2" enterkeyhint="enter"></textarea>
        <div id="pending" hidden></div>
        <div class="crow">
          <button id="attach" title="Attach images (png/jpeg/webp/gif, max 4)" aria-label="Attach images">+</button>
          <input id="filepick" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />
          <select id="model" title="Model"></select>
          <button id="send" title="Send (⌘/Ctrl+Enter)" aria-label="Send">↑</button>
        </div>
      </div>
    </div>
  </section>
  <div id="pane" hidden></div>
  <section id="gate" hidden>
    <h1>app-builder</h1>
    <p>Log in with GitHub to use Chat, Code, Preview, Database and Logs.</p>
    <button id="loginbtn" class="primary">Log in with GitHub</button>
    <p class="hint">OAuth; token stays server-side.</p>
  </section>
</main>
<script>
const GATEWAYS = { zen: ${JSON.stringify(ZEN_MODELS)}, go: ${JSON.stringify(GO_MODELS)} };
const DEFAULT_GATEWAY = ${JSON.stringify(DEFAULT_GATEWAY)};
const DEFAULT_MODEL = ${JSON.stringify(DEFAULT_MODEL)};
const log = document.getElementById("log");

// Surface script errors in the transcript. Without this a throw before the
// first render leaves the page silently idle.
window.addEventListener("error", (e) => {
  // Third-party scripts injected into the page (wallet shims, extensions,
  // antivirus/proxy injectors) run cross-origin, so their throws reach us
  // sanitized as "Script error." with no file or line. Our own inline script
  // always reports a filename, so a filenameless "Script error." cannot be
  // ours. Not actionable — drop it instead of alarming the transcript.
  if (e.message === "Script error." && !e.filename) {
    console.debug("ignored cross-origin script error");
    return;
  }
  const msg = e.message || String(e.error);
  // Brave on iOS injects a wallet script into every page that throws on
  // "window.ethereum.selectedAddress = undefined" because no provider is
  // injected. Not ours, not actionable. brave-ios#6656.
  if (msg.includes("ethereum.selectedAddress")) return;
  // Chrome on iOS injects GCrWeb helpers (__gCrWeb.*) into every page; when
  // they throw, window.onerror attributes them to our inline script. Not
  // ours, not actionable.
  if (msg.includes("__gCrWeb")) return;
  const n = document.createElement("div");
  n.className = "err";
  n.textContent = "js error: " + msg;
  log.appendChild(n);
});
const pane = document.getElementById("pane");
// Static-html Preview helpers (pure, unit-tested in tests/preview-assets.test.ts;
// serialized here so the page and the tests run the same code).
${pickPreviewHtml}
${resolveAssetRef}
${inlineLocalAssets}
// Assistant markdown (pure, unit-tested in tests/markdown.test.ts; serialized
// here so the page and the tests run the same code).
// The worker TS transform wraps nested helpers with __name(), which has no
// browser definition — the identity shim below is what that helper does.
var __name = (fn) => fn;
${markdownToHtml}
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
// The API key field lives in the Settings tab (renderGitHub): localStorage is
// the source of truth, the input just edits it when that tab is rendered.
const readApiKey = () => {
  const field = document.getElementById("apikey");
  const v = (field && field.value) || localStorage.getItem("ab_key") || "";
  return v.trim();
};
const modelSel = document.getElementById("model");
// Gateway (zen vs go) lives in Settings; localStorage is the source of truth
// so the composer works even when that tab was never rendered.
function getGateway() {
  const g = localStorage.getItem("ab_gateway") || DEFAULT_GATEWAY;
  return GATEWAYS[g] ? g : DEFAULT_GATEWAY;
}
// Paid models only: free *-free previews 403 outside the OpenCode client.
function fillModels(gw, keep) {
  const list = GATEWAYS[gw] || GATEWAYS[DEFAULT_GATEWAY];
  modelSel.innerHTML = "";
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m; o.textContent = m;
    modelSel.appendChild(o);
  }
  modelSel.value = list.includes(keep) ? keep : list[0];
}
function setGateway(gw) {
  if (!GATEWAYS[gw]) gw = DEFAULT_GATEWAY;
  localStorage.setItem("ab_gateway", gw);
  fillModels(gw, modelSel.value);
  localStorage.setItem("ab_model", modelSel.value);
  const sel = document.getElementById("gateway");
  if (sel && sel.value !== gw) sel.value = gw;
}
fillModels(getGateway(), localStorage.getItem("ab_model") || DEFAULT_MODEL);
modelSel.onchange = () => localStorage.setItem("ab_model", modelSel.value);
const mBundle = document.getElementById("m-bundle");
const mBuilt = document.getElementById("m-built");

let view = "chat"; // single tab row: chat | history | preview | code | database | logs | github
let files = { "server/index.ts": "" };
let activeFile = "server/index.ts";
// Selected html file for Preview when the repo has no capsule.
let activePreview = null;
let built = null;
let busy = false;
// True from first paint until the boot status/state round-trip settles: the
// transcript shows a loading row meanwhile, and send stays off.
let booting = true;
// Anonymous until the boot status check (or any 401) says otherwise: the
// gate replaces every app view and hides its tabs, GitHub tab excepted.
let authed = false;
const gate = document.getElementById("gate");
const loginBtn = document.getElementById("loginbtn");
if (loginBtn) loginBtn.onclick = () => { window.location.href = "/api/github/login"; };
// The mounted preview iframe, if any: it reports login loss it sees first.
let appFrameEl = null;
// The sandboxed preview cannot reach apiFetch, so its shim posts an expiry
// message instead (source-checked: opaque-origin frames report "null").
window.addEventListener("message", (e) => {
  if (!e.data || e.data !== "app-builder:auth-required") return;
  if (!appFrameEl || e.source !== appFrameEl.contentWindow) return;
  if (authed) showGate();
});

/** Hide the app tabs until the visitor logs in; the GitHub tab stays. */
function syncGateTabs() {
  document.querySelectorAll("[data-view]").forEach((t) => {
    if (t.dataset.view === "github") return;
    t.style.display = authed ? "" : "none";
  });
  syncCapsuleTabs();
}

/** A repo counts as a capsule when it has both entries the capsule runtime needs. */
function hasCapsuleFiles() {
  return "server/index.ts" in files && "client/index.tsx" in files;
}

/**
 * The Database and Logs tabs only apply to capsule repos: without a server entry
 * there is no isolate state or console output to show, so the tabs stay hidden
 * and the pane falls back to Preview. Runs on every render, since opening
 * another repo can gain or lose the capsule entries at any time.
 */
function syncCapsuleTabs() {
  document.querySelectorAll('[data-view="database"], [data-view="logs"]').forEach((t) => {
    t.style.display = authed && hasCapsuleFiles() ? "" : "none";
  });
  if ((view === "database" || view === "logs") && !hasCapsuleFiles()) {
    view = "preview";
    syncTabs();
  }
}

/** Drop to the login gate, unmounting the preview frame so its shim stops polling. */
function showGate() {
  authed = false;
  syncGateTabs();
  appFrameEl = null;
  pane.innerHTML = "";
  // Drop the cached login state: the GitHub view renders from this cache,
  // and stale connected state would show authenticated controls after logout.
  ghStatus = null;
  ghMsg = "";
  ghRepos = [];
  ghResetBranches();
  ghClearBranchDrafts();
  updateRepoBadge(null);
  renderPane();
}

/**
 * A login-required 401 anywhere drops the app back to the gate. Both 401
 * shapes are recognized: the cookie APIs error string and the sid
 * endpoints ok-false error object.
 */
function noteLoginRequired(body) {
  const lost = !!body && (body.error === "github login required" ||
    (body.ok === false && body.error && body.error.message === "github login required"));
  if (lost && authed) showGate();
  return lost;
}

/** Authenticated API fetch: same as fetch, but a lost login shows the gate. */
async function apiFetch(url, init) {
  const r = await fetch(url, init);
  if (r.status === 401) {
    try { noteLoginRequired(await r.clone().json()); } catch { /* non-JSON 401: not ours */ }
  }
  return r;
}
// Bumped on every successful build so the app iframe reloads against fresh
// files. The iframe is otherwise left alone (remounts wipe its UI state).
let appV = 0;

const sessionId = () => {
  const m = document.cookie.match(/(?:^|; *)ab_session=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
};

/**
 * Preview capability for the cookieless iframe (see /api/share/preview):
 * minted per mount by the authenticated parent. The token rides the frame
 * URL (which already carries the sid); page scripts never need to read it.
 */
async function previewToken() {
  const r = await apiFetch("/api/share/preview", { method: "POST" }).then((r) => r.json());
  if (r.error) throw new Error(r.error);
  if (!r.preview) throw new Error("preview token missing");
  return r.preview;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ---------- chat transcript ---------- */
function userImages(m) {
  return Array.isArray(m && m.images) ? m.images.filter((img) => img && img.id && img.mimeType) : [];
}
function appendImages(container, images) {
  if (!images.length) return;
  const wrap = el("div", "imgs");
  for (const img of images) {
    const pic = document.createElement("img");
    pic.src = "/api/images/" + encodeURIComponent(img.id);
    pic.alt = "attached image";
    pic.loading = "lazy";
    wrap.appendChild(pic);
  }
  container.appendChild(wrap);
}
function addUser(text, images, author) {
  log.appendChild(el("div", "who", author ? author : "you"));
  const bubble = el("div", "msg user", text);
  appendImages(bubble, images || []);
  log.appendChild(bubble);
  scroll();
}
function addThinking() {
  const n = el("div", "msg thinking", "thinking…");
  log.appendChild(n); scroll();
  return n;
}
function addTool(name, detail, ok) {
  const row = el("div", ok === false ? "tool bad" : "tool");
  row.appendChild(el("span", "mark", ok === false ? "✗" : "✓"));
  row.appendChild(el("span", null, detail || name));
  if (ok !== false && detail) row.title = detail;
  log.appendChild(row);
  scroll();
}
function addAgent(text, badge) {
  const bubble = el("div", "msg agent", null);
  bubble.innerHTML = markdownToHtml(text);
  log.appendChild(bubble);
  // Restored history passes badge=false: the badge names the picker's
  // current gateway/model, which may differ from what wrote the history.
  if (badge !== false) {
    const m = el("div", "model", "✳ " + getGateway() + "/" + modelSel.value);
    log.appendChild(m);
  }
  scroll();
}
function addError(text) {
  log.appendChild(el("div", "msg err", text));
  scroll();
}
function scroll() { log.scrollTop = log.scrollHeight; }

// Restored on every load so a refresh no longer hides the context the agent
// still carries. Tool turns are skipped: they are noise in a restored view.
function renderHistory(messages) {
  log.innerHTML = "";
  // The agent persists narration twice per tool round (once as prose, once
  // paired with its tool calls), so consecutive identical assistant turns are
  // one message stored twice. Render it once; reset on user turns so a
  // genuinely repeated answer across turns still shows.
  let lastAgent = null;
  for (const m of messages || []) {
    if (m.role === "user") {
      // Shared playgrounds attribute each turn to its author.
      addUser(m.content, userImages(m), m.author);
      lastAgent = null;
    } else if (m.role === "assistant" && m.content && m.content.trim()) {
      if (m.content === lastAgent) continue;
      lastAgent = m.content;
      addAgent(m.content, false);
    }
  }
  scroll();
}
const newchatBtn = document.getElementById("newchat");
if (newchatBtn) {
  newchatBtn.onclick = async () => {
    if (busy) return;
    newchatBtn.disabled = true;
    try {
      const r = await apiFetch("/api/clear-chat", { method: "POST" });
      if (!r.ok) throw new Error("clear failed: " + r.status);
      log.innerHTML = "";
      log.appendChild(el("div", "msg thinking", "Context cleared — starting fresh. Code unchanged."));
    } catch (e) {
      addError(e.message ?? String(e));
    } finally {
      newchatBtn.disabled = false;
    }
  };
}

/* ---------- session history: named checkpoints of chat + files ---------- */
const repoBadge = document.getElementById("repobadge");
/** Short label for a linked/snapshot repo, or "no repo". */
function repoLabel(r) {
  return r && r.owner && r.repo ? (r.owner + "/" + r.repo + "@" + (r.branch || "main")) : "no repo";
}
/** Chat header icon reflecting the currently linked repo (tap opens Settings). */
function updateRepoBadge(linked) {
  if (!repoBadge) return;
  repoBadge.textContent = "⎇";
  const has = !!(linked && linked.owner);
  repoBadge.title = has
    ? ("Linked repo: " + repoLabel(linked) + " — tap to open Settings")
    : "No repo linked — tap to open Settings";
  repoBadge.setAttribute("aria-label", repoBadge.title);
  repoBadge.className = has ? "linked" : "none";
}
if (repoBadge) {
  repoBadge.onclick = () => { view = "github"; syncTabs(); renderPane(); };
}
async function loadChats() {
  // History lives in its own top-level tab: the panel is rendered into the
  // pane on each visit, so there is no embedded collapsible to toggle.
  const historyPanel = document.getElementById("history");
  if (!historyPanel) return;
  // Action failures must surface where the user is looking: the Chat
  // transcript is hidden while this tab is active, so errors go to the
  // panel itself.
  function historyError(text) {
    const n = el("div", "msg err", text);
    historyPanel.appendChild(n);
    n.scrollIntoView();
  }
  historyPanel.innerHTML = "";
  historyPanel.appendChild(el("div", "hhead", "Chat history"));
  // Start a new chat bound to a repo: dropdown (List my repos fills it) plus
  // a free-form owner/repo input, then POST /api/chats/start. The branch
  // picker lists remote branches for the selected repo so prototypes start
  // on the right branch without typing it.
  const prow = el("div", "hrow");
  const pick = document.createElement("select");
  pick.title = "Pick a repo for the new chat";
  const none = el("option", null, "(no repo — fresh chat)");
  none.value = "";
  pick.appendChild(none);
  const refIn = document.createElement("input");
  refIn.placeholder = "owner/repo (optional)";
  const brIn = document.createElement("input");
  brIn.placeholder = "branch";
  brIn.style.maxWidth = "90px";
  brIn.title = "Branch to open (optional — defaults to the repo default)";
  brIn.setAttribute("aria-label", "Branch to open");
  const brPick = document.createElement("select");
  brPick.title = "Pick a remote branch for the new chat";
  brPick.setAttribute("aria-label", "Pick a remote branch");
  brPick.style.maxWidth = "130px";
  async function loadNewChatBranches() {
    const sel = pick.value && pick.value.includes("/") ? pick.value : "";
    const ref = (refIn.value.trim() || sel || "");
    brPick.innerHTML = "";
    const any = el("option", null, "(default branch)");
    any.value = "";
    brPick.appendChild(any);
    if (!ref.includes("/")) return;
    try {
      const r = await apiFetch("/api/github/branches?ref=" + encodeURIComponent(ref), { cache: "no-store" }).then((r) => r.json());
      // Stale-response guard: the selection may have moved on while this
      // request was in flight — an older list must not overwrite the new one.
      const nowSel = pick.value && pick.value.includes("/") ? pick.value : "";
      const nowRef = (refIn.value.trim() || nowSel || "");
      if (nowRef !== ref) return;
      if (r.error || !Array.isArray(r.branches)) return;
      for (const b of r.branches.slice(0, 100)) {
        const o = el("option", null, b);
        o.value = b;
        brPick.appendChild(o);
      }
      if (r.defaultBranch) brPick.title = "Default branch: " + r.defaultBranch + " — pick a remote branch for the new chat";
    } catch { /* branch list is best-effort; the input still works */ }
  }
  pick.onchange = loadNewChatBranches;
  refIn.onchange = loadNewChatBranches;
  brPick.onchange = () => { brIn.value = brPick.value; };
  const stTitle = document.createElement("input");
  stTitle.placeholder = "save current as… (optional)";
  const start = el("button", "primary", "Start new chat");
  start.onclick = async () => {
    start.disabled = true;
    try {
      const sel = pick.value && pick.value.includes("/") ? pick.value : "";
      const ref = (refIn.value.trim() || sel || null);
      const r = await apiFetch("/api/chats/start", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoRef: ref, branch: brIn.value.trim() || undefined, title: stTitle.value }),
      }).then((r) => r.json());
      if (r.error) throw new Error(r.error);
      files = r.files || files;
      const sorted = Object.keys(files).sort();
      if (!(activeFile in files) && sorted[0]) activeFile = sorted[0];
      built = r.built;
      setMetrics(built);
      renderHistory([]);
      updateRepoBadge(r.linked || null);
      ghSetLinked(r.linked || null);
      // History is its own tab now: return to Chat so the fresh
      // transcript is visible.
      view = "chat";
      syncTabs();
      renderPane();
      log.appendChild(el("div", "msg thinking",
        ref ? ("Started a fresh chat on " + ref + ".") : "Started a fresh chat (no repo)."));
      scroll();
    } catch (e) {
      historyError("start failed: " + (e.message ?? e));
    } finally {
      start.disabled = false;
    }
  };
  prow.appendChild(pick); prow.appendChild(refIn); prow.appendChild(brIn); prow.appendChild(brPick);
  prow.appendChild(stTitle); prow.appendChild(start);
  historyPanel.appendChild(prow);
  try {
    const r = await apiFetch("/api/github/repos", { cache: "no-store" }).then((r) => r.json());
    for (const repo of (r.repos || []).slice(0, 30)) {
      const o = el("option", null, repo.fullName);
      o.value = repo.fullName;
      pick.appendChild(o);
    }
  } catch { /* repo list is best-effort; the input still works */ }
  let chats = [];
  try {
    const r = await apiFetch("/api/chats", { cache: "no-store" }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    chats = r.chats || [];
    updateRepoBadge(r.linked || null);
    ghSetLinked(r.linked || null);
  } catch (e) {
    historyPanel.appendChild(el("div", "msg err", "could not load history: " + (e.message ?? e)));
    return;
  }
  if (!chats.length) {
    historyPanel.appendChild(el("div", "msg thinking", "No snapshots yet — they appear here after each agent reply."));
    return;
  }
  for (const c of chats) {
    const item = el("div", "item");
    const titleEl = el("div", "t", c.title || "(untitled)");
    titleEl.title = "Tap to resume this snapshot";
    titleEl.setAttribute("role", "button");
    titleEl.setAttribute("tabindex", "0");
    item.appendChild(titleEl);
    const when = c.createdAt ? new Date(c.createdAt).toLocaleString() : "";
    item.appendChild(el("div", "m", when + " · " + c.messageCount + " messages" + (c.by ? " · by " + c.by : "")));
    if (c.preview) item.appendChild(el("div", "p", c.preview));
    item.appendChild(el("div", "repo", repoLabel(c.repo || null)));
    let resuming = false;
    const doResume = async () => {
      if (busy || resuming) return;
      resuming = true;
      try {
        const r = await apiFetch("/api/chats/" + encodeURIComponent(c.id) + "/resume", { method: "POST" })
          .then((r) => r.json());
        if (r.error) throw new Error(r.error);
        files = r.files || files;
        const sorted = Object.keys(files).sort();
        // files can be empty while the kept activeFile is still a valid
        // string: only switch when a restored file exists, so editor input
        // never writes under an "undefined" key.
        if (!(activeFile in files) && sorted[0]) activeFile = sorted[0];
        built = r.built;
        setMetrics(built);
        renderHistory(r.messages);
        // The header shows the CURRENT link only: falling back to the
        // snapshot repo here would display a repo that is no longer linked.
        updateRepoBadge(r.linked || null);
        ghSetLinked(r.linked || null);
        // History is its own tab now: return to Chat so the resumed
        // transcript is visible.
        view = "chat";
        syncTabs();
        renderPane();
        log.appendChild(el("div", "msg thinking",
          "Resumed saved session. Code restored." + (r.repoNote ? " " + r.repoNote : "")));
        scroll();
      } catch (e) {
        historyError("resume failed: " + (e.message ?? e));
      } finally {
        resuming = false;
      }
    };
    titleEl.onclick = doResume;
    titleEl.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); doResume(); } };
    const rrow = el("div", "hrow");
    const nameBtn = el("button", "icon", "✎");
    nameBtn.title = "Rename snapshot";
    nameBtn.setAttribute("aria-label", "Rename snapshot");
    nameBtn.onclick = () => {
      const input = document.createElement("input");
      input.value = c.title || "";
      const ok = el("button", "primary", "Save");
      const cancel = el("button", null, "Cancel");
      const edit = el("div", "hrow");
      edit.appendChild(input);
      edit.appendChild(ok);
      edit.appendChild(cancel);
      titleEl.replaceWith(edit);
      rrow.hidden = true;
      input.focus();
      input.select();
      cancel.onclick = () => {
        edit.replaceWith(titleEl);
        rrow.hidden = false;
      };
      ok.onclick = async () => {
        ok.disabled = true;
        try {
          const r = await apiFetch("/api/chats/" + encodeURIComponent(c.id) + "/rename", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: input.value }),
          }).then((r) => r.json());
          if (r.error) throw new Error(r.error);
          await loadChats();
        } catch (e) {
          historyError("rename failed: " + (e.message ?? e));
          ok.disabled = false;
        }
      };
    };
    rrow.appendChild(nameBtn);
    const delBtn = el("button", "icon", "🗑");
    delBtn.title = "Delete snapshot";
    delBtn.setAttribute("aria-label", "Delete snapshot");
    delBtn.onclick = () => {
      const confirm = el("button", "primary", "Confirm delete");
      const cancel = el("button", null, "Cancel");
      const edit = el("div", "hrow");
      edit.appendChild(confirm);
      edit.appendChild(cancel);
      titleEl.replaceWith(edit);
      rrow.hidden = true;
      cancel.onclick = () => {
        edit.replaceWith(titleEl);
        rrow.hidden = false;
      };
      confirm.onclick = async () => {
        confirm.disabled = true;
        try {
          const r = await apiFetch("/api/chats/" + encodeURIComponent(c.id) + "/delete", {
            method: "POST",
          }).then((r) => r.json());
          if (r.error) throw new Error(r.error);
          await loadChats();
        } catch (e) {
          historyError("delete failed: " + (e.message ?? e));
          confirm.disabled = false;
        }
      };
    };
    rrow.appendChild(delBtn);
    item.appendChild(rrow);
    historyPanel.appendChild(item);
  }
}

/* ---------- views: one tab visible at a time ---------- */
const chatSection = document.getElementById("chat");
function renderPane() {
  // Anonymous visitors get the login gate instead of any app view; the
  // GitHub tab stays reachable so login/logout still works from the tab.
  if (!authed && view !== "github") {
    chatSection.hidden = true;
    pane.hidden = true;
    gate.hidden = false;
    return;
  }
  gate.hidden = true;
  // Opening another repo can gain or lose the capsule entries, so the
  // Database tab (capsule repos only) re-syncs on every render — including
  // redirecting a stale database view back to Preview.
  syncCapsuleTabs();
  const isChat = view === "chat";
  chatSection.hidden = !isChat;
  pane.hidden = isChat;
  if (isChat) {
    scroll();
    return;
  }
  // The frame is actually removed here, so its expiry reports end here too.
  appFrameEl = null;
  pane.innerHTML = "";
  if (view === "history") {
    const wrap = el("div");
    wrap.id = "history";
    pane.appendChild(wrap);
    loadChats().catch((e) => wrap.appendChild(el("div", "msg err", "could not load history: " + (e.message ?? e))));
    return;
  }
  if (view === "code") {
    renderCode();
    return;
  }
  if (view === "github") {
    renderGitHub();
    return;
  }
  if (view === "preview") {
    const hasCapsule = hasCapsuleFiles();
    const htmlFiles = Object.keys(files).filter((p) => p.toLowerCase().endsWith(".html")).sort();
    if (hasCapsule) {
      const err = built && built.error;
      if (err) {
        const b = el("div", "banner");
        b.appendChild(el("b", null, err.name || "Build error"));
        b.appendChild(document.createTextNode("\\n" + err.message));
        if (err.stack) b.appendChild(document.createTextNode("\\n" + err.stack));
        pane.appendChild(b);
      } else {
        // The live app, running for real in a sandboxed iframe against the
        // isolate's database — not a snapshot. The iframe is opaque-origin
        // (no allow-same-origin), so capsule code can neither touch this page
        // nor read the browser's API key.
        const wrap = el("div");
        wrap.id = "appwrap";
        const sid = sessionId();
        if (!sid) {
          wrap.appendChild(el("div", "empty", "Session not ready — reload the page."));
        } else {
          const mount = el("div", "empty", "Loading live app…");
          wrap.appendChild(mount);
          previewToken().then((preview) => {
            if (!mount.isConnected) return;
            const frame = document.createElement("iframe");
            frame.id = "appframe";
            frame.title = "Capsule app";
            frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
            frame.setAttribute("referrerpolicy", "no-referrer");
            frame.src = "/api/app?sid=" + encodeURIComponent(sid) + "&preview=" + encodeURIComponent(preview) + "&v=" + appV;
            mount.replaceWith(frame);
            appFrameEl = frame;
            // A 401 at mount renders as plain text inside the sandbox, invisible
            // to the parent: probe the same endpoint family from here instead —
            // apiFetch flips to the gate on a login-required 401.
            apiFetch("/api/app-state?sid=" + encodeURIComponent(sid) + "&preview=" + encodeURIComponent(preview), { cache: "no-store" })
              .then((r) => r.json()).catch(() => {});
          }).catch((e) => {
            if (mount.isConnected) mount.textContent = "could not load preview: " + (e.message ?? e);
          });
        }
        pane.appendChild(wrap);
      }
    } else if (htmlFiles.length) {
      // No capsule: preview a static html file from the repo instead. Local
      // stylesheets and scripts are inlined (the sandboxed srcdoc frame
      // blocks even blob: subresources), so multi-file pages render styled.
      if (!activePreview || !(activePreview in files)) {
        activePreview = pickPreviewHtml(files) || htmlFiles[0];
      }
      const wrap = el("div");
      wrap.id = "appwrap";
      if (htmlFiles.length > 1) {
        // Several html files: the picker bar sits above the frame in a flex
        // column, so the absolute-fill frame does not cover it.
        wrap.style.display = "flex";
        wrap.style.flexDirection = "column";
        const bar = el("div");
        bar.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;padding:10px 14px 0;flex:0 0 auto;";
        for (const p of htmlFiles) {
          const b = el("button", null, p);
          b.style.cssText = "background:" + (p === activePreview ? "var(--accent);color:#111;border:0;font-weight:600;" : "var(--panel2);color:var(--fg);border:1px solid var(--edge);") + "border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;";
          b.onclick = () => { activePreview = p; renderPane(); };
          bar.appendChild(b);
        }
        wrap.appendChild(bar);
      }
      const frame = document.createElement("iframe");
      frame.id = "appframe";
      frame.title = "HTML preview: " + activePreview;
      frame.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.srcdoc = inlineLocalAssets(files, activePreview, files[activePreview] ?? "");
      if (htmlFiles.length > 1) {
        frame.style.flex = "1 1 auto";
        frame.style.height = "auto";
        frame.style.minHeight = "0";
      }
      wrap.appendChild(frame);
      // Deliberately not registered as appFrameEl: only the capsule frame
      // may report auth loss via postMessage. A static repo file could
      // otherwise post "app-builder:auth-required" and force the login gate.
      pane.appendChild(wrap);
    } else {
      const err = built && built.error;
      if (err) {
        const b = el("div", "banner");
        b.appendChild(el("b", null, err.name || "Build error"));
        b.appendChild(document.createTextNode("\\n" + err.message));
        if (err.stack) b.appendChild(document.createTextNode("\\n" + err.stack));
        pane.appendChild(b);
      } else {
        pane.appendChild(el("div", "empty", "No capsule or html file to preview — open a repo with an html file, or ask the agent to build a capsule."));
      }
    }
  } else if (view === "logs") {
    const d = el("div");
    d.id = "logs";
    const lines = (built && built.logs) || [];
    if (!lines.length) d.textContent = "No console output.";
    for (const line of lines) {
      const kind = line.split(" ")[0];
      const span = el("span", kind === "error" ? "error" : kind === "warn" ? "warn" : null, line + "\\n");
      d.appendChild(span);
    }
    pane.appendChild(d);
  } else if (view === "database") {
    // Live database state behind the app view (the app's own writes land
    // here), fetched from the isolate — not the last build snapshot. The tab
    // only shows for capsule repos (see syncCapsuleTabs).
    const loading = el("div", "empty", "Loading live state…");
    pane.appendChild(loading);
    const sid = sessionId();
    if (!sid) {
      loading.textContent = "Session not ready — reload the page.";
    } else {
      previewToken().then((preview) => {
        if (!loading.isConnected) return;
        return apiFetch("/api/app-state?sid=" + encodeURIComponent(sid) + "&preview=" + encodeURIComponent(preview), { cache: "no-store" })
          .then((r) => r.json())
        .then((st) => {
          if (!loading.isConnected) return;
          loading.innerHTML = "";
          if (!st.ok) {
            loading.appendChild(el("div", "err", "state error: " + ((st.error && st.error.message) || "unknown")));
            return;
          }
          const wrap = el("div");
          wrap.id = "preview";
          wrap.appendChild(el("p", "muted",
            "tables: " + (st.tables.join(", ") || "(none)") + " · in-memory, resets on rebuild — lakebed dev semantics"));
          for (const entry of Object.entries(st.queries)) {
            wrap.appendChild(el("h1", null, entry[0]));
            const pre = el("pre", null, JSON.stringify(entry[1], null, 2));
            pre.style.cssText = "font:11.5px/1.5 var(--mono);white-space:pre-wrap;color:var(--dim)";
            wrap.appendChild(pre);
          }
          loading.replaceWith(wrap);
        })
        .catch((e) => {
          if (loading.isConnected) loading.textContent = "could not load state: " + (e.message ?? e);
        });
      });
    }
  }
  pane.scrollTop = 0;
}

function renderCode() {
  const diag = diagBanner();
  if (diag) pane.appendChild(diag);
  const wrap = el("div");
  wrap.id = "code";
  const tree = el("div");
  tree.id = "tree";
  for (const path of Object.keys(files).sort()) {
    const d = el("div", null, path);
    if (path === activeFile) d.setAttribute("aria-current", "true");
    d.onclick = () => { activeFile = path; renderPane(); };
    tree.appendChild(d);
  }
  const ed = el("textarea");
  ed.id = "editor";
  ed.spellcheck = false;
  ed.value = files[activeFile] ?? "";
  ed.oninput = () => { files[activeFile] = ed.value; };
  wrap.appendChild(tree);
  wrap.appendChild(ed);

  const bar = el("div");
  bar.id = "savebar";
  const snapName = document.createElement("input");
  snapName.id = "snapname";
  snapName.placeholder = "Snapshot name (optional)";
  snapName.title = "Checkpoint chat + code under this name";
  const snapBtn = el("button", null, "Snapshot");
  snapBtn.id = "snapbtn";
  snapBtn.title = "Checkpoint chat + code (kept in History)";
  snapBtn.disabled = busy;
  snapBtn.onclick = async () => {
    // A mid-turn snapshot would queue behind the turn lock and then persist
    // this pre-turn map over the turn's files (see snapshotChat): block it
    // like Commit/Create instead, so retrying captures both.
    if (busy) {
      addError("snapshot blocked: an agent turn is running — wait for it to finish, then retry");
      return;
    }
    snapBtn.disabled = true;
    const done = (label) => {
      snapBtn.textContent = label;
      setTimeout(() => {
        if (!snapBtn.isConnected) return;
        snapBtn.disabled = false;
        snapBtn.textContent = "Snapshot";
      }, 1500);
    };
    try {
      // Send the in-memory editor map: Code-tab edits live in browser memory
      // until Save-and-build, and the server would otherwise snapshot the
      // last-saved copy. The server persists this map inside the turn lock
      // before checkpointing, so a mid-turn save cannot clobber agent edits.
      const r = await apiFetch("/api/chats/snapshot", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: snapName.value, files }),
      }).then((r) => r.json());
      if (r.error) throw new Error(r.error);
      snapName.value = "";
      done("Saved ✓");
    } catch (e) {
      addError("snapshot failed: " + (e.message ?? e));
      done("Failed — retry");
    }
  };
  const btn = el("button", null, "Save and build");
  btn.id = "save";
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = "Building…";
    const r = await apiFetch("/api/file", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: activeFile, content: files[activeFile], baseVersion: filesVersion }),
    }).then((r) => r.json());
    if (r.error) {
      // A teammate persisting first still 409s with the server files: adopt
      // them (reload prompt) instead of keeping the stale editor copy.
      if (r.files) {
        files = r.files;
        if (typeof r.version === "number") filesVersion = r.version;
        renderPane();
      }
      btn.disabled = false; btn.textContent = "Save and build";
      addError("save failed: " + r.error);
      return;
    }
    if (r.files) files = r.files;
    if (typeof r.version === "number") filesVersion = r.version;
    built = r.built;
    setMetrics(built);
    btn.disabled = false; btn.textContent = "Save and build";
    renderPane();
  };
  bar.appendChild(snapName);
  bar.appendChild(snapBtn);
  bar.appendChild(btn);
  wrap.appendChild(bar);
  pane.appendChild(wrap);
}

/* ---------- github panel (just-git, server-side) ---------- */
let ghStatus = null;
let ghRepos = [];
let ghMsg = "";
let ghBusy = false;
let ghStatusFailed = false;
// Settings sub-tabs: General | Work | Make repo | Advanced. Persisted so a
// reload lands back on the same workflow; defaults to Work once logged in.
let ghTab = "";
try { ghTab = localStorage.getItem("ab_gh_tab") || ""; } catch { ghTab = ""; }
// Draft inputs live here so switching sub-tabs (which re-renders) does not
// wipe what was already typed — previously every renderPane() reset them.
let ghDraft = {
  openRef: "", openBranch: "", newBranch: "",
  createName: "", createPrivate: false,
  promoteName: "", promotePrivate: false, promoteDel: false, promoteInc: false,
  commitMsg: "", runCmd: "", delBranch: "", inviteCode: "",
};
function ghActiveTab() {
  if (ghTab === "general" || ghTab === "work" || ghTab === "makerepo" || ghTab === "advanced") return ghTab;
  return (ghStatus && ghStatus.connected) ? "work" : "general";
}
function ghSetTab(t) {
  ghTab = t;
  try { localStorage.setItem("ab_gh_tab", t); } catch { /* private mode: tab just won't persist */ }
  renderPane();
}

async function ghRefreshStatus() {
  try {
    ghStatus = await fetch("/api/github/status", { cache: "no-store" }).then((r) => r.json());
    ghStatusFailed = false;
  } catch (e) {
    ghStatusFailed = true;
    ghMsg = "could not reach github status: " + (e.message || e);
  }
}

/* ---------- live sharing (issue #30): two members, one playground ---------- */
let shStatus = null;
let shMsg = "";
let shBusy = false;
let shLoaded = false;
/** Whole-FileMap version from /api/state; saves send it back as baseVersion. */
let filesVersion = 0;

async function shRefresh() {
  try {
    shStatus = await apiFetch("/api/share/status", { cache: "no-store" }).then((r) => r.json());
    shLoaded = true;
  } catch (e) {
    shMsg = "could not reach sharing status: " + (e.message || e);
  }
}

async function shInvite() {
  if (shBusy) return;
  shBusy = true; shMsg = "creating invite…"; renderPane();
  try {
    const r = await apiFetch("/api/share/invite", { method: "POST" }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    const link = location.origin + "/?invite=" + encodeURIComponent(r.playgroundId + "." + r.code);
    try {
      await navigator.clipboard.writeText(link);
      shMsg = "invite link copied (expires in 24h). They join as themselves — your login and token are never shared.";
    } catch {
      shMsg = "invite link (expires in 24h): " + link;
    }
    await shRefresh();
  } catch (e) { shMsg = "invite failed: " + (e.message || e); }
  shBusy = false; renderPane();
}

async function shJoin(code) {
  code = (code || "").trim();
  if (!code) { shMsg = "paste an invite code first"; renderPane(); return; }
  if (shBusy) return;
  shBusy = true; shMsg = "joining…"; renderPane();
  try {
    const r = await apiFetch("/api/share/join", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    // Cookies now name the shared playground: reload into it.
    location.href = "/";
  } catch (e) { shMsg = "join failed: " + (e.message || e); }
  shBusy = false; renderPane();
}

async function shLeave() {
  if (shBusy) return;
  shBusy = true; shMsg = "leaving…"; renderPane();
  try {
    const r = await apiFetch("/api/share/leave", { method: "POST" }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    location.href = "/";
  } catch (e) { shMsg = "leave failed: " + (e.message || e); }
  shBusy = false; renderPane();
}

/** Sharing section of the GitHub tab: invite/join, roster, turn, audit. */
function renderSharing(wrap) {
  wrap.appendChild(el("h2", null, "Sharing"));
  if (!shLoaded) {
    if (!shStatus) {
      wrap.appendChild(el("p", "hint", "loading sharing…"));
      shRefresh().then(renderPane);
    }
    if (shMsg) wrap.appendChild(el("pre", "out", shMsg));
    return;
  }
  if (!shStatus.shared) {
    wrap.appendChild(el("p", "hint",
      "This playground is private to you. To work together live, invite one teammate by link: " +
      "they join as themselves with their own GitHub login — your cookie and your token are never shared. " +
      "Pushes are attributed to whoever pushes; a member without write access gets the collaborator error, not your token."));
    const row = el("div", "row");
    const b = el("button", "primary", shBusy ? "…" : "Invite teammate");
    b.disabled = shBusy || !(ghStatus && ghStatus.connected);
    b.title = ghStatus && ghStatus.connected ? "Create a 24h invite link" : "Log in with GitHub first";
    b.onclick = shInvite;
    row.appendChild(b);
    wrap.appendChild(row);
  } else {
    const members = Array.isArray(shStatus.members) ? shStatus.members : [];
    const names = members.map((m) => (m.login || "pending invite") + " (" + m.role + ")").join(", ") || "—";
    wrap.appendChild(el("p", "hint", "Shared playground — live files, chat, and preview for: " + names));
    const turn = shStatus.turn || {};
    wrap.appendChild(el("p", "hint", turn.active
      ? "Agent turn running" + (turn.actor ? " (" + turn.actor + ")" : "") + (turn.queued ? " — " + turn.queued + " queued" : " — new turns queue behind it")
      : "Agent idle — either member can drive the next turn."));
    wrap.appendChild(el("p", "hint", "Files version " + (shStatus.filesVersion ?? "?") + " — if your save says a teammate edited first, reload: their files are adopted, nothing is silently overwritten."));
    const audit = Array.isArray(shStatus.audit) ? shStatus.audit.slice(0, 8) : [];
    if (audit.length) {
      wrap.appendChild(el("p", "hint", "Recent: " + audit.map((a) =>
        a.actor + " " + a.action + (a.detail ? " " + a.detail : "")).join(" · ").slice(0, 400)));
    }
    // Only the owner may invite (the endpoint 403s otherwise, and status
    // only carries the code for the owner): members get leave, not rotate.
    const isOwner = !!(shStatus.owner && shStatus.owner.login && ghStatus && ghStatus.user &&
      shStatus.owner.login === ghStatus.user.login);
    const row = el("div", "row");
    if (isOwner) {
      const copy = el("button", null, shBusy ? "…" : "Copy invite link");
      copy.disabled = shBusy;
      copy.onclick = shInvite;
      copy.title = "Create a fresh 24h invite link (rotates the previous one)";
      row.appendChild(copy);
    } else if (shStatus.invite) {
      wrap.appendChild(el("p", "hint", "Invite rotation is owner-only — ask " + shStatus.owner.login + " for a fresh link."));
    }
    const leave = el("button", null, "Leave playground");
    leave.disabled = shBusy;
    leave.onclick = shLeave;
    row.appendChild(leave);
    wrap.appendChild(row);
  }
  const jrow = el("div", "row");
  const code = document.createElement("input");
  code.type = "text";
  code.placeholder = "paste invite code to join";
  code.setAttribute("aria-label", "Invite code");
  code.value = ghDraft.inviteCode || "";
  code.oninput = () => { ghDraft.inviteCode = code.value; };
  const join = el("button", null, "Join playground");
  join.disabled = shBusy;
  join.onclick = () => shJoin(code.value);
  jrow.appendChild(code);
  jrow.appendChild(join);
  wrap.appendChild(jrow);
  if (shMsg) wrap.appendChild(el("pre", "out", shMsg));
}

/** Persist the editor's in-memory files before a commit/create, so unsaved
 * browser edits are not silently omitted from the push. Sends the version the
 * editor rendered from: a teammate persisting first 409s, and we adopt the
 * server files (reload prompt) instead of silently overwriting them. */
async function ghSaveAll() {
  const r = await apiFetch("/api/files", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ files, baseVersion: filesVersion }),
  }).then((r) => r.json());
  if (r.error && r.files) {
    files = r.files;
    if (typeof r.version === "number") filesVersion = r.version;
    renderPane();
  }
  if (r.error) throw new Error("save failed: " + r.error);
  files = r.files || files;
  if (typeof r.version === "number") filesVersion = r.version;
}

async function ghLoadRepos() {
  ghBusy = true; renderPane();
  try {
    const r = await apiFetch("/api/github/repos").then((r) => r.json());
    if (r.error) ghMsg = r.error;
    else { ghRepos = r.repos || []; ghMsg = ghRepos.length ? "" : "no repos found"; }
  } catch (e) { ghMsg = "repo list failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

function ghNote(t) { ghMsg = t; renderPane(); }

async function ghOpen(ref, branch) {
  ghBusy = true; ghMsg = "cloning " + ref + "…"; renderPane();
  try {
    const r = await apiFetch("/api/github/open", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref, branch }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    files = r.files || files;
    const sorted = Object.keys(files).sort();
    activeFile = activeFile in files ? activeFile : sorted[0];
    built = r.built;
    setMetrics(built);
    const prevLink = ghStatus && ghStatus.linked;
    await ghRefreshStatus();
    updateRepoBadge(ghStatus && ghStatus.linked);
    ghNoteLinked(prevLink);
    ghMsg = "opened " + ref + (r.skipped && r.skipped.length ? " (skipped: " + r.skipped.join(", ") + ")" : "") +
      (r.kept ? " (" + r.kept + " local file(s) kept as uncommitted changes — check status/diff, then commit)" : "") +
      ". Nothing to preview? Edit files in Code, then commit below.";
  } catch (e) { ghMsg = "open failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghCreate(name, isPrivate, message) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  // Inputs stay editable while the request is in flight: only consume the
  // drafts when they still hold what was submitted.
  const submittedName = name, submittedPrivate = isPrivate;
  ghBusy = true; ghMsg = "saving files, creating " + name + " and pushing…"; renderPane();
  try {
    await ghSaveAll();
    const r = await apiFetch("/api/github/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, private: isPrivate, message }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    const prevLink = ghStatus && ghStatus.linked;
    await ghRefreshStatus();
    updateRepoBadge(ghStatus && ghStatus.linked);
    ghNoteLinked(prevLink);
    if (ghDraft.createName === submittedName) ghDraft.createName = "";
    if (ghDraft.createPrivate === submittedPrivate) ghDraft.createPrivate = false;
    ghMsg = "created " + r.repo.fullName + " and pushed. " + (r.output || "").slice(0, 300);
  } catch (e) { ghMsg = "create failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghPromote(name, isPrivate, deleteSourceBranch, includeUncommitted) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  if (!ghStatus || !ghStatus.linked) { ghNote("open a repo first, then promote its branch"); return; }
  const submittedName = name, submittedPrivate = isPrivate;
  const submittedDel = deleteSourceBranch, submittedInc = includeUncommitted;
  ghBusy = true; ghMsg = "saving files, creating " + name + " and promoting the branch (history kept)…"; renderPane();
  try {
    await ghSaveAll();
    const r = await apiFetch("/api/github/promote", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, private: isPrivate, deleteSourceBranch, includeUncommitted }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    if (r.files) {
      files = r.files;
      const sorted = Object.keys(files).sort();
      if (!(activeFile in files)) activeFile = sorted[0];
    }
    const prevLink = ghStatus && ghStatus.linked;
    await ghRefreshStatus();
    updateRepoBadge(ghStatus && ghStatus.linked);
    // The linked repo just changed to the new one: branch caches and drafts
    // from the old repo no longer apply.
    ghNoteLinked(prevLink);
    if (ghDraft.promoteName === submittedName) ghDraft.promoteName = "";
    if (ghDraft.promotePrivate === submittedPrivate) ghDraft.promotePrivate = false;
    if (ghDraft.promoteDel === submittedDel) ghDraft.promoteDel = false;
    if (ghDraft.promoteInc === submittedInc) ghDraft.promoteInc = false;
    ghMsg = "promoted to " + r.repo.fullName + " with history" +
      (r.deletedSource ? " (source branch deleted)." : " (source branch left intact).") +
      " " + (r.output || "").slice(0, 300);
  } catch (e) { ghMsg = "promote failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghCommitPush(message) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  const submitted = message;
  ghBusy = true; ghMsg = "saving files, committing and pushing…"; renderPane();
  try {
    await ghSaveAll();
    const r = await apiFetch("/api/git/commit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    if (ghDraft.commitMsg === submitted) ghDraft.commitMsg = "";
    ghMsg = "pushed. " + (r.output || "").slice(0, 500);
  } catch (e) { ghMsg = "push failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghPull() {
  ghBusy = true; ghMsg = "pulling…"; renderPane();
  try {
    const r = await apiFetch("/api/git/pull", { method: "POST" }).then((r) => r.json());
    // A 409 conflict still carries the conflict-marked files: always apply
    // them so the editor receives the markers it is told to resolve.
    if (r.files) {
      files = r.files;
      const sorted = Object.keys(files).sort();
      if (!(activeFile in files)) activeFile = sorted[0];
    }
    if (r.built) { built = r.built; setMetrics(built); }
    if (r.error) throw new Error(r.error);
    ghMsg = "pulled. " + (r.output || "").slice(0, 500);
  } catch (e) { ghMsg = "pull failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghShow(which) {
  ghBusy = true; renderPane();
  try {
    const r = await apiFetch("/api/git/" + which, { cache: "no-store" }).then((r) => r.json());
    ghMsg = (which === "status" ? (r.status || r.error) : (r.log || r.error)) || "(empty)";
  } catch (e) { ghMsg = which + " failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghRunCmd(cmd) {
  ghBusy = true; ghMsg = "running git " + cmd + "…"; renderPane();
  try {
    const r = await apiFetch("/api/git/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: cmd }),
    }).then((r) => r.json());
    // Adopt server files even on error: a timed-out op may still complete
    // server-side, and the next Commit/Create must not overwrite its
    // working-tree changes with this panel's stale copy.
    if (r.files) files = r.files;
    if (r.error) throw new Error(r.error);
    if (r.built) { built = r.built; setMetrics(built); }
    ghMsg = "$ git " + cmd + "\\n" + ((r.stdout || "") + "\\n" + (r.stderr || "")).trim().slice(0, 2000) || "(no output)";
  } catch (e) { ghMsg = "git run failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

/* ---------- branch picker (branch-per-prototype flow) ---------- */
let ghBranches = null;
let ghBranchesFailed = false;

/** Drop the cached branch list so the picker refetches for the new link. Pure
 * cache invalidation: branch drafts are repo-scoped separately (ghNoteLinked),
 * so History loads on the same repo keep the picker's input. */
function ghResetBranches() { ghBranches = null; ghBranchesFailed = false; }

/** Branch drafts name branches of one repo: clear them when leaving it. */
function ghClearBranchDrafts() { ghDraft.pickedBranch = ""; ghDraft.delBranch = ""; }

/** Reset branch caches after a link change; drafts reset only when the repo
 * (owner/name) actually changed, so same-repo History loads keep them. */
function ghNoteLinked(prevLink) {
  ghResetBranches();
  const next = ghStatus && ghStatus.linked;
  const same = !!prevLink && !!next &&
    prevLink.owner === next.owner && prevLink.repo === next.repo;
  if (!same) ghClearBranchDrafts();
}

/** Point the status link at a freshly loaded value (History start/list/resume
 * can move it): caches reset, drafts only when the repo actually changed. */
function ghSetLinked(next) {
  const prev = ghStatus && ghStatus.linked;
  if (ghStatus) ghStatus.linked = next || null;
  ghNoteLinked(prev);
}

function ghApplyBranchFiles(r) {
  if (r.files) {
    files = r.files;
    const sorted = Object.keys(files).sort();
    if (!(activeFile in files)) activeFile = sorted[0];
  }
  if (r.built) { built = r.built; setMetrics(built); }
  if (r.linked) {
    if (ghStatus) ghStatus.linked = r.linked;
    updateRepoBadge(r.linked);
  }
}

async function ghLoadBranches() {
  if (!ghStatus || !ghStatus.linked) return;
  ghBusy = true; renderPane();
  try {
    const r = await apiFetch("/api/git/branches", { cache: "no-store" }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    ghBranches = r;
    ghBranchesFailed = false;
    if (r.linked && ghStatus) {
      ghStatus.linked = r.linked;
      updateRepoBadge(r.linked);
    } else if (r.current && ghStatus && ghStatus.linked && ghStatus.linked.branch !== r.current) {
      ghStatus.linked = Object.assign({}, ghStatus.linked, { branch: r.current });
      updateRepoBadge(ghStatus.linked);
    }
    ghMsg = (r.branches || []).length ? "" : "no branches found";
  } catch (e) { ghBranchesFailed = true; ghMsg = "branches failed: " + (e.message || e); }
  ghBusy = false; renderPane();
}

async function ghNewBranch(name) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  let clean = (name || "").trim();
  if (clean.slice(0, 6) === "proto/") clean = clean.slice(6);
  while (clean.charAt(0) === "/") clean = clean.slice(1);
  if (!clean) { ghNote("enter a branch name, e.g. proto/my-prototype"); return; }
  const submitted = name;
  ghBusy = true; ghMsg = "saving files, creating proto/" + clean + " and pushing…"; renderPane();
  try {
    await ghSaveAll();
    const r = await apiFetch("/api/git/branch/new", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "proto/" + clean }),
    }).then((r) => r.json());
    if (r.files) files = r.files;
    if (r.error) throw new Error(r.error);
    ghApplyBranchFiles(r);
    await ghLoadBranchesSilent();
    if (ghDraft.newBranch === submitted) ghDraft.newBranch = "";
    ghDraft.pickedBranch = r.branch;
    ghMsg = "created and pushed " + r.branch + ". " + (r.output || "").slice(0, 500);
  } catch (e) {
    // A failed create can still persist branch changes (a local-only branch
    // after a refused push): refresh first so the picker is not stale.
    await ghLoadBranchesSilent();
    // The checkout may have moved: sync the picker to the refreshed truth.
    if (ghBranches && ghBranches.current) ghDraft.pickedBranch = ghBranches.current;
    ghMsg = "new branch failed: " + (e.message || e);
  }
  ghBusy = false; renderPane();
}

async function ghLoadBranchesSilent() {
  try {
    const r = await apiFetch("/api/git/branches", { cache: "no-store" }).then((r) => r.json());
    if (!r.error) {
      ghBranches = r;
      ghBranchesFailed = false;
      if (r.linked && ghStatus) {
        ghStatus.linked = r.linked;
        updateRepoBadge(r.linked);
      } else if (r.current && ghStatus && ghStatus.linked) {
        ghStatus.linked = Object.assign({}, ghStatus.linked, { branch: r.current });
        updateRepoBadge(ghStatus.linked);
      }
    }
  } catch { /* silent refresh; the message below carries the result */ }
}

async function ghSwitchBranch(branch) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  if (!branch) { ghNote("pick a branch first"); return; }
  ghBusy = true; ghMsg = "switching to " + branch + "…"; renderPane();
  try {
    // Save first like Commit/Create: the server replaces the worktree on
    // switch, so unsaved editor edits must be persisted, not overwritten.
    await ghSaveAll();
    const r = await apiFetch("/api/git/branch/switch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch }),
    }).then((r) => r.json());
    if (r.files) files = r.files;
    if (r.error) throw new Error(r.error);
    ghApplyBranchFiles(r);
    await ghLoadBranchesSilent();
    ghDraft.pickedBranch = r.branch;
    ghMsg = "switched to " + r.branch + ". " + (r.output || "").slice(0, 500);
  } catch (e) {
    await ghLoadBranchesSilent();
    if (ghBranches && ghBranches.current) ghDraft.pickedBranch = ghBranches.current;
    ghMsg = "switch failed: " + (e.message || e);
  }
  ghBusy = false; renderPane();
}

async function ghDeleteBranch(branch) {
  if (busy) { ghNote("an agent turn is running — wait for it to finish, then retry"); return; }
  if (!branch) { ghNote("pick a branch first"); return; }
  if (ghIsRemoteOnly(branch)) { ghNote(branch + " is remote-only — switch to (or create) the local branch first"); return; }
  ghBusy = true; ghMsg = "deleting " + branch + " locally and on origin…"; renderPane();
  try {
    // Same save-first rule as switch: the server may rewrite the worktree.
    await ghSaveAll();
    const r = await apiFetch("/api/git/branch/delete", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch }),
    }).then((r) => r.json());
    if (r.files) files = r.files;
    if (r.error) throw new Error(r.error);
    ghApplyBranchFiles(r);
    await ghLoadBranchesSilent();
    // The deleted name must not linger in the picker or the delete field.
    if (ghDraft.pickedBranch === branch) ghDraft.pickedBranch = "";
    ghDraft.delBranch = "";
    ghMsg = "deleted " + branch + " locally and on origin. " + (r.output || "").slice(0, 500);
  } catch (e) {
    // A local-delete/remote-delete split can persist branch changes:
    // refresh first so the picker is not stale.
    await ghLoadBranchesSilent();
    // A partial failure may still have removed the branch locally: drop the
    // drafts only when the name is actually gone.
    const names = ghBranches && Array.isArray(ghBranches.branches)
      ? ghBranches.branches.map((b) => b.name) : [];
    if (!names.includes(branch)) {
      if (ghDraft.pickedBranch === branch) ghDraft.pickedBranch = "";
      ghDraft.delBranch = "";
    } else if (ghBranches && ghBranches.current) {
      ghDraft.pickedBranch = ghBranches.current;
    }
    ghMsg = "delete failed: " + (e.message || e);
  }
  ghBusy = false; renderPane();
}

/** True when the picker selection names a remote-only entry. */
function ghIsRemoteOnly(name) {
  const list = ghBranches && Array.isArray(ghBranches.branches) ? ghBranches.branches : [];
  const entry = list.find((b) => b.name === name);
  return !!entry && entry.remote;
}

function ghBranchOptions(brSel) {
  const cur = ghBranches && ghBranches.current;
  const list = ghBranches && Array.isArray(ghBranches.branches) ? ghBranches.branches : [];
  if (!ghBranches && !ghBranchesFailed) {
    const o = el("option", null, "loading branches…");
    o.value = "";
    brSel.appendChild(o);
    apiFetch("/api/git/branches", { cache: "no-store" }).then((r) => r.json()).then((r) => {
      if (!r.error) {
        ghBranches = r;
        ghBranchesFailed = false;
        if (r.linked && ghStatus) {
          ghStatus.linked = r.linked;
          updateRepoBadge(r.linked);
        } else if (r.current && ghStatus && ghStatus.linked) {
          ghStatus.linked = Object.assign({}, ghStatus.linked, { branch: r.current });
          updateRepoBadge(ghStatus.linked);
        }
        if (brSel.isConnected) renderPane();
      } else {
        ghBranchesFailed = true;
        if (brSel.isConnected) renderPane();
      }
    }).catch(() => {
      ghBranchesFailed = true;
      if (brSel.isConnected) renderPane();
    });
  } else if (ghBranchesFailed) {
    const o = el("option", null, "(branch list unavailable)");
    o.value = "";
    brSel.appendChild(o);
  } else {
    for (const b of list) {
      const label = (b.current ? "● " : "") + b.name + (b.remote && !list.some((x) => x.name === b.name && !x.remote) ? " (remote)" : "");
      const o = el("option", null, label);
      o.value = b.name;
      if (ghDraft.pickedBranch) {
        if (b.name === ghDraft.pickedBranch) o.selected = true;
      } else if (b.current || (!cur && ghStatus && ghStatus.linked && b.name === ghStatus.linked.branch)) o.selected = true;
      brSel.appendChild(o);
    }
    if (!list.length) {
      const o = el("option", null, "(no branches listed)");
      o.value = "";
      brSel.appendChild(o);
    }
  }
}

function renderGhTabs(wrap) {
  const tabs = el("div", "subtabs");
  tabs.setAttribute("role", "tablist");
  const defs = [["general", "General"], ["work", "Work"], ["makerepo", "Make repo"], ["advanced", "Advanced"]];
  const active = ghActiveTab();
  for (const pair of defs) {
    const b = el("button", "subtab", pair[1]);
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", active === pair[0] ? "true" : "false");
    b.onclick = (function (t) { return function () { ghSetTab(t); }; })(pair[0]);
    tabs.appendChild(b);
  }
  wrap.appendChild(tabs);
}

/** API key + gateway: needed by BYOK users with no GitHub dependency, so this
 * renders before the status-gated early return in renderGitHub too. */
function renderGhModelSetup(wrap) {
  wrap.appendChild(el("h2", null, "Model setup"));
  wrap.appendChild(el("p", "hint", "API key stays only in this browser. Gateway picks the chat backend; the model is picked in the composer."));
  const krow = el("div", "row");
  const keyInput = document.createElement("input");
  keyInput.id = "apikey";
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  keyInput.placeholder = "API key (stored only in this browser)";
  keyInput.setAttribute("aria-label", "Model API key");
  keyInput.value = localStorage.getItem("ab_key") || "";
  keyInput.oninput = () => localStorage.setItem("ab_key", keyInput.value.trim());
  krow.appendChild(keyInput);
  wrap.appendChild(krow);
  const grow = el("div", "row");
  const gwLabel = el("span", "hint", "gateway");
  const gwSel = document.createElement("select");
  gwSel.id = "gateway";
  gwSel.title = "Gateway";
  gwSel.setAttribute("aria-label", "Gateway");
  for (const g of Object.keys(GATEWAYS)) {
    const o = document.createElement("option");
    o.value = g; o.textContent = g;
    gwSel.appendChild(o);
  }
  gwSel.value = getGateway();
  gwSel.onchange = () => setGateway(gwSel.value);
  grow.appendChild(gwLabel);
  grow.appendChild(gwSel);
  wrap.appendChild(grow);
}

function renderGhGeneral(wrap) {
  renderGhModelSetup(wrap);
  wrap.appendChild(el("h2", null, "GitHub account"));
  if (!ghStatus.connected) {
    const row = el("div", "row");
    const b = el("button", "primary", ghBusy ? "…" : "Log in with GitHub");
    b.disabled = ghBusy;
    b.onclick = () => { window.location.href = "/api/github/login"; };
    row.appendChild(b);
    row.appendChild(el("span", "hint", "OAuth; token stays server-side."));
    wrap.appendChild(row);
  } else {
    const who = el("div", "row");
    who.appendChild(el("span", null, "connected as " + (ghStatus.user ? ghStatus.user.login : "?")));
    const scopes = Array.isArray(ghStatus.scopes) ? ghStatus.scopes : [];
    if (scopes.length && !scopes.includes("workflow")) {
      who.appendChild(el("span", "hint", "missing workflow scope — Log out and back in, or pushes touching .github/workflows/* will 403"));
    }
    if (ghStatus.tokenKind && ghStatus.tokenKind !== "oauth") {
      who.appendChild(el("span", "hint", "token type: " + ghStatus.tokenKind + " — pushes need an OAuth-App login"));
    }
    if (ghStatus.tokenKind === "github-app") {
      who.appendChild(el("span", "hint", "GitHub-App login: API works but every git push is refused. Use an OAuth App instead, then Log out and back in."));
    }
    const out = el("button", null, "Log out");
    out.onclick = async () => {
      await apiFetch("/api/github/logout", { method: "POST" });
      ghStatus = null; ghRepos = [];
      ghResetBranches();
      await ghRefreshStatus();
      if (ghStatus && ghStatus.connected) {
        authed = true; syncGateTabs(); renderPane();
      } else {
        showGate();
      }
    };
    who.appendChild(out);
    wrap.appendChild(who);
    const det = document.createElement("details");
    det.className = "tok";
    const sum = document.createElement("summary");
    sum.textContent = "token details";
    det.appendChild(sum);
    const granted = Array.isArray(ghStatus.grantedScopes) ? ghStatus.grantedScopes : [];
    det.appendChild(el("p", "hint", "scopes now: " + (scopes.length ? scopes.join(", ") : "unknown")));
    if (granted.length) det.appendChild(el("p", "hint", "granted at login: " + granted.join(", ")));
    wrap.appendChild(det);
  }
  renderSharing(wrap);
}

function renderGhWork(wrap, linked) {
  wrap.appendChild(el("p", "hint",
    linked ? ("linked: " + linked.owner + "/" + linked.repo + " (" + linked.branch + ")") : "no repo linked yet"));
  const openCard = el("div", "card");
  openCard.appendChild(el("h3", null, "Open a repo"));
  openCard.appendChild(el("p", "hint", "Clone something you own to edit it here, or pick from your repos below."));
  const orow = el("div", "row");
  const ref = document.createElement("input");
  ref.type = "text"; ref.placeholder = "owner/repo";
  ref.setAttribute("aria-label", "Repo owner slash name");
  ref.value = ghDraft.openRef || "";
  ref.oninput = () => { ghDraft.openRef = ref.value; };
  const br = document.createElement("input");
  br.type = "text"; br.placeholder = "branch (optional)"; br.style.minWidth = "130px";
  br.setAttribute("aria-label", "Branch (optional)");
  br.value = ghDraft.openBranch || "";
  br.oninput = () => { ghDraft.openBranch = br.value; };
  const openBtn = el("button", "primary", "Open repo");
  openBtn.disabled = ghBusy;
  openBtn.onclick = () => ghOpen(ref.value, br.value || undefined);
  orow.appendChild(ref); orow.appendChild(br); orow.appendChild(openBtn);
  openCard.appendChild(orow);
  const lrow = el("div", "row");
  const lb = el("button", null, ghRepos.length ? "Refresh my repos" : "List my repos");
  lb.disabled = ghBusy;
  lb.onclick = ghLoadRepos;
  lrow.appendChild(lb);
  openCard.appendChild(lrow);
  for (const r of ghRepos.slice(0, 20)) {
    const d = el("div", "repo", (r.private ? "🔒 " : "") + r.fullName);
    d.onclick = () => ghOpen(r.fullName, undefined);
    openCard.appendChild(d);
  }
  wrap.appendChild(openCard);
  if (linked) {
    const brCard = el("div", "card");
    brCard.appendChild(el("h3", null, "Branches"));
    brCard.appendChild(el("p", "hint", "One branch = one prototype. Create proto/<name> from HEAD, then switch between them."));
    const brow = el("div", "row");
    const brSel = document.createElement("select");
    brSel.title = "Pick a branch";
    brSel.setAttribute("aria-label", "Pick a branch");
    brSel.style.minWidth = "170px";
    ghBranchOptions(brSel);
    if (!ghDraft.pickedBranch && brSel.options.length) ghDraft.pickedBranch = brSel.value;
    brSel.onchange = () => { ghDraft.pickedBranch = brSel.value; };
    const cur = ghBranches && ghBranches.current;
    const curLbl = el("span", "hint", cur ? ("on " + cur) : ("on " + linked.branch));
    const swBtn = el("button", null, "Switch");
    swBtn.disabled = ghBusy;
    swBtn.title = "Checkout the selected branch";
    swBtn.onclick = () => ghSwitchBranch(brSel.value || (cur || ""));
    const refBtn = el("button", null, "Refresh branches");
    refBtn.disabled = ghBusy;
    refBtn.title = "Refresh branch list";
    refBtn.onclick = ghLoadBranches;
    brow.appendChild(brSel); brow.appendChild(swBtn); brow.appendChild(refBtn); brow.appendChild(curLbl);
    brCard.appendChild(brow);
    const nrow = el("div", "row");
    const protoPrefix = el("span", "hint", "proto/");
    const nmBr = document.createElement("input");
    nmBr.type = "text"; nmBr.placeholder = "my-prototype"; nmBr.style.minWidth = "150px";
    nmBr.setAttribute("aria-label", "New branch name");
    nmBr.value = ghDraft.newBranch || "";
    nmBr.oninput = () => { ghDraft.newBranch = nmBr.value; };
    const newBtn = el("button", "primary", "New branch + push");
    newBtn.disabled = ghBusy;
    newBtn.title = "Create proto/<name> from HEAD and push -u origin";
    newBtn.onclick = () => ghNewBranch(nmBr.value);
    nrow.appendChild(protoPrefix); nrow.appendChild(nmBr); nrow.appendChild(newBtn);
    brCard.appendChild(nrow);
    wrap.appendChild(brCard);
  }
  const saveCard = el("div", "card");
  saveCard.appendChild(el("h3", null, "Save your work"));
  saveCard.appendChild(el("p", "hint", "Commit pushes the current files to the linked branch."));
  const mrow = el("div", "row");
  const msg = document.createElement("input");
  msg.type = "text"; msg.placeholder = "commit message";
  msg.setAttribute("aria-label", "Commit message");
  msg.value = ghDraft.commitMsg || "";
  msg.oninput = () => { ghDraft.commitMsg = msg.value; };
  const pushBtn = el("button", "primary", "Commit + push");
  pushBtn.disabled = ghBusy;
  pushBtn.onclick = () => ghCommitPush(msg.value);
  const pullBtn = el("button", null, "Pull");
  pullBtn.disabled = ghBusy;
  pullBtn.onclick = ghPull;
  mrow.appendChild(msg); mrow.appendChild(pushBtn); mrow.appendChild(pullBtn);
  saveCard.appendChild(mrow);
  const qrow = el("div", "row");
  const items = [["status", "Status"], ["log", "Log"]];
  for (const pair of items) {
    const b = el("button", null, pair[1]);
    b.disabled = ghBusy;
    b.onclick = ((w) => () => ghShow(w))(pair[0]);
    qrow.appendChild(b);
  }
  saveCard.appendChild(qrow);
  wrap.appendChild(saveCard);
}

function renderGhMakeRepo(wrap, linked) {
  wrap.appendChild(el("p", "hint",
    linked ? ("linked: " + linked.owner + "/" + linked.repo + " (" + linked.branch + ")") : "no repo linked yet"));
  const c1 = el("div", "card");
  c1.appendChild(el("h3", null, "New repo from current files"));
  c1.appendChild(el("p", "hint", "Start a fresh repo from what is on screen now. Single squashed commit."));
  const crow = el("div", "row");
  const nm = document.createElement("input");
  nm.type = "text"; nm.placeholder = "new repo name";
  nm.setAttribute("aria-label", "New repo name");
  nm.value = ghDraft.createName || "";
  nm.oninput = () => { ghDraft.createName = nm.value; };
  const privLbl = document.createElement("label");
  privLbl.className = "check";
  const priv = document.createElement("input");
  priv.type = "checkbox"; priv.title = "private";
  priv.checked = !!ghDraft.createPrivate;
  priv.onchange = () => { ghDraft.createPrivate = priv.checked; };
  privLbl.appendChild(priv);
  privLbl.appendChild(document.createTextNode("private"));
  const createBtn = el("button", "primary", "Create + push");
  createBtn.disabled = ghBusy;
  createBtn.onclick = () => ghCreate(nm.value.trim(), priv.checked, "initial commit from app-builder");
  crow.appendChild(nm); crow.appendChild(privLbl); crow.appendChild(createBtn);
  c1.appendChild(crow);
  wrap.appendChild(c1);
  const c2 = el("div", "card");
  c2.appendChild(el("h3", null, "New repo from this branch (keep history)"));
  c2.appendChild(el("p", "hint", "Graduate the linked branch to its own repo with full commit history."));
  const prow = el("div", "row");
  const pm = document.createElement("input");
  pm.type = "text"; pm.placeholder = "new repo name";
  pm.setAttribute("aria-label", "Promoted repo name");
  pm.value = ghDraft.promoteName || "";
  pm.oninput = () => { ghDraft.promoteName = pm.value; };
  const pprivLbl = document.createElement("label");
  pprivLbl.className = "check";
  const ppriv = document.createElement("input");
  ppriv.type = "checkbox"; ppriv.title = "private";
  ppriv.checked = !!ghDraft.promotePrivate;
  ppriv.onchange = () => { ghDraft.promotePrivate = ppriv.checked; };
  pprivLbl.appendChild(ppriv);
  pprivLbl.appendChild(document.createTextNode("private"));
  prow.appendChild(pm); prow.appendChild(pprivLbl);
  c2.appendChild(prow);
  const orow2 = el("div", "row");
  const pdelLbl = document.createElement("label");
  pdelLbl.className = "check";
  const pdel = document.createElement("input");
  pdel.type = "checkbox"; pdel.title = "delete source branch after promote";
  pdel.checked = !!ghDraft.promoteDel;
  pdel.onchange = () => { ghDraft.promoteDel = pdel.checked; };
  pdelLbl.appendChild(pdel);
  pdelLbl.appendChild(document.createTextNode("delete source branch"));
  const pincLbl = document.createElement("label");
  pincLbl.className = "check";
  const pinc = document.createElement("input");
  pinc.type = "checkbox"; pinc.title = "include uncommitted changes as uncommitted in the new repo";
  pinc.checked = !!ghDraft.promoteInc;
  pinc.onchange = () => { ghDraft.promoteInc = pinc.checked; };
  pincLbl.appendChild(pinc);
  pincLbl.appendChild(document.createTextNode("include uncommitted"));
  orow2.appendChild(pdelLbl); orow2.appendChild(pincLbl);
  c2.appendChild(orow2);
  const brow3 = el("div", "row");
  const promoteBtn = el("button", "primary", "Promote branch to new repo");
  promoteBtn.disabled = ghBusy || !linked;
  promoteBtn.title = linked ? "Create the new repo from this branch, keeping history" : "Open a repo first, then promote its branch";
  promoteBtn.onclick = () => ghPromote(pm.value.trim(), ppriv.checked, pdel.checked, pinc.checked);
  brow3.appendChild(promoteBtn);
  c2.appendChild(brow3);
  wrap.appendChild(c2);
}

function renderGhAdvanced(wrap, linked) {
  wrap.appendChild(el("p", "hint", "Rarely needed. These can rewrite history or run raw git — double-check before using."));
  const dCard = el("div", "card");
  dCard.appendChild(el("h3", null, "Delete a branch"));
  dCard.appendChild(el("p", "hint", "Removes a merged proto/* branch locally and on origin. Unmerged deletes stay explicit: git branch -D <name>. Remote-only branch entries (origin/*) cannot be deleted here — switch to (or create) the local branch first."));
  const drow = el("div", "row");
  const din = document.createElement("input");
  din.type = "text"; din.placeholder = "branch, e.g. proto/my-prototype";
  din.setAttribute("aria-label", "Branch to delete");
  din.value = ghDraft.delBranch || (ghDraft.pickedBranch || "");
  const delBtn = el("button", null, "Delete branch");
  delBtn.title = "Delete the branch locally and on origin";
  const syncDelBtn = () => {
    delBtn.disabled = ghBusy || !linked || !(din.value || "").trim();
  };
  syncDelBtn();
  din.oninput = () => { ghDraft.delBranch = din.value; syncDelBtn(); };
  delBtn.onclick = () => ghDeleteBranch((din.value || "").trim());
  drow.appendChild(din); drow.appendChild(delBtn);
  dCard.appendChild(drow);
  wrap.appendChild(dCard);
  const gCard = el("div", "card");
  gCard.appendChild(el("h3", null, "Run raw git"));
  gCard.appendChild(el("p", "hint", "Read-only commands like status, log, diff --stat are safest. Mutating commands run for real."));
  const qrow = el("div", "row");
  const cmd = document.createElement("input");
  cmd.type = "text"; cmd.placeholder = "git args, e.g. diff --stat";
  cmd.setAttribute("aria-label", "Git args");
  cmd.value = ghDraft.runCmd || "";
  cmd.oninput = () => { ghDraft.runCmd = cmd.value; };
  const runB = el("button", null, "Run git");
  runB.disabled = ghBusy;
  runB.onclick = () => ghRunCmd(cmd.value);
  qrow.appendChild(cmd); qrow.appendChild(runB);
  gCard.appendChild(qrow);
  wrap.appendChild(gCard);
}

function renderGitHub() {
  const wrap = el("div");
  wrap.id = "gh";
  wrap.appendChild(el("h2", null, "Settings"));
  renderGhTabs(wrap);
  const tab = ghActiveTab();
  if (!ghStatus) {
    // Model setup has no GitHub dependency, so BYOK users get their key field
    // even while status is loading or failed (as before the sub-tab split).
    renderGhModelSetup(wrap);
    if (ghStatusFailed) {
      wrap.appendChild(el("p", "hint", "GitHub status is unavailable."));
      const retry = el("button", null, "Retry");
      retry.onclick = () => { ghRefreshStatus().then(renderPane); };
      const row = el("div", "row");
      row.appendChild(retry);
      wrap.appendChild(row);
    } else {
      wrap.appendChild(el("p", "hint", "loading…"));
      ghRefreshStatus().then(renderPane);
    }
    if (tab === "general") renderSharing(wrap);
    if (ghMsg) wrap.appendChild(el("pre", "out", ghMsg));
    pane.appendChild(wrap);
    return;
  }
  if (!ghStatus.connected && tab !== "general") {
    wrap.appendChild(el("p", "hint", "Log in with GitHub on the General tab first — then this tab unlocks."));
    const go = el("button", null, "Go to General");
    go.onclick = () => ghSetTab("general");
    const row = el("div", "row");
    row.appendChild(go);
    wrap.appendChild(row);
    if (ghMsg) wrap.appendChild(el("pre", "out", ghMsg));
    pane.appendChild(wrap);
    return;
  }
  const linked = ghStatus.linked;
  if (tab === "general") renderGhGeneral(wrap);
  else if (tab === "work") renderGhWork(wrap, linked);
  else if (tab === "makerepo") renderGhMakeRepo(wrap, linked);
  else renderGhAdvanced(wrap, linked);
  if (ghMsg) {
    const pre = el("pre", "out", ghMsg);
    wrap.appendChild(pre);
  }
  pane.appendChild(wrap);
}


function setMetrics(b) {
  if (b && b.ok) appV++;
  mBundle.textContent = b && b.durationMs != null ? b.durationMs + " ms" : "—";
  // Without a capsule there is nothing to build: a red "failed" would blame
  // a static repo for not being a capsule, so show a neutral label instead.
  if (!hasCapsuleFiles()) { mBuilt.textContent = "no capsule"; mBuilt.className = ""; return; }
  if (!b) { mBuilt.textContent = "idle"; mBuilt.className = "built"; return; }
  const bad = !b.ok;
  const n = (b.diagnostics || []).length;
  mBuilt.textContent = bad ? "failed" : n ? \`built · \${n} type error\${n === 1 ? "" : "s"}\` : "built";
  mBuilt.className = bad ? "failed" : "built";
}

/* Type errors ride along on the build result without blocking it (see
   session.build), so they render as their own strip in the Code view —
   where the user can act on them — using textContent throughout so
   diagnostic text quoting user code can never become markup. */
function diagBanner() {
  const diags = (built && built.diagnostics) || [];
  const failure = built && built.typecheckFailure;
  if (!diags.length && !failure) return null;
  const d = el("div");
  d.className = "diag";
  const lines = diags.map((g) => \`\${g.file}(\${g.line},\${g.column}): \${g.category}\${g.code ? \` TS\${g.code}\` : ""}: \${g.text}\`);
  if (failure) lines.push(\`type checker did not finish (\${failure.name}): \${failure.message}\`);
  d.appendChild(el("b", null, diags.length
    ? \`\${diags.length} type error\${diags.length === 1 ? "" : "s"} — the app preview still runs; lint blocks deploy until these are fixed\`
    : "type checker did not finish"));
  d.appendChild(document.createTextNode("\\n" + lines.join("\\n")));
  return d;
}

/* ---------- image attachments (paste / attach, stored in R2) ---------- */
const attachBtn = document.getElementById("attach");
const filePick = document.getElementById("filepick");
const pendingBox = document.getElementById("pending");
const box = document.getElementById("box");
let pendingImages = [];
let uploading = 0;
function renderPending() {
  if (!pendingBox) return;
  pendingBox.innerHTML = "";
  pendingBox.hidden = !pendingImages.length;
  for (const p of pendingImages) {
    const t = el("div", "thumb" + (p.uploading ? " uploading" : ""));
    if (p.preview) {
      const img = document.createElement("img");
      img.src = p.preview;
      img.alt = "attached image";
      t.appendChild(img);
    } else {
      t.appendChild(el("div", "thumbwait", "…"));
    }
    const x = el("button", null, "×");
    x.title = "Remove attachment";
    x.setAttribute("aria-label", "Remove attachment");
    x.onclick = () => {
      pendingImages = pendingImages.filter((q) => q !== p);
      // The bytes were already persisted on attach: delete the R2 object so
      // removed attachments do not linger as orphans. Best-effort — a
      // failure keeps the (harmless, unreferenced) bytes, never the UI.
      if (p.id) {
        apiFetch("/api/images/" + encodeURIComponent(p.id), { method: "DELETE" }).catch(() => {});
      }
      renderPending();
      syncSend();
    };
    t.appendChild(x);
    pendingBox.appendChild(t);
  }
}
function syncSend() {
  sendBtn.disabled = busy || uploading > 0 || booting;
}
/** Read a File as a data URL (for upload + instant thumbnail). */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("could not read " + (file.name || "image")));
    r.readAsDataURL(file);
  });
}
/** Upload data URLs: at most 4 total, images only, 5 MiB each (server enforces). */
async function attachFiles(files) {
  const list = [...(files || [])].filter((f) => f && /^image\\//.test(f.type || ""));
  if (!list.length) return;
  const valid = [];
  for (const file of list) {
    if (file.size > 5 * 1024 * 1024) {
      addError("image too large (max 5 MiB): " + (file.name || "pasted image"));
      continue;
    }
    valid.push(file);
  }
  if (!valid.length) return;
  // Reserve slots synchronously: concurrent paste/drop/pick events must not
  // all pass the cap check before any of them records its entries.
  const slots = 4 - pendingImages.length;
  if (slots <= 0) {
    addError("at most 4 images per message");
    return;
  }
  const take = valid.slice(0, slots);
  if (valid.length > slots) addError("at most 4 images per message (extras ignored)");
  uploading += take.length;
  syncSend();
  const entries = take.map((file) => {
    const entry = { preview: "", uploading: true, id: null, mimeType: file.type || "image/png", file };
    pendingImages.push(entry);
    return entry;
  });
  renderPending();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const preview = await readAsDataUrl(entry.file);
        entry.preview = preview;
        renderPending();
        const r = await apiFetch("/api/images", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: preview, mimeType: entry.mimeType }),
        }).then((r) => r.json());
        if (r.error) throw new Error(r.error);
        entry.id = r.id;
        entry.mimeType = r.mimeType || entry.mimeType;
        entry.uploading = false;
      } catch (e) {
        pendingImages = pendingImages.filter((q) => q !== entry);
        addError("upload failed: " + (e.message ?? e));
      } finally {
        uploading--;
      }
    }),
  );
  renderPending();
  syncSend();
}
if (attachBtn && filePick) {
  attachBtn.onclick = () => filePick.click();
  filePick.onchange = () => {
    attachFiles(filePick.files).catch((e) => addError(e.message ?? String(e)));
    filePick.value = "";
  };
}
if (box) {
  box.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault();
  });
  box.addEventListener("drop", (e) => {
    // Claim the drop before filtering: a non-image file must not trigger the
    // browser default (which navigates away from the app).
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /^image\\//.test(f.type || ""));
    if (files.length) {
      attachFiles(files).catch((err) => addError(err.message ?? String(err)));
    }
  });
}
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\\//.test(f.type || ""));
  const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/"));
  if (files.length || items.length) {
    const picked = files.length ? files : items.map((i) => i.getAsFile()).filter(Boolean);
    if (picked.length) {
      e.preventDefault();
      attachFiles(picked).catch((err) => addError(err.message ?? String(err)));
    }
  }
});

/* ---------- agent stream ---------- */
async function send() {
  const text = input.value.trim();
  const ready = pendingImages.filter((p) => p.id && !p.uploading);
  if ((!text && !ready.length) || busy || uploading > 0 || booting) return;
  const images = ready.map((p) => ({ id: p.id, mimeType: p.mimeType }));
  // Entries sent this turn: kept aside so a request that never reaches the
  // agent can be retried without re-uploading (their R2 objects persist).
  // Once the SSE stream opens, the DO owns the message (refs are persisted
  // before Pi even submits), so restoring would duplicate it — only
  // pre-acceptance failures restore.
  const sentEntries = ready;
  let accepted = false;
  input.value = "";
  input.style.height = "auto";
  pendingImages = [];
  renderPending();
  busy = true; sendBtn.disabled = true;
  // Shared playgrounds attribute the turn; the server stores it on the message.
  const me = (ghStatus && ghStatus.user && ghStatus.user.login) || null;
  addUser(text, images, me);
  const thinking = addThinking();
  // One agent turn runs at a time per playground: if nothing streams back
  // within a few seconds we are queued behind the other member's turn, not
  // stuck. Best-effort who/position from the sharing status.
  let firstEvent = false;
  const queueTimer = setTimeout(async () => {
    if (firstEvent || !thinking.isConnected) return;
    let who = "the other member's";
    try {
      const st = await apiFetch("/api/share/status", { cache: "no-store" }).then((r) => r.json());
      if (st && st.turn && st.turn.active) {
        who = st.turn.actor ? (st.turn.actor + "'s") : who;
        if (typeof st.turn.queued === "number" && st.turn.queued > 0) {
          thinking.textContent = "queued behind " + who + " turn (" + st.turn.queued + " waiting)…";
          return;
        }
      }
    } catch { /* best-effort label only */ }
    thinking.textContent = "queued behind " + who + " turn…";
  }, 3000);

  let settled = false;
  // Open narration segments by Pi content index. Deltas append to their
  // segment; a whole block replaces the segment with the same index when
  // it extends it (grown block), commits what is open and starts a fresh
  // bubble when the index is new (consecutive distinct paragraphs) or
  // when the same index carries non-extending text (retry rewrite,
  // redaction). Distinct text never overwrites visible text: the live
  // transcript keeps everything the restored snapshot will show.
  const segTexts = new Map();
  const segNodes = new Map();
  const segOrder = [];
  const previewText = () => segOrder.map((i) => segTexts.get(i) || "").join("");
  const showSeg = (i) => {
    if (thinking.isConnected) thinking.textContent = previewText().slice(0, 400);
    else {
      let node = segNodes.get(i);
      if (!node) { node = el("div", "msg agent", ""); log.appendChild(node); segNodes.set(i, node); }
      node.innerHTML = markdownToHtml(segTexts.get(i));
      scroll();
    }
  };
  const commitSegs = () => {
    if (thinking.isConnected) thinking.remove();
    const order = [...segOrder].sort((a, b) => a - b);
    let any = false;
    for (const i of order) {
      const t = segTexts.get(i);
      if (!t) continue;
      any = true;
      if (!segNodes.get(i)) {
        const bubble = el("div", "msg agent", "");
        bubble.innerHTML = markdownToHtml(t);
        log.appendChild(bubble);
      } else {
        segNodes.get(i).innerHTML = markdownToHtml(t);
      }
    }
    if (any) log.appendChild(el("div", "model", "✳ " + getGateway() + "/" + modelSel.value));
    segOrder.length = 0; segTexts.clear(); segNodes.clear();
    scroll();
  };
  const flush = () => commitSegs();

  const apiKey = readApiKey();
  if (apiKey) localStorage.setItem("ab_key", apiKey);
  try {
    const res = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { "x-provider-key": apiKey } : {}) },
      body: JSON.stringify({
        message: text || "(see attached images)",
        gateway: getGateway(),
        model: modelSel.value,
        ...(images.length ? { images } : {}),
      }),
    });
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      // The gate flip already happened inside apiFetch; the key-missing 401
      // keeps the chat visible with the key prompt.
      throw new Error(body.error || "unauthorized: set the API key below");
    }
    if (!res.ok || !res.body) throw new Error("chat request failed: " + res.status);
    // The stream is open, so the DO owns the turn (its refs were persisted
    // before Pi submission): from here on, failures must not restore the
    // sent entries, or a retry would duplicate the recorded message — and
    // removing a restored thumb could delete bytes history still needs.
    accepted = true;

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const drain = (final) => {
      const frames = buf.split("\\n\\n");
      buf = final ? "" : (frames.pop() || "");
      for (const frame of frames) {
        const line = frame.split("\\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (!firstEvent) {
          firstEvent = true;
          clearTimeout(queueTimer);
        }
        if (ev.type === "text") {
          const i = ev.index || 0;
          if (!segTexts.has(i)) segOrder.push(i);
          segTexts.set(i, (segTexts.get(i) || "") + ev.text);
          showSeg(i);
        } else if (ev.type === "text_block") {
          if (ev.text) {
            const i = ev.index || 0;
            const cur = segTexts.get(i);
            if (cur === undefined) {
              commitSegs();
              segOrder.push(i);
              segTexts.set(i, ev.text);
            } else if (ev.text !== cur && ev.text.indexOf(cur) !== 0) {
              // Same index but not a grown block (retry rewrite, redaction):
              // keep the open text as its own bubble instead of overwriting
              // it, so a revision never deletes visible narration.
              commitSegs();
              segOrder.push(i);
              segTexts.set(i, ev.text);
            } else {
              segTexts.set(i, ev.text);
            }
            showSeg(i);
          }
        } else if (ev.type === "tool") {
          // Flush any pending narration first: the model often sends text
          // ("building your redesign now") ahead of its tool calls in the
          // same round, and dropping it makes the transcript look stuck.
          commitSegs();
          addTool(ev.name, ev.detail);
        } else if (ev.type === "tool_result") {
          // The tool line already showed the action. Only surface a result
          // when it failed, otherwise the transcript is just file dumps.
          if (!ev.ok) addTool(ev.name, ev.detail, false);
        } else if (ev.type === "build") {
          built = ev.result;
          if (ev.result.files) files = ev.result.files;
          setMetrics(built);
          renderPane();
        } else if (ev.type === "done") {
          settled = true;
          files = ev.files;
          setMetrics(built);
          renderPane();
        } else if (ev.type === "error") {
          settled = true;
          flush();
          addError(ev.message);
        }
      }
    };
    // A failure inside the frame handlers must not silently drop narration
    // that already streamed: flush the open segments before the error
    // reaches the turn-level handler. The one exception is a partial tail
    // frame when the stream closes (complete-but-unterminated final frames
    // are recovered above; a truly partial one cannot parse and is skipped,
    // with the persisted transcript as its backstop).
    const drainGuarded = (final) => {
      try {
        drain(final);
      } catch (e) {
        if (final && e instanceof SyntaxError) return;
        try { commitSegs(); } catch { /* never mask the original failure */ }
        throw e;
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      drainGuarded(false);
    }
    drainGuarded(true);
    flush();
    // A killed proxy/Worker request closes the stream with no done/error,
    // which previously looked stuck after the last edit. Progress is saved
    // every round, so a retry continues cleanly.
    if (!settled) addError("interrupted before finishing — progress is saved, retry your message");
  } catch (e) {
    if (thinking.isConnected) thinking.remove();
    addError(e.message ?? String(e));
  } finally {
    clearTimeout(queueTimer);
    if (!accepted && sentEntries.length) {
      // The request never reached the agent, so nothing was recorded:
      // give the attachments back for a retry (plus anything attached
      // meanwhile), capped so the next send is not rejected outright.
      const restored = [...sentEntries, ...pendingImages];
      if (restored.length > 4) {
        addError("kept the first 4 attachments; remove some before retrying");
      }
      pendingImages = restored.slice(0, 4);
      renderPending();
    }
    busy = false; sendBtn.disabled = false;
    input.focus();
  }
}

sendBtn.onclick = send;
input.addEventListener("keydown", (e) => {
  // Enter inserts a newline for multiline prompts; ⌘/Ctrl+Enter sends.
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(140, input.scrollHeight) + "px";
});

function syncTabs() {
  document.querySelectorAll("[data-view]").forEach((o) => {
    if (o.dataset.view === view) o.setAttribute("aria-selected", "true");
    else o.removeAttribute("aria-selected");
  });
}
function selectTab(elm) {
  // One tab row: the header tab names the only visible view.
  if (!elm.dataset.view) return;
  // The gate hides app tabs for anonymous visitors; ignore clicks that slip
  // through (keyboard focus) so the gate cannot be bypassed client-side.
  if (!authed && elm.dataset.view !== "github") return;
  // The Database tab is hidden without a capsule; ignore focus-driven
  // selection the same way so a hidden tab never becomes the live view.
  if (elm.dataset.view === "database" && !hasCapsuleFiles()) return;
  view = elm.dataset.view;
  syncTabs();
  renderPane();
}
document.querySelectorAll("[data-view]").forEach((n) => {
  n.onclick = () => selectTab(n);
  n.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTab(n); } };
});

(async () => {
  const loading = el("div", "msg thinking", "Loading session…");
  log.appendChild(loading);
  mBuilt.textContent = "loading…";
  sendBtn.disabled = true;
  try {
    // Invite links land here as /?invite=<playground>.<code>: redeem first
    // so the cookies name the shared playground before anything else loads.
    const inviteParam = new URLSearchParams(location.search).get("invite");
    if (inviteParam) {
      history.replaceState(null, "", "/");
      try {
        const j = await fetch("/api/share/join", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: inviteParam }),
        }).then((r) => r.json());
        if (j.error) throw new Error(j.error);
        location.reload();
        return;
      } catch (e) {
        loading.remove();
        mBuilt.textContent = "invite error";
        mBuilt.className = "failed";
        log.appendChild(el("div", "err", "invite failed: " + (e.message ?? e)));
        return;
      }
    }
    // Gated behind GitHub login: learn the login state first, and only load
    // files/chat history for connected sessions. Anonymous visitors land on
    // the gate; the 302 to / after OAuth re-runs this connected.
    const g = await fetch("/api/github/status", { cache: "no-store" }).then((r) => r.json());
    ghStatus = g;
    authed = !!(g && g.connected);
    syncGateTabs();
    updateRepoBadge(g && g.linked);
    if (!authed) { loading.remove(); mBuilt.textContent = "idle"; renderPane(); return; }
    // no-store: /api/state runs a build, so any cached copy is already wrong.
    const s = await apiFetch("/api/state", { cache: "no-store" }).then((r) => r.json());
    if (s.error) {
      // Logged out between the status check and here (logout in another tab):
      // fall back to the gate instead of a stuck error.
      if (s.error === "github login required") { loading.remove(); mBuilt.textContent = "idle"; showGate(); return; }
      throw new Error(s.error);
    }
    files = s.files || files;
    built = s.built;
    if (typeof s.version === "number") filesVersion = s.version;
    setMetrics(built);
    renderHistory(s.messages);
    renderPane();
  } catch (e) {
    loading.remove();
    mBuilt.textContent = "state error";
    mBuilt.className = "failed";
    log.appendChild(el("div", "err", "could not load state: " + (e.message ?? e)));
  } finally {
    booting = false;
    sendBtn.disabled = false;
  }
})();
</script>
</body>
</html>`;