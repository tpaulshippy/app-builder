// @ts-nocheck — this module's functions are serialized into the served page
// via Function.prototype.toString, so their source must stay annotation-free
// (valid plain JS). Behavior is pinned by tests/preview-assets.test.ts instead.
/**
 * Pure helpers for the Preview tab's static-html fallback (repos without a
 * capsule). They run in two places: unit-tested here, and serialized into
 * the served page via `Function.prototype.toString`, so they must stay
 * self-contained (no imports, no free variables) and free of any literal
 * `</script` sequence, which would terminate the page's inline script block.
 */

/**
 * Default html file for Preview: the root index.html first, then any nested
 * index.html, then the first sorted html file. The sorted `find` the page
 * used before preferred `docs/index.html` over the root one.
 * @param {Record<string, string>} files
 * @returns {string | null}
 */
export function pickPreviewHtml(files) {
  const htmlFiles = Object.keys(files)
    .filter((p) => p.toLowerCase().endsWith(".html"))
    .sort();
  if (htmlFiles.length === 0) return null;
  const lowered = htmlFiles.map((p) => p.toLowerCase());
  const root = htmlFiles[lowered.indexOf("index.html")];
  if (root !== undefined) return root;
  return htmlFiles.find((p) => p.toLowerCase().endsWith("/index.html")) ?? htmlFiles[0] ?? null;
}

/**
 * Resolve a repo-relative asset ref against the html file's directory.
 * Returns the FileMap key, or null for external/absolute/missing refs.
 * @param {Record<string, string>} files
 * @param {string} htmlFile
 * @param {string} ref
 * @returns {string | null}
 */
export function resolveAssetRef(files, htmlFile, ref) {
  // Refs that never resolve to repo files: absolute URLs, protocol-relative, data/blob, anchors.
  const EXTERNAL_REF = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;
  if (EXTERNAL_REF.test(ref) || ref.startsWith("/")) return null;
  const clean = (ref.split("#")[0] ?? "").split("?")[0] ?? "";
  if (!clean) return null;
  const dir = htmlFile.includes("/") ? htmlFile.slice(0, htmlFile.lastIndexOf("/") + 1) : "";
  const out = [];
  for (const seg of (dir + clean).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  const key = out.join("/");
  // `in` also matches inherited properties (toString, constructor), whose
  // values are functions — reading `.replace` off one would throw below.
  return Object.prototype.hasOwnProperty.call(files, key) ? key : null;
}

/**
 * Inline same-repo stylesheets and scripts into the html. The fallback frame
 * is a sandboxed srcdoc iframe on an opaque origin, where even parent-made
 * blob: subresources are blocked — so relative CSS/JS would otherwise never
 * load and every multi-file static page would preview unstyled and inert.
 * Remote, absolute, and missing refs pass through untouched; binary assets
 * (images) cannot round-trip through the text-only FileMap and are left as-is.
 * @param {Record<string, string>} files
 * @param {string} htmlFile
 * @param {string} html
 * @returns {string}
 */
export function inlineLocalAssets(files, htmlFile, html) {
  const withCss = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel=["']?stylesheet["']?/i.test(tag)) return tag;
    const href = tag.match(/href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    const ref = href ? (href[1] ?? href[2] ?? href[3] ?? "") : "";
    const key = ref ? resolveAssetRef(files, htmlFile, ref) : null;
    if (key === null) return tag;
    const css = files[key] ?? "";
    return "<style>" + css.replace(/<\/style/gi, "<\\/style") + "</style>";
  });
  return withCss.replace(
    /<script\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>\s*<\/script\s*>/gi,
    (tag, dq, sq, uq) => {
      const key = resolveAssetRef(files, htmlFile, String(dq ?? sq ?? uq ?? ""));
      if (key === null) return tag;
      // Keep the original opening tag minus src, so type="module", defer,
      // and friends survive inlining.
      const open = tag
        .slice(0, tag.indexOf(">"))
        .replace(/\ssrc=(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "");
      const js = files[key] ?? "";
      // Neutralize closing tags inside the inlined code, then emit a real
      // closing tag: the escaped form would never close the srcdoc element.
      return open + ">" + js.replace(/<\/script/gi, "<\\/script") + "<" + "/script>";
    },
  );
}
