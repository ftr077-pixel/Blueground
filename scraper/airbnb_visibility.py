#!/usr/bin/env python3
"""
Airbnb visibility -- measurement layer (v2)
===========================================
Builds on the rank proof with three things:

  1. MIN-STAY auto-detection (reads the listing calendar's `minNights`).
  2. ELIGIBILITY map -- which stay-lengths can even appear in search
     (a 30-night-minimum unit is invisible to 1-week searches; that's not a
     ranking problem, it's a filter -- we label it as such).
  3. SHIFTED-START sweep -- rank + price for the eligible stay-length(s)
     across several check-in dates.

Then a v2 index that keeps the two failure modes SEPARATE:
  - "ineligible (min-stay)"   -> lowers eligibility COVERAGE
  - "eligible but ranked low" -> lowers the RANK SCORE

Run (reuses the venv from the proof):
    mv ~/Downloads/airbnb_visibility.py ~/airbnb-proof/ && cd ~/airbnb-proof
    source .venv/bin/activate
    python3 airbnb_visibility.py

Proxy / different city, same as before:
    PROXY_URL="http://user:pass@host:port" python3 airbnb_visibility.py
"""

import datetime
import os
import time

import pyairbnb

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------
LISTING_ID = "1602229503214826484"
LISTING_URL = f"https://www.airbnb.com/rooms/{LISTING_ID}"

GUESTS = 2
CURRENCY = "ILS"
LANGUAGE = "en"

# Search area: greater Tel Aviv-Yafo  (SW corner) .. (NE corner)
SW_LAT, SW_LNG = 32.040, 34.740
NE_LAT, NE_LNG = 32.120, 34.830
ZOOM = 14

# Stay-lengths to test (label, nights) and the shifted check-in dates.
STAY_LENGTHS = [("1 week", 7), ("2 weeks", 14), ("1 month", 30)]
START_DATES = ["2026-08-01", "2026-08-08", "2026-08-15", "2026-08-22", "2026-09-01"]

MIN_NIGHTS_FALLBACK = 30          # used only if calendar detection fails
WEB_PAGE_SIZE = 18                # Airbnb web UI ~results/page (global rank is exact)
PAGE_DECAY = 15                   # rank score: page1=100, -15/page (placeholder, tunable)
PROXY_URL = os.environ.get("PROXY_URL", "")
PAUSE = 3


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def add_nights(date_str, nights):
    d = datetime.date.fromisoformat(date_str)
    return (d + datetime.timedelta(days=nights)).isoformat()


def detect_min_nights():
    """Return ({date -> minNights}, sample_day_keys) read from the listing calendar."""
    try:
        api_key = pyairbnb.get_api_key(PROXY_URL)
        months = pyairbnb.get_calendar(api_key=api_key, room_id=LISTING_ID, proxy_url=PROXY_URL)
    except Exception as e:
        print(f"  [warn] calendar fetch failed ({e}); using fallback min-stay")
        return {}, None
    out, sample = {}, None
    for m in months or []:
        for d in (m.get("days") or []):
            if sample is None:
                sample = list(d.keys())
            date = d.get("calendarDate") or d.get("date")
            mn = d.get("minNights", d.get("min_nights"))
            if date is not None and mn is not None:
                out[date] = mn
    return out, sample


def min_nights_for(date_str, min_map):
    return min_map.get(date_str, MIN_NIGHTS_FALLBACK)


def find_index(results, target_id):
    t = str(target_id)
    for i, r in enumerate(results):
        if isinstance(r, dict) and str(r.get("room_id")) == t:
            return i
    return -1


def result_price(r):
    price = r.get("price", {}) if isinstance(r, dict) else {}
    for block in ("total", "unit"):
        b = price.get(block, {})
        if b.get("amount"):
            return f"{b.get('currency_symbol') or b.get('curency_symbol') or ''}{b['amount']}".strip()
    return "?"


def search_rank(check_in, check_out):
    """Return (page, pos, rank, total, price, name)."""
    results = pyairbnb.search_all(
        check_in=check_in, check_out=check_out,
        ne_lat=NE_LAT, ne_long=NE_LNG, sw_lat=SW_LAT, sw_long=SW_LNG,
        zoom_value=ZOOM, price_min=0, price_max=0, adults=GUESTS,
        currency=CURRENCY, language=LANGUAGE, proxy_url=PROXY_URL,
    )
    total = len(results) if isinstance(results, list) else 0
    idx = find_index(results, LISTING_ID) if total else -1
    if idx < 0:
        return None, None, None, total, None, None
    r = results[idx]
    name = r.get("name") or r.get("title")
    return idx // WEB_PAGE_SIZE + 1, idx % WEB_PAGE_SIZE + 1, idx + 1, total, result_price(r), name


def page_score(page):
    return 0 if page is None else max(0, 100 - (page - 1) * PAGE_DECAY)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    print(f"listing : {LISTING_ID}  guests={GUESTS}  currency={CURRENCY}  "
          f"proxy={'yes' if PROXY_URL else 'no'}")
    print("=" * 72)

    # 1) minimum-stay detection
    print("Detecting minimum-stay from the listing calendar...")
    min_map, sample_keys = detect_min_nights()
    anchor = START_DATES[0]
    anchor_min = min_nights_for(anchor, min_map)
    if sample_keys:
        print(f"  calendar day fields: {sample_keys}")
    print(f"  min-stay @ {anchor}: {anchor_min} nights"
          f"{'' if min_map else '  (fallback -- detection failed)'}")
    print("=" * 72)

    # 2) eligibility per stay-length (anchor date)
    print("ELIGIBILITY  (can this stay-length appear in search at all?)")
    eligible = []
    for label, nights in STAY_LENGTHS:
        ok = nights >= anchor_min
        print(f"  {label:<8} ({nights:>2}n): {'ELIGIBLE' if ok else 'INELIGIBLE'}"
              f"{'' if ok else f'  -- filtered out (needs >= {anchor_min}n)'}")
        if ok:
            eligible.append((label, nights))
    print("=" * 72)

    # 3) shifted-start sweep for each eligible stay-length
    listing_name = None
    rank_scores = []
    for label, nights in eligible:
        print(f"\nRANK SWEEP -- {label} stay ({nights}n), shifted check-ins:")
        print(f"  {'check-in':<12}{'checkout':<12}{'page':>5}{'pos':>4}{'rank':>6}{'total':>7}   price")
        for start in START_DATES:
            req = min_nights_for(start, min_map)
            if nights < req:
                print(f"  {start:<12}{'':<12}{'INELIGIBLE':>17}   (needs >= {req}n here)")
                continue
            check_out = add_nights(start, nights)
            try:
                page, pos, rank, total, price, name = search_rank(start, check_out)
            except Exception as e:
                print(f"  {start:<12}{check_out:<12}   [error] {e}")
                continue
            listing_name = listing_name or name
            if page is None:
                print(f"  {start:<12}{check_out:<12}{'beyond':>5}{'cap':>4}{'-':>6}{total:>7}   not in top {total}")
                rank_scores.append(0)
            else:
                print(f"  {start:<12}{check_out:<12}{page:>5}{pos:>4}{rank:>6}{total:>7}   {price}")
                rank_scores.append(page_score(page))
            time.sleep(PAUSE)

    # 4) index v2 -- coverage and rank score kept SEPARATE
    print("\n" + "=" * 72)
    print("VISIBILITY INDEX v2")
    if listing_name:
        print(f"  listing: {listing_name!r}")
    cov = len(eligible)
    blocked = [l for l, n in STAY_LENGTHS if n < anchor_min]
    print(f"  Eligibility coverage : {cov}/{len(STAY_LENGTHS)} stay-lengths "
          f"({100 * cov / len(STAY_LENGTHS):.0f}%)")
    if blocked:
        print(f"     invisible for     : {', '.join(blocked)}  (min-stay filter -- "
              f"a POLICY lever, not price)")
    if rank_scores:
        rs = sum(rank_scores) / len(rank_scores)
        found = [s for s in rank_scores if s > 0]
        avg_page = None
        if found:
            # invert page_score average back to an approx page for readability
            avg_page = 1 + (100 - rs) / PAGE_DECAY
        print(f"  Rank score (eligible): {rs:.0f}/100"
              f"{f'  (~page {avg_page:.1f} on average)' if avg_page else ''}")
        print("     where eligible, this is the PRICE/quality lever (climb toward page 1)")
    else:
        print("  Rank score (eligible): n/a -- no eligible searches ran")


if __name__ == "__main__":
    main()
