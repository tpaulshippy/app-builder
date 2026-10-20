export const PAGE_HEAD = `<!doctype html>
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
`;
