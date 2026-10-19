// @ts-nocheck — serialized into the served page via Function.prototype.toString,
// so this source must stay annotation-free (valid plain JS), self-contained
// (no imports, no free variables), and free of any inline-script terminator.
// Behavior is pinned by tests/markdown.test.ts instead.
// NOTE: no nested `function name()` declarations — the worker TS transform
// wraps those with a __name helper that does not exist in the browser.
// Only arrow functions and anonymous callbacks are used inside.
/**
 * Minimal safe markdown renderer for assistant chat bubbles.
 * Runs in two places: unit-tested here, and serialized into the served page
 * via `Function.prototype.toString`, so it must stay self-contained.
 * Only emits an allowlist of tags (h1-h4, p, ul, ol, li, blockquote, pre,
 * code, strong, em, del, a, br, hr). Everything else is escaped.
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
  var safeHref = (u) => {
    var url = String(u || "").trim();
    if (/^(https?:\/\/|mailto:)/i.test(url)) return esc(url);
    return null;
  };
  var inlineFmt = (s) => {
    var out = s;
    // images: render as a link with the alt text (never an <img>, so no
    // third-party bytes load from model output).
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
      var h = safeHref(url);
      if (!h) return alt;
      return '<a href="' + h + '" target="_blank" rel="noopener">' + alt + "</a>";
    });
    // links
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, text, url) => {
      var h = safeHref(url);
      if (!h) return text;
      return '<a href="' + h + '" target="_blank" rel="noopener">' + text + "</a>";
    });
    // autolink <https://...>
    out = out.replace(/&lt;(https?:\/\/[^&\s<>]+)&gt;/g, (m, url) => {
      var h = safeHref(url);
      if (!h) return m;
      return '<a href="' + h + '" target="_blank" rel="noopener">' + h + "</a>";
    });
    // bold **x** and __x__
    out = out.replace(/\*\*([^*<>]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_<>]+)__/g, "<strong>$1</strong>");
    // strikethrough ~~x~~
    out = out.replace(/~~([^~<>]+)~~/g, "<del>$1</del>");
    // italic *x* and _x_ (after bold so ** is already consumed)
    out = out.replace(/\*([^*<>\n]+)\*/g, "<em>$1</em>");
    out = out.replace(/(^|[\s(])_([^_<>\n]+)_/g, "$1<em>$2</em>");
    // bare URLs, skipping text already inside <a>...</a>
    var parts = out.split(/(<a\b[^>]*>.*?<\/a>)/g);
    for (var k = 0; k < parts.length; k++) {
      if (k % 2 === 1) continue;
      if (parts[k].indexOf("<code") !== -1) continue;
      parts[k] = parts[k].replace(/(^|[\s(])(https?:\/\/[^\s<>"')\]]+)/g, (m, pre, url) => {
        var h = safeHref(url);
        if (!h) return m;
        return pre + '<a href="' + h + '" target="_blank" rel="noopener">' + h + "</a>";
      });
    }
    return parts.join("");
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
  text = esc(text);
  text = text.replace(/\x01(\d+)\x01/g, (m, i) => "<code>" + esc(spans[+i]) + "</code>");
  var lines = text.split("\n");
  var html = "";
  var para = [];
  var listTag = null;
  var quote = [];
  var listItems = [];
  var flushPara = () => {
    if (!para.length) return;
    html += "<p>" + inlineFmt(para.join("<br>")) + "</p>";
    para = [];
  };
  var flushList = () => {
    if (!listTag) return;
    html += listTag === "ul" ? "<ul>" : "<ol>";
    for (var i = 0; i < listItems.length; i++) html += "<li>" + inlineFmt(listItems[i]) + "</li>";
    html += listTag === "ul" ? "</ul>" : "</ol>";
    listTag = null;
    listItems = [];
  };
  var flushQuote = () => {
    if (!quote.length) return;
    html += "<blockquote>" + inlineFmt(quote.join("<br>")) + "</blockquote>";
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
      html += "<h" + lvl + ">" + inlineFmt(h[2]) + "</h" + lvl + ">";
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
