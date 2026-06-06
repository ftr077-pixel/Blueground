#!/usr/bin/env python3
"""
Airbnb rank proof
=================
Find ONE listing's PAGE + POSITION in Airbnb search results for a set of
date windows, using the open-source `pyairbnb` library (v2.2.1).

This is the "prove the scraper" step: confirm we can reliably capture where a
listing lands in Airbnb search for given dates. Run this on YOUR machine (a
residential IP) -- NOT in a datacenter, where Airbnb will block it.

    pip install -r requirements.txt
    python airbnb_rank_proof.py

If results come back empty or you get blocked, route through a proxy:
    PROXY_URL="http://user:pass@host:port" python airbnb_rank_proof.py

If your listing is NOT in Tel Aviv, either edit the SEARCH BOX below, or let
the script center the search on the listing automatically:
    AUTO_BOX=1 python airbnb_rank_proof.py
"""

import os
import time

import pyairbnb

# ---------------------------------------------------------------------------
# CONFIG  -- edit these
# ---------------------------------------------------------------------------
LISTING_ID = "1602229503214826484"                 # from your listing URL
LISTING_URL = f"https://www.airbnb.com/rooms/{LISTING_ID}"

GUESTS = 2                                          # "two guests"
CURRENCY = "ILS"                                    # change to "USD" etc.
LANGUAGE = "en"

# Search AREA -- a box over greater Tel Aviv-Yafo: (SW corner) .. (NE corner).
# The script prints the listing's real coordinates so you can verify the box.
SW_LAT, SW_LNG = 32.040, 34.740
NE_LAT, NE_LNG = 32.120, 34.830
ZOOM = 14

# Date windows, all anchored at Aug 1, 2026  (check_in -> check_out)
WINDOWS = [
    ("1 week",  "2026-08-01", "2026-08-08"),
    ("2 weeks", "2026-08-01", "2026-08-15"),
    ("1 month", "2026-08-01", "2026-09-01"),
]

# Airbnb's web UI paginates at ~18 results per page; "page" is derived from the
# listing's global rank. (pyairbnb itself fetches 50/grid under the hood.)
WEB_PAGE_SIZE = 18
PROXY_URL = os.environ.get("PROXY_URL", "")
AUTO_BOX = os.environ.get("AUTO_BOX", "") not in ("", "0", "false", "False")
PAUSE_SECONDS = 3                                   # be gentle between searches


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def find_index(results, target_id):
    """Return the 0-based rank of target_id in the ranked results, or -1."""
    t = str(target_id)
    for i, r in enumerate(results):
        if isinstance(r, dict) and str(r.get("room_id")) == t:
            return i
    return -1


def find_coords(obj):
    """Recursively dig a (lat, lng) pair out of a details dict, schema-tolerant."""
    if isinstance(obj, dict):
        lat = obj.get("latitude", obj.get("lat"))
        lng = obj.get("longitude", obj.get("longitud", obj.get("lng")))
        if isinstance(lat, (int, float)) and isinstance(lng, (int, float)) and (lat or lng):
            return float(lat), float(lng)
        for v in obj.values():
            got = find_coords(v)
            if got:
                return got
    elif isinstance(obj, list):
        for v in obj:
            got = find_coords(v)
            if got:
                return got
    return None


def result_price(r):
    """Best-effort 'symbol amount' string from a search result."""
    price = r.get("price", {}) if isinstance(r, dict) else {}
    for block in ("total", "unit"):
        b = price.get(block, {})
        if b.get("amount"):
            return f"{b.get('currency_symbol') or b.get('curency_symbol') or ''}{b['amount']}".strip()
    return "?"


def lookup_listing_coords():
    """One lightweight detail fetch -> (lat, lng, name) for diagnosis / AUTO_BOX."""
    data, _price_input, _cookies = pyairbnb.details.get(LISTING_URL, LANGUAGE, PROXY_URL)
    name = data.get("name") or data.get("title") if isinstance(data, dict) else None
    return find_coords(data), name


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    global SW_LAT, SW_LNG, NE_LAT, NE_LNG

    print(f"target listing : {LISTING_ID}")
    print(f"guests={GUESTS}  currency={CURRENCY}  proxy={'yes' if PROXY_URL else 'no'}")

    if AUTO_BOX:
        print("AUTO_BOX on -> centering the search box on the listing...")
        try:
            coords, name = lookup_listing_coords()
            if coords:
                lat, lng = coords
                SW_LAT, SW_LNG = lat - 0.06, lng - 0.06    # ~6-7km half-width
                NE_LAT, NE_LNG = lat + 0.06, lng + 0.06
                print(f"  listing {name!r} @ {lat:.5f},{lng:.5f}")
            else:
                print("  [warn] could not read coordinates; using the default box")
        except Exception as e:
            print(f"  [warn] detail lookup failed ({e}); using the default box")

    print(f"search box     : SW({SW_LAT},{SW_LNG}) .. NE({NE_LAT},{NE_LNG}) zoom={ZOOM}")
    print("-" * 68)

    summary = []
    shown_coords = False
    for label, check_in, check_out in WINDOWS:
        print(f"\n=== {label}: {check_in} -> {check_out} ===")
        try:
            results = pyairbnb.search_all(
                check_in=check_in, check_out=check_out,
                ne_lat=NE_LAT, ne_long=NE_LNG, sw_lat=SW_LAT, sw_long=SW_LNG,
                zoom_value=ZOOM,
                price_min=0, price_max=0,          # 0/0 => no price filter
                adults=GUESTS,
                currency=CURRENCY, language=LANGUAGE,
                proxy_url=PROXY_URL,
            )
        except Exception as e:
            print(f"  [error] search failed: {e}")
            summary.append((label, None, None, None, None))
            continue

        total = len(results) if isinstance(results, list) else 0
        print(f"  results returned: {total}")
        idx = find_index(results, LISTING_ID) if total else -1

        if idx < 0:
            print(f"  -> NOT FOUND in top {total} results for this search")
            summary.append((label, None, None, total, None))
        else:
            rank = idx + 1
            page = idx // WEB_PAGE_SIZE + 1
            pos = idx % WEB_PAGE_SIZE + 1
            r = results[idx]
            print(f"  -> FOUND: page {page}, position {pos}  "
                  f"(global rank {rank}/{total})")
            print(f"     name : {r.get('name') or r.get('title')!r}")
            print(f"     price: {result_price(r)}   rating: {r.get('rating', {}).get('value')}")
            summary.append((label, page, pos, total, rank))
            if not shown_coords:
                c = r.get("coordinates", {})
                print(f"     coords: {c.get('latitude')},{c.get('longitud')}")
                shown_coords = True

        time.sleep(PAUSE_SECONDS)

    # If we never found it, fetch the listing once to diagnose why.
    if all(row[1] is None for row in summary):
        print("\n" + "-" * 68)
        print("Listing not found in any window. Fetching it directly to diagnose...")
        try:
            coords, name = lookup_listing_coords()
            print(f"  listing exists: {name!r}")
            if coords:
                lat, lng = coords
                inside = SW_LAT <= lat <= NE_LAT and SW_LNG <= lng <= NE_LNG
                print(f"  real coords: {lat:.5f},{lng:.5f}  "
                      f"-> {'INSIDE' if inside else 'OUTSIDE'} the search box")
                if not inside:
                    print("  Fix: edit the SEARCH BOX, or re-run with AUTO_BOX=1")
                else:
                    print("  It's in-area but ranked beyond Airbnb's result cap "
                          "(i.e. deep in search) -- which is itself the signal.")
        except Exception as e:
            print(f"  [warn] could not fetch listing: {e} "
                  f"(check the listing id / try a proxy)")

    # Summary + provisional visibility index
    print("\n" + "=" * 68)
    print("SUMMARY")
    print(f"  {'window':<9} {'page':>5} {'pos':>4} {'rank':>6} {'total':>7}")
    scores = []
    for label, page, pos, total, rank in summary:
        if page is None:
            print(f"  {label:<9} {'-':>5} {'-':>4} {'-':>6} {str(total or '-'):>7}")
            scores.append(0)
        else:
            print(f"  {label:<9} {page:>5} {pos:>4} {rank:>6} {total:>7}")
            scores.append(max(0, 100 - (page - 1) * 15))   # p1=100, ~-15/page

    if scores:
        index = sum(scores) / len(scores)
        print(f"\n  Provisional Visibility Index: {index:.0f}/100")
        print("  (page1=100, ~-15/page -- placeholder formula; we'll tune it together)")


if __name__ == "__main__":
    main()
