import { DEFAULT_GATEWAY, DEFAULT_MODEL, GO_MODELS, ZEN_MODELS } from "../agent";
import { inlineLocalAssets, pickPreviewHtml, resolveAssetRef } from "../preview-assets";
import { markdownToHtml } from "../markdown";
import { PAGE_HEAD } from "../client/head";
import { CORE_A, CORE_B } from "../client/core";
import { STATE_JS } from "../client/state";
import { TRANSCRIPT_JS } from "../client/transcript";
import { HISTORY_JS } from "../client/history";
import { PANE_JS } from "../client/pane";
import { SETTINGS_A_JS } from "../client/settings-a";
import { SETTINGS_B_JS } from "../client/settings-b";
import { ATTACH_JS } from "../client/attachments";
import { AGENT_JS } from "../client/agent";
import { TABS_JS } from "../client/tabs";

export const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Full document for the live app iframe: boot state plus the client bundle. */
export const appDoc = (
  bundle: string | null,
  boot: { sid: string; preview: string; api: { state: string; mutate: string }; state: unknown; error: unknown },
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>capsule app</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing:border-box; }
  html, body { max-width:100%; overflow-x:clip; }
  body { margin:0; background:#08090a; color:#e8eaeb;
         font:14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; padding:20px 20px 40px; }
  #app, main { min-width:0; max-width:100%; }
  img, video, canvas, table { max-width:100%; height:auto; }
  table { display:block; overflow-x:auto; }
  h1 { font-size:22px; letter-spacing:-.2px; }
  button { background:#d8f06a; color:#111; border:0; border-radius:8px; padding:10px 16px;
           font-weight:600; font-size:14px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  input, textarea, select { background:#0e1011; color:#e8eaeb; border:1px solid #232627;
           border-radius:8px; padding:9px 11px; font:inherit; }
  ul { padding-left:1.2em; } li { margin:4px 0; }
  pre { white-space:pre-wrap; overflow-wrap:anywhere; }
  .app-error { font:12px/1.6 ui-monospace, monospace; color:#ffa39b; white-space:pre-wrap; }
  @media (pointer:coarse), (max-width:768px) {
    body { padding:16px 16px 32px; }
    input, textarea, select, button { font-size:16px; }
  }
</style>
</head>
<body>
<div id="app">${bundle === null ? `<main><h1>App failed to build</h1><pre class="app-error">${escHtml((boot.error as { message?: string } | null)?.message ?? "unknown error")}</pre></main>` : "<main>Loading…</main>"}</div>
<script>window.__APP_BOOT__ = ${JSON.stringify(boot).replace(/</g, "\\u003c")};</script>
${bundle === null ? "" : `<script type="module">${bundle.replace(/<\/script/gi, "<\\/script")}</script>`}
</body>
</html>`;

/** App shell page: static head plus the client script assembled from src/client/*. */
export const page = () =>
  PAGE_HEAD +
  `const GATEWAYS = { zen: ${JSON.stringify(ZEN_MODELS)}, go: ${JSON.stringify(GO_MODELS)} };\n` +
  `const DEFAULT_GATEWAY = ${JSON.stringify(DEFAULT_GATEWAY)};\n` +
  `const DEFAULT_MODEL = ${JSON.stringify(DEFAULT_MODEL)};\n` +
  CORE_A +
  `${pickPreviewHtml}\n${resolveAssetRef}\n${inlineLocalAssets}\n` +
  CORE_B +
  `${markdownToHtml}\n` +
  STATE_JS +
  TRANSCRIPT_JS +
  HISTORY_JS +
  PANE_JS +
  SETTINGS_A_JS +
  SETTINGS_B_JS +
  ATTACH_JS +
  AGENT_JS +
  TABS_JS +
  `</script>\n</body>\n</html>`;
