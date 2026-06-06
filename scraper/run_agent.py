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
SCAN_LISTING_IDS = os.environ.get("SCAN_LISTING_IDS", "")
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


def _calendar_price(day):
    p = day.get("price")
    if isinstance(p, dict):
        for k in ("localPrice", "amount", "nativePrice"):
            v = p.get(k)
            if isinstance(v, (int, float)):
                return float(v)
        nested = p.get("price")
        if isinstance(nested, dict):
            for k in ("amount", "localPrice"):
                v = nested.get(k)
                if isinstance(v, (int, float)):
                    return float(v)
    if isinstance(p, (int, float)):
        return float(p)
    return None


def fetch_calendar(airbnb_id):
    """date -> {min, available, price} from the listing calendar (best effort)."""
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
            if not date:
                continue
            avail = d.get("available")
            if avail is None:
                avail = d.get("availableForCheckin")
            out[date] = {
                "min": d.get("minNights", d.get("min_nights")),
                "available": None if avail is None else bool(avail),
                "price": _calendar_price(d),
            }
    return out


def window_available(cal, check_in, nights):
    """True if every known night in the window is bookable; None if unknown."""
    try:
        d0 = datetime.date.fromisoformat(check_in)
    except ValueError:
        return None
    seen = False
    for i in range(nights):
        info = cal.get((d0 + datetime.timedelta(days=i)).isoformat())
        if info is None:
            continue
        seen = True
        if not info.get("available"):
            return False
    return True if seen else None


def window_price(cal, check_in):
    info = cal.get(check_in)
    return info.get("price") if info else None


def first_available_window(cal, nights, horizon_days=180):
    """Earliest check-in (from tomorrow) with `nights` consecutive bookable nights
    that also satisfies the min-stay at that date. None if none within the horizon."""
    today = datetime.date.today()
    for off in range(1, horizon_days):
        d0 = today + datetime.timedelta(days=off)
        ok = True
        for i in range(nights):
            info = cal.get((d0 + datetime.timedelta(days=i)).isoformat())
            if info is None or not info.get("available"):
                ok = False
                break
            if i == 0:
                mn = info.get("min")
                if mn is not None and nights < mn:
                    ok = False
                    break
        if ok:
            return d0.isoformat()
    return None


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


def search_with_retry(box, check_in, check_out, guests, currency, attempts=3):
    last = None
    for i in range(attempts):
        try:
            return run_search(box, check_in, check_out, guests, currency)
        except Exception as e:
            last = e
            print(f"    retry {i + 1}/{attempts} after: {e}")
            time.sleep(2 * (i + 1))
    raise last if last else RuntimeError("search failed")


def scan_profile(profile):
    box = profile["box"]
    currency = profile.get("currency", "ILS")
    listings = profile.get("listings", [])
    stay_nights = profile.get("stayNights", [])
    profile_guests = profile.get("guests", 2)
    profile_dates = profile.get("startDates", [])
    date_mode = profile.get("dateMode", "fixed")

    print(f"[{profile['id']}] {profile.get('label')} -- {len(listings)} listings")

    # 1) Pull each listing's calendar (availability + min-stay + asking price).
    #    Fetched every run because availability changes as bookings come in.
    cals = {}         # listing_id -> {date: {min, available, price}}
    posted_min = {}   # listing_id -> representative min-stay to cache back
    for l in listings:
        cal = fetch_calendar(l["airbnbId"])
        cals[l["id"]] = cal
        mins = [v["min"] for v in cal.values() if v.get("min") is not None]
        if mins:
            posted_min[l["id"]] = min(mins)
        time.sleep(1)

    def min_for(l, date):
        cal = cals.get(l["id"], {})
        info = cal.get(date)
        if info and info.get("min") is not None:
            return info["min"]
        mins = [v["min"] for v in cal.values() if v.get("min") is not None]
        if mins:
            return min(mins)
        return l.get("minNights") or MIN_NIGHTS_FALLBACK

    def eff_guests(l):
        return l.get("guests") or profile_guests

    def eff_dates(l):
        return l.get("startDates") or profile_dates

    # 2) Build searches for eligible windows; record ineligible directly. A search
    #    = (guests, check-in, nights); listings sharing one are batched together.
    snapshots = []
    searches = {}  # (guests, date, nights) -> [eligible listings]
    for l in listings:
        g = eff_guests(l)
        cal = cals.get(l["id"], {})
        if date_mode == "first_available":
            mins = [v["min"] for v in cal.values() if v.get("min") is not None]
            repmin = min(mins) if mins else (l.get("minNights") or MIN_NIGHTS_FALLBACK)
            for n in stay_nights:
                d = first_available_window(cal, n)
                if d:
                    searches.setdefault((g, d, n), []).append(l)
                else:
                    snapshots.append({
                        "listingId": l["id"], "airbnbId": str(l["airbnbId"]),
                        "stayLabel": stay_label(n), "nights": n,
                        "checkIn": "", "checkOut": "",
                        "eligible": n >= repmin, "minNights": repmin,
                        "available": False, "found": False,
                        "page": None, "position": None, "rank": None, "total": None,
                        "price": None, "currency": currency,
                    })
        else:
            for d in eff_dates(l):
                for n in stay_nights:
                    req = min_for(l, d)
                    if n >= req:
                        searches.setdefault((g, d, n), []).append(l)
                    else:
                        snapshots.append({
                            "listingId": l["id"], "airbnbId": str(l["airbnbId"]),
                            "stayLabel": stay_label(n), "nights": n,
                            "checkIn": d, "checkOut": add_nights(d, n),
                            "eligible": False, "minNights": req,
                            "available": window_available(cal, d, n),
                            "found": False, "page": None, "position": None,
                            "rank": None, "total": None,
                            "price": window_price(cal, d), "currency": currency,
                        })

    print(f"  {len(searches)} unique searches (batched by guests + date + stay)")
    found_total = 0
    error_count = 0
    for (g, d, n), ls in searches.items():
        check_out = add_nights(d, n)
        try:
            results = search_with_retry(box, d, check_out, g, currency)
        except Exception as e:
            print(f"  [error] search g{g} {d} {n}n: {e}")
            error_count += 1
            results = []
        rankmap = build_rankmap(results)
        total = len(results)
        hits = sum(1 for l in ls if str(l["airbnbId"]) in rankmap)
        found_total += hits
        print(f"  g{g} {stay_label(n):<8} {d}: {total} results, {hits}/{len(ls)} found")
        for l in ls:
            cal = cals.get(l["id"], {})
            info = rankmap.get(str(l["airbnbId"]))
            snap = {
                "listingId": l["id"], "airbnbId": str(l["airbnbId"]),
                "stayLabel": stay_label(n), "nights": n,
                "checkIn": d, "checkOut": check_out,
                "eligible": True, "minNights": min_for(l, d),
                # found in search => definitely available; else fall back to calendar
                "available": True if info else window_available(cal, d, n),
                "found": bool(info), "page": None, "position": None,
                "rank": None, "total": total,
                "price": None, "currency": currency,
            }
            if info:
                page, pos, rank, price = info
                snap.update({"page": page, "position": pos, "rank": rank, "price": price})
            else:
                snap["price"] = window_price(cal, d)
            snapshots.append(snap)
        time.sleep(PAUSE)
    return snapshots, posted_min, {
        "found": found_total,
        "errors": error_count,
        "searches": len(searches),
    }


def main():
    print(f"APP_URL={APP_URL}  proxy={'yes' if PROXY_URL else 'no'}  "
          f"key={'set' if SCRAPER_API_KEY else 'MISSING'}")
    cfg = http_get_json(f"{APP_URL}/api/visibility/config")
    profiles = cfg.get("profiles", [])
    print(f"{len(profiles)} active profile(s)\n" + "=" * 60)

    scope = {x.strip() for x in SCAN_LISTING_IDS.split(",") if x.strip()}
    if scope:
        print(f"scope: only {len(scope)} selected listing(s)")
    headers = {"x-scraper-key": SCRAPER_API_KEY} if SCRAPER_API_KEY else {}
    for profile in profiles:
        if scope:
            profile["listings"] = [
                l for l in profile.get("listings", []) if l["id"] in scope
            ]
        if not profile.get("listings"):
            print(f"[{profile.get('id')}] no listings in scope -- skipping")
            continue
        run_id = uuid.uuid4().hex
        try:
            snapshots, posted_min, stats = scan_profile(profile)
        except Exception as e:
            print(f"[error] profile {profile.get('id')}: {e}")
            continue
        if stats["found"] == 0 and stats["errors"] > 0:
            print(f"  !! all searches errored and nothing was found -- NOT posting, "
                  f"keeping previous data for {profile['id']}\n")
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
