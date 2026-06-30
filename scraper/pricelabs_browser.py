#!/usr/bin/env python3
"""
PriceLabs browser automation — login + discovery/export (for the daily Cowork job)
==================================================================================
Drives a real browser (Playwright/Chromium) to log into PriceLabs and pull a
Market Dashboard's data, so a scheduled Cowork session can refresh the Hub daily
WITHOUT ssh or a shared folder — the companion `pricelabs_csv.py` then POSTs the
result to your app's public URL.

WHY A DISCOVERY STEP: the PriceLabs UI (login fields, the per-report CSV "export"
controls, the dashboard's data requests) can't be scripted blind. Run this once in
discovery mode; it logs in and dumps, to a capture dir:
  - every JSON request the dashboard makes (xhr/fetch)   -> network/*.json
  - a full-page screenshot + the page HTML                -> page-*.png / page-*.html
  - candidate "export / download / CSV" controls it found -> manifest.json
Send me that capture dir (or its manifest + a screenshot) and I'll wire the exact
export — either clicking the CSV buttons or reading the dashboard's own JSON.

    python pricelabs_browser.py --discovery          # log in + capture (default)
    python pricelabs_browser.py --download            # also click export controls
    PRICELABS_HEADFUL=1 python pricelabs_browser.py    # watch it (local debugging)

Env (set as Cowork secrets / shell env — NEVER commit):
    PRICELABS_EMAIL, PRICELABS_PASSWORD     login
    PRICELABS_DASHBOARD_URLS                comma-separated Market Dashboard URL(s)
                                            (the page you export reports from)
    PRICELABS_LOGIN_URL                     default https://app.pricelabs.co/signin
    PRICELABS_STATE                         saved session (default .pricelabs_state.json)
    PRICELABS_CAPTURE_DIR                   default pricelabs-captures/
    PRICELABS_DOWNLOAD_DIR                  default pricelabs-downloads/
    PROXY_URL                               optional residential proxy
    PLAYWRIGHT_CHROMIUM                     explicit chromium path (else auto-detect)
    PRICELABS_*_SEL                         override a selector if discovery shows a better one
                                            (EMAIL_SEL / PASSWORD_SEL / SUBMIT_SEL)

Install: pip install playwright   (Cowork already ships Chromium; no `playwright install`)
"""

import glob
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LOGIN_URL = os.environ.get("PRICELABS_LOGIN_URL", "https://app.pricelabs.co/signin")
DASHBOARD_URLS = [u.strip() for u in os.environ.get("PRICELABS_DASHBOARD_URLS", "").split(",") if u.strip()]
STATE = os.environ.get("PRICELABS_STATE", os.path.join(HERE, ".pricelabs_state.json"))
CAPTURE_DIR = os.environ.get("PRICELABS_CAPTURE_DIR", os.path.join(HERE, "pricelabs-captures"))
DOWNLOAD_DIR = os.environ.get("PRICELABS_DOWNLOAD_DIR", os.path.join(HERE, "pricelabs-downloads"))
PROXY_URL = os.environ.get("PROXY_URL", "")
HEADFUL = os.environ.get("PRICELABS_HEADFUL") == "1"

EMAIL_SEL = os.environ.get("PRICELABS_EMAIL_SEL",
                           "input[type=email], input[name=email], #email, input[name='user[email]']")
PASSWORD_SEL = os.environ.get("PRICELABS_PASSWORD_SEL",
                              "input[type=password], #password, input[name='user[password]']")
SUBMIT_SEL = os.environ.get("PRICELABS_SUBMIT_SEL",
                            "button[type=submit], input[type=submit]")

EXPORT_HINTS = ("export", "download", "csv", "excel", "xlsx", ".csv")


def chromium_executable():
    """Cowork ships Chromium under PLAYWRIGHT_BROWSERS_PATH but the pip Playwright
    version may not match — fall back to the on-disk binary so launch() still works."""
    explicit = os.environ.get("PLAYWRIGHT_CHROMIUM")
    if explicit and os.path.exists(explicit):
        return explicit
    root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
    hits = sorted(glob.glob(os.path.join(root, "chromium-*/chrome-linux/chrome")))
    return hits[-1] if hits else None


def proxy_arg():
    if not PROXY_URL:
        return None
    from urllib.parse import urlparse, unquote
    u = urlparse(PROXY_URL)
    arg = {"server": f"{u.scheme or 'http'}://{u.hostname}{':' + str(u.port) if u.port else ''}"}
    if u.username:
        arg["username"] = unquote(u.username)
    if u.password:
        arg["password"] = unquote(u.password)
    return arg


def looks_like_login(page):
    if any(w in page.url.lower() for w in ("sign", "login", "auth")):
        return True
    try:
        return page.locator(PASSWORD_SEL).first.is_visible(timeout=2000)
    except Exception:
        return False


def do_login(page):
    email = os.environ.get("PRICELABS_EMAIL", "")
    pw = os.environ.get("PRICELABS_PASSWORD", "")
    if not email or not pw:
        raise SystemExit("PRICELABS_EMAIL / PRICELABS_PASSWORD not set — can't log in.")
    print(f"  login: {page.url}")
    page.fill(EMAIL_SEL, email, timeout=15000)
    page.fill(PASSWORD_SEL, pw, timeout=15000)
    # Some flows reveal the password field only after submitting the email; if the
    # first submit lands back on a login page, the discovery screenshot shows why.
    page.click(SUBMIT_SEL, timeout=15000)
    try:
        page.wait_for_load_state("networkidle", timeout=30000)
    except Exception:
        pass


def find_export_controls(page):
    """Best-effort: list clickable things whose text/attrs smell like an export."""
    js = """
    () => {
      const hints = %s;
      const out = [];
      const nodes = document.querySelectorAll('button, a, [role=button], [download], svg[class*=download], [aria-label]');
      nodes.forEach((el, i) => {
        const t = ((el.innerText||'') + ' ' + (el.getAttribute('aria-label')||'') + ' ' +
                   (el.getAttribute('title')||'') + ' ' + (el.getAttribute('href')||'') + ' ' +
                   (el.getAttribute('download')||'')).toLowerCase();
        if (hints.some(h => t.includes(h))) {
          out.push({ tag: el.tagName, text: (el.innerText||'').trim().slice(0,60),
                     aria: el.getAttribute('aria-label'), href: el.getAttribute('href') });
        }
      });
      return out;
    }
    """ % json.dumps(list(EXPORT_HINTS))
    try:
        return page.evaluate(js)
    except Exception as e:
        return [{"error": str(e)}]


def capture(page, captures, idx, label, do_download):
    os.makedirs(CAPTURE_DIR, exist_ok=True)
    safe = f"{idx:02d}-{label}"
    try:
        page.screenshot(path=os.path.join(CAPTURE_DIR, f"page-{safe}.png"), full_page=True)
    except Exception as e:
        print(f"  [warn] screenshot failed: {e}")
    try:
        with open(os.path.join(CAPTURE_DIR, f"page-{safe}.html"), "w", encoding="utf-8") as f:
            f.write(page.content())
    except Exception:
        pass
    controls = find_export_controls(page)
    net_file = os.path.join(CAPTURE_DIR, f"network-{safe}.json")
    with open(net_file, "w", encoding="utf-8") as f:
        json.dump(captures, f, indent=2)
    print(f"  captured {len(captures)} JSON request(s), {len(controls)} export-like control(s) -> {CAPTURE_DIR}")

    downloads = []
    if do_download and controls:
        os.makedirs(DOWNLOAD_DIR, exist_ok=True)
        for c in controls:
            txt = (c.get("text") or c.get("aria") or "").strip()
            if not txt:
                continue
            try:
                with page.expect_download(timeout=15000) as dl:
                    page.get_by_text(txt, exact=False).first.click(timeout=8000)
                d = dl.value
                dest = os.path.join(DOWNLOAD_DIR, d.suggested_filename)
                d.save_as(dest)
                downloads.append(dest)
                print(f"    downloaded: {dest}")
            except Exception:
                pass  # not every match is a real export; discovery just probes
    return {"label": label, "url": page.url, "controls": controls,
            "jsonRequests": len(captures), "downloads": downloads}


def main():
    do_download = "--download" in sys.argv
    if not DASHBOARD_URLS:
        print("Set PRICELABS_DASHBOARD_URLS to your Market Dashboard URL(s).", file=sys.stderr)
        # still allow a login-only capture to learn the login page
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise SystemExit("Playwright not installed. Run: pip install playwright")

    manifest = {"loginUrl": LOGIN_URL, "dashboards": [], "stateReused": os.path.exists(STATE)}
    exe = chromium_executable()
    launch_kwargs = {"headless": not HEADFUL}
    if exe:
        launch_kwargs["executable_path"] = exe
    px = proxy_arg()
    if px:
        launch_kwargs["proxy"] = px

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_kwargs)
        ctx_kwargs = {"accept_downloads": True}
        if os.path.exists(STATE):
            ctx_kwargs["storage_state"] = STATE
        if px:
            ctx_kwargs["proxy"] = px
        context = browser.new_context(**ctx_kwargs)
        page = context.new_page()

        captures = []

        def on_response(resp):
            try:
                if resp.request.resource_type not in ("xhr", "fetch"):
                    return
                if "json" not in (resp.headers.get("content-type", "")).lower():
                    return
                captures.append({"url": resp.url, "status": resp.status, "json": resp.json()})
            except Exception:
                pass

        page.on("response", on_response)

        # Land somewhere, log in if needed, persist the session for next runs.
        first = DASHBOARD_URLS[0] if DASHBOARD_URLS else LOGIN_URL
        page.goto(first, wait_until="domcontentloaded", timeout=45000)
        if looks_like_login(page):
            captures.clear()
            do_login(page)
            if looks_like_login(page):
                capture(page, captures, 0, "login-FAILED", False)
                raise SystemExit("Still on the login page after submit — check creds/selectors "
                                 "(see the login-FAILED screenshot in the capture dir).")
            context.storage_state(path=STATE)
            print(f"  session saved -> {STATE}")

        targets = DASHBOARD_URLS or [page.url]
        for i, url in enumerate(targets, start=1):
            captures.clear()
            try:
                page.goto(url, wait_until="networkidle", timeout=60000)
            except Exception:
                pass
            time.sleep(4)  # let lazy chart data settle
            label = url.rstrip("/").split("/")[-1].split("?")[0] or f"dash{i}"
            manifest["dashboards"].append(capture(page, list(captures), i, label, do_download))

        os.makedirs(CAPTURE_DIR, exist_ok=True)
        with open(os.path.join(CAPTURE_DIR, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
        print(f"\nDiscovery done. Share {os.path.join(CAPTURE_DIR, 'manifest.json')} "
              f"(+ a page-*.png) so the export step can be wired.")
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
