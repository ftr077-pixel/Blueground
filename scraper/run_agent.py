#!/usr/bin/env python3
"""
Visibility scanner -- server mode (the box's cron entrypoint)
=============================================================
Pulls *search profiles* (area + dates + guests, each with many listings) from the
dashboard, and for every date window runs ONE area search and matches every tracked
listing against those results -- so 100 listings cost a handful of searches, not 100+.

    GET  {APP_URL}/api/visibility/config      -> profiles + their listings
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
STALE_DAYS = 7  # refetch a listing's min-stay only if older than this
STAY_LABELS = {7: "1 week", 14: "2 weeks", 30: "1 month", 60: "2 months", 90: "3 months"}


# -------------------------------------------------------------------- http
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
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


# -------------------------------------------------------------------- helpers
def add_nights(date_str, nights):
    d = datetime.date.fromisoformat(date_str)
    return (d + datetime.timedelta(days=nights)).isoformat()


def stay_label(nights):
    return STAY_LABELS.get(nights, f"{nights} nights")


def is_fresh(checked_at):
    if not checked_at:
        return False
    try:
        t = datetime.datetime.fromisoformat(str(checked_at).replace("Z", "+00:00"))
    except ValueError:
        return False
    age = datetime.datetime.now(datetime.timezone.utc) - t
    return age.days < STALE_DAYS


def detect_min_nights(airbnb_id):
    """Map of {date -> minNights} from the listing calendar (best effort)."""
    try:
        api_key = pyairbnb.get_api_key(PROXY_URL)
        months = pyairbnb.get_calendar(api_key=api_key, room_id=str(airbnb_id), proxy_url=PROXY_URL)
    except Exception as e:
        print(f"    [warn] calendar fetch failed for {airbnb_id} ({e})")
        return {}
    out = {}
    for m in months or []:
        for d in (m.get("days") or []):
            date = d.get("calendarDate") or d.get("date")
            mn = d.get("minNights", d.get("min_nights"))
            if date is not None and mn is not None:
                out[date] = mn
    return out


def result_price(r):
    price = r.get("price", {}) if isinstance(r, dict) else {}
    for block in ("total", "unit"):
        b = price.get(block, {})
        if b.get("amount"):
            return b["amount"]
    return None


def build_rankmap(results):
    """airbnb_id -> (page, position, rank, price) for one search's results."""
    out = {}
    for i, r in enumerate(results):
        if isinstance(r, dict) and r.get("room_id") is not None:
            out[str(r["room_id"])] = (
                i // WEB_PAGE_SIZE + 1,
                i % WEB_PAGE_SIZE + 1,
                i + 1,
                result_price(r),
            )
    return out


def run_search(box, check_in, check_out, guests, currency):
    results = pyairbnb.search_all(
        check_in=check_in, check_out=check_out,
        ne_lat=box["neLat"], ne_long=box["neLng"], sw_lat=box["swLat"], sw_long=box["swLng"],
        zoom_value=box.get("zoom", 14),
        price_min=0, price_max=0, adults=guests,
        currency=currency, language=LANGUAGE, proxy_url=PROXY_URL,
    )
    return results if isinstance(results, list) else []


def scan_profile(profile):
    box = profile["box"]
    guests = profile.get("guests", 2)
    currency = profile.get("currency", "ILS")
    listings = profile.get("listings", [])
    start_dates = profile.get("startDates", [])
    stay_nights = profile.get("stayNights", [])
    anchor = start_dates[0] if start_dates else None

    print(f"[{profile['id']}] {profile.get('label')} -- {len(listings)} listings, "
          f"{len(start_dates)}x{len(stay_nights)} search windows")

    # 1) min-stay per listing (only refetch stale/unknown ones)
    date_maps = {}    # listing_id -> {date: min} (empty => use flat)
    flat_min = {}     # listing_id -> int
    posted_min = {}   # listing_id -> representative min to cache back
    for l in listings:
        lid = l["id"]
        if is_fresh(l.get("minNightsCheckedAt")) and l.get("minNights"):
            date_maps[lid] = {}
            flat_min[lid] = l["minNights"]
        else:
            m = detect_min_nights(l["airbnbId"])
            date_maps[lid] = m
            rep = (m.get(anchor) if (m and anchor) else None)
            if rep is None and m:
                rep = min(m.values())
            if rep is None:
                rep = MIN_NIGHTS_FALLBACK
            flat_min[lid] = rep
            posted_min[lid] = rep
            time.sleep(1)

    def min_for(listing, date):
        lid = listing["id"]
        mp = date_maps.get(lid)
        if mp:
            return mp.get(date, flat_min.get(lid, MIN_NIGHTS_FALLBACK))
        return flat_min.get(lid, MIN_NIGHTS_FALLBACK)

    # 2) one search per window; match every listing against the same results
    snapshots = []
    for start in start_dates:
        for nights in stay_nights:
            check_out = add_nights(start, nights)
            try:
                results = run_search(box, start, check_out, guests, currency)
            except Exception as e:
                print(f"  [error] search {start} {nights}n: {e}")
                results = []
            rankmap = build_rankmap(results)
            total = len(results)
            hits = sum(1 for l in listings if str(l["airbnbId"]) in rankmap)
            print(f"  {stay_label(nights):<9} {start}: {total} results, {hits} of our listings found")
            for l in listings:
                req = min_for(l, start)
                eligible = nights >= req
                snap = {
                    "listingId": l["id"], "airbnbId": str(l["airbnbId"]),
                    "stayLabel": stay_label(nights), "nights": nights,
                    "checkIn": start, "checkOut": check_out,
                    "eligible": eligible, "minNights": req,
                    "found": False, "page": None, "position": None,
                    "rank": None, "total": total if eligible else None,
                    "price": None, "currency": currency,
                }
                if eligible:
                    info = rankmap.get(str(l["airbnbId"]))
                    if info:
                        page, pos, rank, price = info
                        snap.update({"found": True, "page": page, "position": pos,
                                     "rank": rank, "price": price})
                snapshots.append(snap)
            time.sleep(PAUSE)
    return snapshots, posted_min


def main():
    print(f"APP_URL={APP_URL}  proxy={'yes' if PROXY_URL else 'no'}  "
          f"key={'set' if SCRAPER_API_KEY else 'MISSING'}")
    cfg = http_get_json(f"{APP_URL}/api/visibility/config")
    profiles = cfg.get("profiles", [])
    print(f"{len(profiles)} active profile(s)\n" + "=" * 60)

    headers = {"x-scraper-key": SCRAPER_API_KEY} if SCRAPER_API_KEY else {}
    for profile in profiles:
        if not profile.get("listings"):
            print(f"[{profile.get('id')}] no listings -- skipping")
            continue
        run_id = uuid.uuid4().hex
        try:
            snapshots, posted_min = scan_profile(profile)
        except Exception as e:
            print(f"[error] profile {profile.get('id')}: {e}")
            continue
        payload = {
            "profileId": profile["id"],
            "runId": run_id,
            "snapshots": snapshots,
            "listingMinNights": posted_min,
        }
        try:
            res = http_post_json(f"{APP_URL}/api/visibility/snapshot", payload, headers)
            print(f"  -> posted {res.get('recorded')} snapshots for "
                  f"{len(profile['listings'])} listings (run {run_id[:8]})\n")
        except Exception as e:
            print(f"  [error] posting results: {e}\n")


if __name__ == "__main__":
    main()
