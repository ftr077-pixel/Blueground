#!/usr/bin/env python3
"""
PriceLabs PDF inbox — auto-ingest a drop folder
===============================================
Cron-friendly companion to pricelabs_pdf.py. Each run scans an inbox folder for
*.pdf, parses + ingests every new file, then moves it into processed/ (or failed/)
so each PDF is loaded exactly once.

Workflow: export a Market Dashboard PDF from PriceLabs, drop it in the inbox, and
the next cron tick loads it into the Hub. No login automation, no proxy.

Env:
    PRICELABS_INBOX   folder to watch (default: <this dir>/pricelabs-inbox)
    APP_URL, SCRAPER_API_KEY, PRICELABS_NEIGHBORHOOD, PRICELABS_CURRENCY
                      — same as pricelabs_pdf.py (read there at import time)
"""

import datetime
import os
import sys
import traceback

import pricelabs_pdf as pl

INBOX = os.environ.get("PRICELABS_INBOX") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "pricelabs-inbox"
)


def main():
    inbox = INBOX
    processed = os.path.join(inbox, "processed")
    failed = os.path.join(inbox, "failed")
    for d in (inbox, processed, failed):
        os.makedirs(d, exist_ok=True)

    pdfs = sorted(
        f
        for f in os.listdir(inbox)
        if f.lower().endswith(".pdf") and os.path.isfile(os.path.join(inbox, f))
    )
    if not pdfs:
        print(f"[pricelabs] inbox empty: {inbox}")
        return

    print(f"[pricelabs] {len(pdfs)} PDF(s) in {inbox}")
    ok = 0
    for name in pdfs:
        path = os.path.join(inbox, name)
        # UTC stamp keeps processed/ filenames unique and ordered without relying
        # on the original name (you might drop "report.pdf" every week).
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        try:
            parsed = pl.parse_pdf(path)
            if parsed["summary"] is None and not parsed["pacing"]:
                raise ValueError("no usable market data (not a PriceLabs Market Report PDF?)")
            res = pl.post(pl.build_payload(parsed))
            print(f"  [ok] {name} -> {res}")
            os.replace(path, os.path.join(processed, f"{stamp}-{name}"))
            ok += 1
        except Exception as e:
            print(f"  [fail] {name}: {e}")
            traceback.print_exc()
            os.replace(path, os.path.join(failed, f"{stamp}-{name}"))

    print(f"[pricelabs] done: {ok}/{len(pdfs)} ingested")
    # Non-zero only when files were present but none ingested — an empty inbox is
    # the normal idle state and must not spam cron with failure mail.
    if ok == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
