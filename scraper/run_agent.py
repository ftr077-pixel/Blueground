#!/usr/bin/env python3
"""
Visibility scanner -- server mode (the box's cron entrypoint)
=============================================================
Pulls tracked searches from the dashboard, scans Airbnb for each, and posts the
results back. This is what runs on the Vultr box on a schedule; the dashboard is
where you configure *what* to track.

    GET  {APP_URL}/api/visibility/config      -> what to scan
    POST {APP_URL}/api/visibility/snapshot     <- results (x-scraper-key auth)

Env:
    APP_URL          base URL of the dashboard (default http://localhost:3000)
    SCRAPER_API_KEY  must match the app's SCRAPER_API_KEY (omit only in local dev)
    PROXY_URL        residential proxy, e.g. http://user:pass@host:port
                     (REQUIRED on a datacenter box -- Airbnb blocks cloud IPs)

    python run_agent.py
"""

import datetime
import json
import os
import time
import urllib.request
import uuid

import pyairbnb

APP_URL = os.environ.get("APP_URL", "http://localhost:3000").rstrip("/")
SCRAPER_API_KEY = os.environ.get("SCRAPER_API_KEY", "")
PROXY_URL = os.environ.get("PROXY_URL", "")
LANGUAGE = "en"
WEB_PAGE_SIZE = 18
PAUSE = 3
MIN_NIGHTS_FALLBACK = 30
STAY_LABELS = {7: "1 week", 14: "2 weeks", 30: "1 month", 60: "2 months", 90: "3 months"}


# --------------------------------------------------------------------------
# http helpers (stdlib, no extra deps)
# --------------------------------------------------------------------------
def http_get_json(url):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def http_post_json(url, payload, headers=None):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode())


# --------------------------------------------------------------------------
# scraping helpers
# --------------------------------------------------------------------------
def add_nights(date_str, nights):
    d = datetime.date.fromisoformat(date_str)
    return (d + datetime.timedelta(days=nights)).isoformat()


def stay_label(nights):
    return STAY_LABELS.get(nights, f"{nights} nights")


def detect_min_nights(listing_id):
    """Map of {date -> minNights} from the listing calendar (best effort)."""
    try:
        api_key = pyairbnb.get_api_key(PROXY_URL)
        months = pyairbnb.get_calendar(api_key=api_key, room_id=str(listing_id), proxy_url=PROXY_URL)
    except Exception as e:
        print(f"  [warn] calendar fetch failed ({e}); using fallback min-stay")
        return {}
    out = {}
    for m in months or []:
        for d in (m.get("days") or []):
            date = d.get("calendarDate") or d.get("date")
            mn = d.get("minNights", d.get("min_nights"))
            if date is not None and mn is not None:
                out[date] = mn
    return out


def find_index(results, listing_id):
    t = str(listing_id)
    for i, r in enumerate(results):
        if isinstance(r, dict) and str(r.get("room_id")) == t:
            return i
    return -1


def result_price(r):
    price = r.get("price", {}) if isinstance(r, dict) else {}
    for block in ("total", "unit"):
        b = price.get(block, {})
        if b.get("amount"):
            return b["amount"]
    return None


def search_rank(listing_id, box, check_in, check_out, guests, currency):
    """(page, position, rank, total, price) -- page is None if not found."""
    results = pyairbnb.search_all(
        check_in=check_in, check_out=check_out,
        ne_lat=box["neLat"], ne_long=box["neLng"], sw_lat=box["swLat"], sw_long=box["swLng"],
        zoom_value=box.get("zoom", 14),
        price_min=0, price_max=0, adults=guests,
        currency=currency, language=LANGUAGE, proxy_url=PROXY_URL,
    )
    total = len(results) if isinstance(results, list) else 0
    idx = find_index(results, listing_id) if total else -1
    if idx < 0:
        return None, None, None, total, None
    return idx // WEB_PAGE_SIZE + 1, idx % WEB_PAGE_SIZE + 1, idx + 1, total, result_price(results[idx])


def scan_search(search):
    """Run the stay-length x start-date matrix for one tracked search."""
    listing_id = str(search["listingId"])
    box = search["box"]
    guests = search.get("guests", 2)
    currency = search.get("currency", "ILS")
    fallback = search.get("minNights") or MIN_NIGHTS_FALLBACK
    start_dates = search.get("startDates", [])
    stay_nights = search.get("stayNights", [])

    print(f"[{search['id']}] {search.get('label')} -- listing {listing_id}")
    min_map = detect_min_nights(listing_id)
    anchor = start_dates[0] if start_dates else None
    detected_min = min_map.get(anchor, fallback) if anchor else fallback

    snapshots = []
    for start in start_dates:
        req = min_map.get(start, fallback)
        for nights in stay_nights:
            check_out = add_nights(start, nights)
            eligible = nights >= req
            snap = {
                "stayLabel": stay_label(nights), "nights": nights,
                "checkIn": start, "checkOut": check_out,
                "eligible": eligible, "minNights": req,
                "found": False, "page": None, "position": None,
                "rank": None, "total": None, "price": None, "currency": currency,
            }
            if eligible:
                try:
                    page, pos, rank, total, price = search_rank(
                        listing_id, box, start, check_out, guests, currency,
                    )
                    snap.update({"found": page is not None, "page": page, "position": pos,
                                 "rank": rank, "total": total, "price": price})
                    print(f"  {stay_label(nights):<9} {start}: "
                          + (f"page {page} pos {pos} (rank {rank}/{total})"
                             if page else f"not in top {total}"))
                except Exception as e:
                    print(f"  [error] {stay_label(nights)} {start}: {e}")
                time.sleep(PAUSE)
            else:
                print(f"  {stay_label(nights):<9} {start}: ineligible (needs >= {req}n)")
            snapshots.append(snap)
    return snapshots, detected_min


def main():
    print(f"APP_URL={APP_URL}  proxy={'yes' if PROXY_URL else 'no'}  "
          f"key={'set' if SCRAPER_API_KEY else 'MISSING'}")
    cfg = http_get_json(f"{APP_URL}/api/visibility/config")
    searches = cfg.get("searches", [])
    print(f"{len(searches)} tracked search(es)\n" + "=" * 60)

    headers = {"x-scraper-key": SCRAPER_API_KEY} if SCRAPER_API_KEY else {}
    for search in searches:
        run_id = uuid.uuid4().hex
        try:
            snapshots, detected_min = scan_search(search)
        except Exception as e:
            print(f"[error] scan failed for {search.get('id')}: {e}")
            continue
        payload = {
            "searchId": search["id"],
            "runId": run_id,
            "listingId": str(search["listingId"]),
            "minNights": detected_min,
            "snapshots": snapshots,
        }
        try:
            res = http_post_json(f"{APP_URL}/api/visibility/snapshot", payload, headers)
            print(f"  -> posted {res.get('recorded')} snapshots (run {run_id[:8]})\n")
        except Exception as e:
            print(f"  [error] posting results: {e}\n")


if __name__ == "__main__":
    main()
