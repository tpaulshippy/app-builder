#!/usr/bin/env python3
"""
Browser audit of the served UI: desktop interactions plus the iPhone SE
(375x667) mobile layout.

    APP_URL=http://localhost:8910 python3 scripts/ui-audit.py
    python3 scripts/ui-audit.py --url https://app-builder.pshippy-245.workers.dev/

Requires Python Playwright and a Chromium build:

    pip install playwright
    playwright install chromium

The audit drives the real page rather than reimplementing its logic, so a
green run means the shipped HTML/CSS/JS actually behaves: the header tabs
switch panes (the Code tab once silently kept rendering preview), nothing
overflows horizontally at 375px, the send button meets a 40px touch target,
inputs stay at 16px so iOS Safari does not auto-zoom, and the pane scrolls
instead of clipping long output.

Exit status is 1 when any check fails. A screenshot of the mobile code view
and the full JSON results are written to --out-dir (a temp dir by default).
"""

import json
import os
import sys
import tempfile
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("error: Python Playwright is not installed (pip install playwright)", file=sys.stderr)
    sys.exit(2)

argv = sys.argv[1:]
url = "https://app-builder.pshippy-245.workers.dev/"
if "--url" in argv and argv.index("--url") + 1 < len(argv):
    url = argv[argv.index("--url") + 1]
else:
    url = os.environ.get("APP_URL", url)
out_dir = Path(argv[argv.index("--out-dir") + 1] if "--out-dir" in argv else tempfile.mkdtemp(prefix="ui-audit-"))
out_dir.mkdir(parents=True, exist_ok=True)

results = {"url": url, "checks": []}


def check(label, ok, detail=""):
    results["checks"].append({"label": label, "ok": bool(ok), "detail": str(detail)[:600]})
    print(("PASS " if ok else "FAIL ") + label + (f" -- {detail[:220]}" if detail and not ok else ""))


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    # ---- desktop ----
    pg = browser.new_page(viewport={"width": 1280, "height": 800})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    conerrs = []
    pg.on("console", lambda m: conerrs.append(m.text) if m.type == "error" else None)
    pg.goto(url, wait_until="networkidle", timeout=30000)
    pg.wait_for_timeout(2500)
    check("desktop: page loads, header present", pg.locator("header").count() == 1)
    check("desktop: chat log present", pg.locator("#log").count() == 1)
    check("desktop: composer input present", pg.locator("#input").count() == 1)
    check("desktop: send button present", pg.locator("#send").count() == 1)
    check("desktop: pane renders (no state error)", "state error" not in (pg.locator("#m-built").inner_text() or ""))
    # The Preview tab is the live app now, not a snapshot: an opaque-origin
    # sandboxed iframe running the real client bundle against the isolate.
    check("desktop: Preview shows the live app iframe", pg.locator("#appframe").count() == 1)
    sandbox_attr = pg.locator("#appframe").get_attribute("sandbox") or ""
    check("desktop: app iframe is opaque-origin (no allow-same-origin)",
          "allow-same-origin" not in sandbox_attr, sandbox_attr)
    import re as _re
    pg.locator("#appframe").wait_for(timeout=15000)
    frame = None
    for _ in range(40):
        frame = pg.frame(url=_re.compile(r"/api/app\?sid="))
        if frame:
            break
        pg.wait_for_timeout(500)
    check("desktop: app frame attached", frame is not None)
    if frame is None:
        raise SystemExit(1)
    frame.wait_for_selector("text=Todos", timeout=25000)
    check("desktop: app renders client pixels (Todos)", frame.locator("text=Todos").count() >= 1)
    check("desktop: app shows the Add button", frame.locator("button:has-text(\"Add\")").count() == 1)
    # Mutation round-trip through the isolate: click Add, a row persists.
    frame.locator("button:has-text(\"Add\")").click()
    frame.wait_for_selector("li:has-text(\"New todo\")", timeout=15000)
    check("desktop: Add button persists a todo via the isolate",
          frame.locator("li:has-text(\"New todo\")").count() == 1)
    # Isolation: the BYOK key in the parent's storage must not leak in.
    pg.evaluate("localStorage.setItem('ab_key', 'sentinel-parent')")
    try:
        leaked = frame.evaluate("localStorage.getItem('ab_key')")
    except Exception:
        leaked = "sandbox-blocked"
    check("desktop: parent API key invisible in app iframe",
          leaked is None or leaked == "sandbox-blocked", repr(leaked))
    parent_access = frame.evaluate(
        "() => { try { return window.parent.location.href; } catch (e) { return 'blocked:' + e.constructor.name; } }")
    check("desktop: app iframe cannot reach the parent page",
          isinstance(parent_access, str) and parent_access.startswith("blocked"), str(parent_access))
    # Tab interaction: the Code tab once kept rendering preview because the
    # header view state never reached the pane renderer.
    pg.locator('[data-view="code"]').click()
    pg.wait_for_timeout(400)
    check("desktop: Code tab shows editor", pg.locator("#editor").count() == 1,
          f"editor count={pg.locator('#editor').count()}, pane html len={len(pg.locator('#pane').inner_html())}")
    pg.locator('[data-view="resources"]').click()
    pg.wait_for_timeout(400)
    pane_text = pg.locator("#pane").inner_text()
    check("desktop: Resources tab shows runtime info", "QuickJS" in pane_text, pane_text[:200])
    pg.locator('[data-pane="preview"]').click()
    pg.wait_for_timeout(400)
    overflow = pg.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check("desktop: no horizontal overflow", overflow <= 1, f"overflow={overflow}px")
    check("desktop: no page errors", len(errors) == 0, "; ".join(errors[:3]))
    check("desktop: no console errors", len([c for c in conerrs if "ethereum" not in c]) == 0, "; ".join(conerrs[:3]))
    # Hostile environment: an injected script breaks fetch the way a broken
    # iOS native bridge does. The app must explain, not hang or go blank.
    # Re-acquire: the tab clicks above rebuilt the pane DOM and detached it.
    pg.locator('[data-pane="preview"]').click()
    pg.wait_for_timeout(400)
    pg.locator("#appframe").wait_for(timeout=15000)
    for _ in range(40):
        frame = pg.frame(url=_re.compile(r"/api/app\?sid="))
        if frame:
            break
        pg.wait_for_timeout(500)
    frame.evaluate("() => { window.fetch = () => Promise.reject(new Error('WKWebView API client did not respond to this postMessage')); }")
    frame.wait_for_selector("text=content blocker", timeout=20000)
    check("desktop: broken native bridge shows actionable guidance",
          frame.locator("text=turn it off for this site").count() == 1)
    check("desktop: bridge failure keeps a Retry path",
          frame.locator("button:has-text(\"Retry\")").count() == 1)
    pg.close()

    # ---- iPhone SE (375x667, DPR2) ----
    ctx = browser.new_context(viewport={"width": 375, "height": 667}, device_scale_factor=2,
                              is_mobile=True, has_touch=True,
                              user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
    mp = ctx.new_page()
    merrors = []
    mp.on("pageerror", lambda e: merrors.append(str(e)))
    mp.goto(url, wait_until="networkidle", timeout=30000)
    mp.wait_for_timeout(2500)
    moverflow = mp.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check("mobile: no horizontal page overflow", moverflow <= 1, f"overflow={moverflow}px")
    layout = mp.evaluate("""() => {
      const main = document.querySelector('main');
      const chat = document.getElementById('chat');
      const right = document.getElementById('right');
      const cs = getComputedStyle(main);
      const cr = chat.getBoundingClientRect();
      const rr = right.getBoundingClientRect();
      return {gridCols: cs.gridTemplateColumns, flexDir: cs.flexDirection, display: cs.display,
              chatW: Math.round(cr.width), chatTop: Math.round(cr.top),
              rightW: Math.round(rr.width), rightTop: Math.round(rr.top),
              sideBySide: Math.abs(cr.top - rr.top) < 5 && cr.width < 370 && rr.width < 370};
    }""")
    check("mobile: chat/right not cramped side-by-side", layout.get("sideBySide") is False, json.dumps(layout))
    header = mp.evaluate("""() => {
      const h = document.querySelector('header');
      return {scrollW: h.scrollWidth, clientW: h.clientWidth, overflow: h.scrollWidth - h.clientWidth};
    }""")
    check("mobile: header does not overflow", header["overflow"] <= 1, json.dumps(header))
    sendbox = mp.evaluate("() => { const r = document.getElementById('send').getBoundingClientRect(); return {w: r.width, h: r.height}; }")
    check("mobile: send button >=40px touch target", sendbox["w"] >= 40 and sendbox["h"] >= 40, json.dumps(sendbox))
    fsize = mp.evaluate("() => parseFloat(getComputedStyle(document.getElementById('input')).fontSize)")
    check("mobile: input font-size >=16px (no iOS zoom)", fsize >= 16, f"font-size={fsize}px")
    panscroll = mp.evaluate("""() => {
      const pane = document.getElementById('pane');
      const cs = getComputedStyle(pane);
      return {overflow: cs.overflow, overflowY: cs.overflowY};
    }""")
    check("mobile: pane scrollable (overflow-y auto)", panscroll.get("overflowY") in ("auto", "scroll"), json.dumps(panscroll))
    mp.locator('[data-view="code"]').click()
    mp.wait_for_timeout(400)
    codelayout = mp.evaluate("""() => {
      const code = document.getElementById('code');
      if (!code) return {missing: true};
      const cs = getComputedStyle(code);
      const ed = document.getElementById('editor').getBoundingClientRect();
      return {gridCols: cs.gridTemplateColumns, flexDir: cs.flexDirection, editorW: Math.round(ed.width)};
    }""")
    check("mobile: code view editor usable (width>=200 or stacked)",
          codelayout.get("missing") is not True and (codelayout.get("editorW", 0) >= 200 or "column" in str(codelayout)),
          json.dumps(codelayout))
    check("mobile: no page errors", len(merrors) == 0, "; ".join(merrors[:3]))
    mp.screenshot(path=str(out_dir / "mobile-se.png"), full_page=False)
    ctx.close()
    browser.close()

fails = [c for c in results["checks"] if not c["ok"]]
print(f"\n{len(results['checks']) - len(fails)}/{len(results['checks'])} checks passed")
print(f"results + screenshot in {out_dir}")
(out_dir / "results.json").write_text(json.dumps(results, indent=2))
sys.exit(1 if fails else 0)
