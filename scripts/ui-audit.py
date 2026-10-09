#!/usr/bin/env python3
"""
Browser audit of the served UI: desktop interactions plus the iPhone SE
(375x667) mobile layout, plus TypeScript type-checking through the Code tab.

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

The typecheck section pins the build/type split through the real
Code-tab UI: Save-and-build runs sucrase + QuickJS (strips types without
checking them) plus the real ts_rust.wasm check, whose verdict rides along
on the build result without blocking it. So a pure type error still builds
and the preview keeps running — but it is now reported: the header metric
counts it and an amber strip in the Code view names the TS error.
`lint`/`deploy` remain the blocking gates. A shape error is still blocked
with a red banner.

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
    # Hostile environment: an injected script breaks fetch the way a broken
    # iOS native bridge does. Runs here because the tab clicks below rebuild
    # the pane DOM and detach this frame object. The app must explain, not hang or go blank.
    frame.evaluate("() => { window.fetch = () => Promise.reject(new Error('WKWebView API client did not respond to this postMessage')); }")
    frame.wait_for_selector("text=content blocker", timeout=20000)
    check("desktop: broken native bridge shows actionable guidance",
          frame.locator("text=turn it off for this site").count() == 1)
    check("desktop: bridge failure keeps a Retry path",
          frame.locator("button:has-text(\"Retry\")").count() == 1)
    # Same failure in Brave names Shields: stub the Brave-only property, then
    # Retry re-renders the boundary against it.
    brave_stuck = frame.evaluate("() => { try { window.navigator.brave = { isBrave: () => Promise.resolve(true) }; return !!window.navigator.brave; } catch (e) { return false; } }")
    check("desktop: Brave marker can be simulated", brave_stuck is True, repr(brave_stuck))
    frame.locator("button:has-text(\"Retry\")").click()
    frame.wait_for_selector("text=Brave Shields is blocking", timeout=20000)
    check("desktop: Brave bridge failure names Shields",
          frame.locator("text=lion icon in the address bar").count() == 1)
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
    # The Database/Logs subtabs only exist inside the Preview view, so return
    # via the header tab (the subtab row is hidden while in Resources).
    pg.locator('[data-view="preview"]').click()
    pg.wait_for_timeout(400)
    overflow = pg.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check("desktop: no horizontal overflow", overflow <= 1, f"overflow={overflow}px")
    check("desktop: no page errors", len(errors) == 0, "; ".join(errors[:3]))
    check("desktop: no console errors", len([c for c in conerrs if "ethereum" not in c]) == 0, "; ".join(conerrs[:3]))
    pg.close()

    # ---- TypeScript type checking (Code tab -> Save and build) ----
    # Fresh page == fresh session cookie, so the bridge-breaking above and
    # the file probes below never share a Durable Object.
    tp = browser.new_page(viewport={"width": 1280, "height": 800})
    tperrors = []
    tp.on("pageerror", lambda e: tperrors.append(str(e)))
    tp.goto(url, wait_until="networkidle", timeout=30000)
    tp.wait_for_timeout(2500)
    tp.locator('[data-view="code"]').click()
    tp.wait_for_timeout(400)
    check("typecheck: Code tab shows editor", tp.locator("#editor").count() == 1)
    tree_entry = tp.locator("#tree div:has-text(\"server/index.ts\")")
    if tree_entry.count() >= 1:
        tree_entry.first.click()
        tp.wait_for_timeout(400)
    original = tp.locator("#editor").input_value() if tp.locator("#editor").count() == 1 else ""
    check("typecheck: server file carries type annotations",
          "string" in original and "import" in original, original[:200])

    def tp_save_and_wait(want):
        tp.locator("#save").click()
        # The save handler flips the button to "Building…" synchronously;
        # wait for that first so a wait for an already-matching #m-built
        # value cannot return before this save's POST completes.
        try:
            tp.wait_for_function(
                "document.getElementById('save') && document.getElementById('save').textContent.includes('Building')",
                timeout=10000,
            )
        except Exception:
            pass
        try:
            # Prefix match: the metric appends "· N type errors" when the
            # type checker reports diagnostics.
            tp.wait_for_function(
                f"document.getElementById('m-built') && document.getElementById('m-built').textContent.startsWith('{want}')"
                " && document.getElementById('save') && document.getElementById('save').textContent.includes('Save')",
                timeout=60000,
            )
            return True
        except Exception:
            return False

    if original:
        # A pure semantic error: wrong type, valid runtime. sucrase strips
        # the annotation so the build still passes — but the type checker's
        # verdict now rides along on the build result and renders as an
        # amber strip in the Code view, while the preview keeps working.
        probe = original + "\n// typecheck probe: semantic error only, runtime is unaffected\nexport const _typeProbe: number = \"forty\";\n"
        tp.locator("#editor").fill(probe)
        check("typecheck: semantic type error still builds (preview keeps running)",
              tp_save_and_wait("built"), tp.locator("#m-built").inner_text() if tp.locator("#m-built").count() == 1 else "?")
        check("typecheck: header metric counts the type errors",
              "type error" in (tp.locator("#m-built").inner_text() if tp.locator("#m-built").count() == 1 else ""),
              tp.locator("#m-built").inner_text() if tp.locator("#m-built").count() == 1 else "?")
        diag_text = tp.locator(".diag").inner_text() if tp.locator(".diag").count() >= 1 else ""
        check("typecheck: semantic type error is reported in the Code view",
              tp.locator(".diag").count() >= 1 and ("TS2322" in diag_text or "type error" in diag_text),
              diag_text[:220])
        tp.locator('[data-view="preview"]').click()
        tp.wait_for_timeout(400)
        check("typecheck: preview still renders the live app despite the type error",
              tp.locator("#appframe").count() == 1)
        tp.locator('[data-view="code"]').click()
        tp.wait_for_timeout(400)
        roundtrip = tp.locator("#editor").input_value() if tp.locator("#editor").count() == 1 else ""
        check("typecheck: annotations round-trip through save",
              "_typeProbe" in roundtrip and ": number" in roundtrip, roundtrip[-200:])
        # Restore before the next probe so failures never leak into later tabs.
        tp.locator("#editor").fill(original)
        check("typecheck: restoring the file rebuilds clean",
              tp_save_and_wait("built"))
        # A shape error the builder does catch: no capsule default export.
        # This must be blocked (m-built flips to failed), proving
        # Save-and-build surfaces build failures rather than passing
        # everything. The banner itself renders in the Preview view, so
        # switch there to assert it.
        tp.locator("#editor").fill("export default 42;\n")
        check("typecheck: shape error is blocked",
              tp_save_and_wait("failed"), tp.locator("#m-built").inner_text() if tp.locator("#m-built").count() == 1 else "?")
        tp.locator('[data-view="preview"]').click()
        tp.wait_for_timeout(400)
        banner_text = tp.locator(".banner").inner_text() if tp.locator(".banner").count() >= 1 else ""
        check("typecheck: shape error shows a build banner in Preview",
              tp.locator(".banner").count() >= 1 and ("capsule" in banner_text.lower() or "build" in banner_text.lower() or "error" in banner_text.lower()),
              banner_text[:220])
        tp.locator('[data-view="code"]').click()
        tp.wait_for_timeout(400)
        tp.locator("#editor").fill(original)
        check("typecheck: restoring after the shape error rebuilds clean",
              tp_save_and_wait("built"))
    else:
        check("typecheck: could not read the editor, probes skipped", False, "empty editor")
    check("typecheck: no page errors", len(tperrors) == 0, "; ".join(tperrors[:3]))
    tp.close()

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
