// @ts-nocheck — serialized into the served page via Function.prototype.toString,
// so this source must stay annotation-free (valid plain JS), self-contained
// (no imports, no free variables), and free of any inline-script terminator.
// Behavior is pinned by tests/markdown.test.ts instead.
// NOTE: the worker TS transform wraps nested closures with a __name helper
// that has no browser definition; src/index.ts provides the identity shim
// before this serialized code. Only arrow functions and anonymous callbacks
// are used inside to keep the transform output stable.
/**
 * Minimal safe markdown renderer for assistant chat bubbles.
 * Runs in two places: unit-tested here, and serialized into the served page
 * via `Function.prototype.toString`, so it must stay self-contained.
 * Only emits an allowlist of tags (h1-h4, p, ul, ol, li, blockquote, pre,
 * code, strong, em, del, a, br, hr). Everything else is escaped.
 * Links, images, autolinks and bare URLs are parsed on the RAW text before
 * escaping (so titles match and query strings survive), each URL escaped
 * exactly once; emphasis runs later on escaped text while anchors sit in
 * placeholders, so `__`/`**` inside an href can never corrupt it.
 * @param {string} src
 * @returns {string}
 */
export function markdownToHtml(src) {
  var esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  // Allowlist check only — no escaping here, so callers escape exactly once.
  var isSafeUrl = (u) => /^(https?:\/\/|mailto:)/i.test(String(u || "").trim());
  // Emphasis only (bold/italic/strike) on escaped text. Anchors and code are
  // placeholders at this stage, so this can never rewrite an href.
  var emphasis = (s) => {
    var out = s;
    out = out.replace(/\*\*([^*<>]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_<>]+)__/g, "<strong>$1</strong>");
    out = out.replace(/~~([^~<>]+)~~/g, "<del>$1</del>");
    out = out.replace(/\*([^*<>\n]+)\*/g, "<em>$1</em>");
    out = out.replace(/(^|[\s(])_([^_<>\n]+)_/g, "$1<em>$2</em>");
    return out;
  };
  var text = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
  // Fenced code blocks first (unclosed fence runs to EOF so a streaming
  // half-block still reads as code instead of paragraph noise).
  var fences = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)(```|$)/g, (m, lang, code) => {
    var i = fences.length;
    fences.push({ lang: (lang || "").slice(0, 20), code: code.replace(/\n$/, "") });
    return "\n\x00" + i + "\x00\n";
  });
  // Inline code spans (no newlines inside single-backtick spans).
  var spans = [];
  text = text.replace(/`([^`\n]+)`/g, (m, code) => {
    var i = spans.length;
    spans.push(code);
    return "\x01" + i + "\x01";
  });
  // Links/images/autolinks/bare URLs on RAW text; each becomes a placeholder
  // holding the final anchor, URL escaped exactly once. Images render as a
  // link with the alt text (never an <img>, so no third-party bytes load).
  var anchors = [];
  var restoreCode = (s) => s.replace(/\x01(\d+)\x01/g, (m, i) => "<code>" + esc(spans[+i]) + "</code>");
  // fmt=true for explicit link/image labels (emphasis + code restored);
  // false when the label IS the URL (autolink/bare), where emphasis must
  // never rewrite the visible URL text.
  var anchorFor = (label, url, fmt) => {
    if (!isSafeUrl(url)) return null;
    var i = anchors.length;
    var labelHtml = fmt ? emphasis(restoreCode(esc(label))) : esc(String(url).trim());
    anchors.push(
      '<a href="' + esc(String(url).trim()) + '" target="_blank" rel="noopener">' + labelHtml + "</a>",
    );
    return "\x02" + i + "\x02";
  };
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
    var a = anchorFor(alt, url, true);
    return a === null ? alt : a;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, url) => {
    var a = anchorFor(label, url, true);
    return a === null ? label : a;
  });
  text = text.replace(/<(https?:\/\/[^\s<>]+)>/g, (m, url) => {
    var a = anchorFor(url, url, false);
    return a === null ? m : a;
  });
  // Bare URLs last (links above are placeholders now, so their hrefs cannot
  // match). Split out code/anchor placeholders and linkify text parts only,
  // so a URL after inline code still links instead of being skipped.
  var linkBare = (seg) =>
    seg.replace(/(^|[\s(])(https?:\/\/[^\s<>"')\]]+)/g, (m, pre, url) => {
      var a = anchorFor(url, url, false);
      return a === null ? m : pre + a;
    });
  text = text
    .split(/(\x01\d+\x01|\x02\d+\x02)/g)
    .map((seg, k) => (k % 2 === 1 ? seg : linkBare(seg)))
    .join("");
  // Escape everything left (placeholders survive untouched), then restore
  // inline code; anchors restore per-block after emphasis.
  text = esc(text);
  text = restoreCode(text);
  var restoreAnchors = (s) => s.replace(/\x02(\d+)\x02/g, (m, i) => anchors[+i]);
  // Block structure over escaped text with placeholders.
  var lines = text.split("\n");
  var html = "";
  var para = [];
  var listTag = null;
  var quote = [];
  var listItems = [];
  var flushPara = () => {
    if (!para.length) return;
    html += "<p>" + restoreAnchors(emphasis(para.join("<br>"))) + "</p>";
    para = [];
  };
  var flushList = () => {
    if (!listTag) return;
    html += listTag === "ul" ? "<ul>" : "<ol>";
    for (var i = 0; i < listItems.length; i++)
      html += "<li>" + restoreAnchors(emphasis(listItems[i])) + "</li>";
    html += listTag === "ul" ? "</ul>" : "</ol>";
    listTag = null;
    listItems = [];
  };
  var flushQuote = () => {
    if (!quote.length) return;
    html += "<blockquote>" + restoreAnchors(emphasis(quote.join("<br>"))) + "</blockquote>";
    quote = [];
  };
  for (var n = 0; n < lines.length; n++) {
    var line = lines[n];
    var fence = line.match(/^\x00(\d+)\x00$/);
    if (fence) {
      flushPara();
      flushList();
      flushQuote();
      var f = fences[+fence[1]];
      var cls = f.lang ? ' class="lang-' + esc(f.lang) + '"' : "";
      html += "<pre><code" + cls + ">" + esc(f.code) + "</code></pre>";
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      flushQuote();
      continue;
    }
    var h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      flushQuote();
      var lvl = Math.min(h[1].length, 4);
      html += "<h" + lvl + ">" + restoreAnchors(emphasis(h[2])) + "</h" + lvl + ">";
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushPara();
      flushList();
      flushQuote();
      html += "<hr>";
      continue;
    }
    var q = line.match(/^&gt;\s?(.*)$/);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
      continue;
    } else if (quote.length) {
      flushQuote();
    }
    var ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (listTag !== "ul") {
        flushList();
        listTag = "ul";
      }
      listItems.push(ul[1]);
      continue;
    }
    var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listTag !== "ol") {
        flushList();
        listTag = "ol";
      }
      listItems.push(ol[1]);
      continue;
    }
    if (listTag) flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  flushQuote();
  return html || "<p></p>";
}
