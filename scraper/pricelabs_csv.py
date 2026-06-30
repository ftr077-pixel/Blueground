#!/usr/bin/env python3
"""
PriceLabs Market Dashboard CSV exports -> market_snapshots (dashboard source)
=============================================================================
Parses the per-report CSVs you download from a PriceLabs Market Dashboard and
feeds them into the Hub as the market source of truth — replacing AirROI. The
POST flips `market_source` to "pricelabs", so the Market Analytics dashboard, the
pricing engine, base-price and pacing all read this data afterwards.

Reads a directory containing the exports (matched by filename suffix; any prefix
is fine):
  *market_history.csv  -> monthly metrics[]  (Occ/ADR/RevPAR/Rev/BW/LOS, Aggregate)
  *supply_demand.csv   -> active listings per month + summary
  *occupancy.csv       -> forward pacing fill_rate (daily occupancy %)
  *prices.csv          -> forward booked / listed nightly rate (median booked, p50)
  *LOS.csv             -> (not mapped; LOS distribution has no snapshot slot)
  *Booking_Curves.csv  -> (not mapped; pickup curve has no snapshot slot)

    POST {APP_URL}/api/market/pricelabs   <- one area snapshot (x-scraper-key auth)

Usage:
    python pricelabs_csv.py ./reports --dry-run        # preview, post nothing
    APP_URL=http://localhost:3000 SCRAPER_API_KEY=xxx python pricelabs_csv.py ./reports

Env:
    APP_URL                 dashboard base URL (default http://localhost:3000)
    SCRAPER_API_KEY         must match the app's SCRAPER_API_KEY
    PRICELABS_NEIGHBORHOOD  area label for this market (default "Tel Aviv"). One
                            city-wide row → one clean dashboard entry. Use "*" to
                            fan out to every portfolio neighborhood for the engine.
    PRICELABS_MARKET        market name shown on the dashboard (default: from filename)
    PRICELABS_MIN_NIGHTS    market min-stay floor for summary (default 4 — the comp
                            filter PriceLabs exports use; CSVs don't carry min-stay)
    PRICELABS_CURRENCY      display currency label (default ILS)
"""

import csv
import datetime
import glob
import json
import os
import sys
import urllib.error
import urllib.request

APP_URL = os.environ.get("APP_URL", "http://localhost:3000").rstrip("/")
SCRAPER_API_KEY = os.environ.get("SCRAPER_API_KEY", "")
NEIGHBORHOOD = os.environ.get("PRICELABS_NEIGHBORHOOD", "Tel Aviv").strip() or "Tel Aviv"
CURRENCY = os.environ.get("PRICELABS_CURRENCY", "ILS").strip() or "ILS"
MIN_NIGHTS = float(os.environ.get("PRICELABS_MIN_NIGHTS", "4") or 0)


# ------------------------------------------------------------------ helpers
def num(x):
    """CSV cell -> float, or None for blank / 'NA'."""
    if x is None:
        return None
    s = str(x).strip()
    if s == "" or s.upper() == "NA":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def find(srcdir, suffix):
    hits = sorted(glob.glob(os.path.join(srcdir, f"*{suffix}")))
    return hits[0] if hits else None


def read_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def market_from_filename(path):
    # "45d0146b-TLV__market_history.csv" -> "TLV"; "TLV__x.csv" -> "TLV".
    base = os.path.basename(path)
    return base.split("__")[0].split("-")[-1] or "Tel Aviv"


def month_to_iso(m):
    # "2024-06" -> "2024-06-01"; pass through if already a full date.
    m = (m or "").strip()
    return m if len(m) > 7 else f"{m}-01"


# ------------------------------------------------------------------ parsing
def parse_market_history(path):
    """Monthly Aggregate columns -> metrics[] (active_listings filled in later)."""
    out = []
    for r in read_rows(path):
        date = month_to_iso(r.get("month"))
        occ = num(r.get("Occ. Aggregate"))
        out.append({
            "date": date,
            "occupancy": (occ / 100.0) if occ is not None else 0.0,
            "average_daily_rate": num(r.get("ADR Aggregate")) or 0.0,
            "revpar": num(r.get("RevPAR Aggregate")) or 0.0,
            "revenue": num(r.get("Rev. Aggregate")) or 0.0,
            "booking_lead_time": num(r.get("BW Aggregate")) or 0.0,
            "length_of_stay": num(r.get("LOS Aggregate")) or 0.0,
            "min_nights": 0.0,
            "active_listings_count": 0.0,
        })
    return out


def parse_supply_demand(path):
    """month 'YYYY-MM' -> active listings (and booked nights)."""
    active, booked = {}, {}
    for r in read_rows(path):
        m = (r.get("Month") or "").strip()[:7]
        if not m:
            continue
        active[m] = num(r.get("Active listings")) or 0.0
        booked[m] = num(r.get("Total number of booked nights")) or 0.0
    return active, booked


def parse_occupancy(path):
    """date -> occupancy % (0..100)."""
    out = {}
    for r in read_rows(path):
        d = (r.get("Date") or "").strip()
        v = num(r.get("Occupancy"))
        if d and v is not None:
            out[d] = v
    return out


def parse_prices(path):
    """date -> {p50, booked, nbook} (listed median, median booked, # bookings)."""
    out = {}
    for r in read_rows(path):
        d = (r.get("Dates") or "").strip()
        if not d:
            continue
        out[d] = {
            "p50": num(r.get("50th Percentile")),
            "booked": num(r.get("Median Booked Price")),
            "nbook": num(r.get("No. Of Bookings")) or 0.0,
        }
    return out


def build_pacing(occ, prices, cutoff):
    """Forward (>= cutoff) daily occupancy + rate -> pacing[]. booked_rate_avg uses
    the median *booked* price where it exists, else the listed median (forward
    dates aren't booked yet); available_rate_avg is the listed median."""
    out = []
    for d in sorted(occ):
        if d < cutoff:
            continue
        fill = round(occ[d] / 100.0, 4)
        pr = prices.get(d) or {}
        p50 = pr.get("p50") or 0.0
        booked = pr.get("booked") or p50
        out.append({
            "date": d,
            "booked_count": int(pr.get("nbook") or 0),
            "available_count": 0,
            "booked_rate_avg": round(booked, 2),
            "available_rate_avg": round(p50, 2),
            "fill_rate": fill,
        })
    return out


def build_area(srcdir):
    files = {k: find(srcdir, f"{k}.csv") for k in
             ("market_history", "supply_demand", "occupancy", "prices")}
    missing = [k for k, v in files.items() if not v]
    if missing:
        raise FileNotFoundError(f"missing CSV(s): {', '.join(missing)} in {srcdir}")

    metrics = parse_market_history(files["market_history"])
    active, _booked = parse_supply_demand(files["supply_demand"])
    for m in metrics:
        m["active_listings_count"] = active.get(m["date"][:7], 0.0)

    occ = parse_occupancy(files["occupancy"])
    prices = parse_prices(files["prices"])
    cutoff = datetime.date.today().isoformat()
    pacing = build_pacing(occ, prices, cutoff)

    # Summary = latest complete month of history (consistent with the charts).
    last = metrics[-1] if metrics else None
    summary = None
    if last:
        summary = {
            "occupancy": last["occupancy"],
            "average_daily_rate": last["average_daily_rate"],
            "rev_par": last["revpar"],
            "revenue": last["revenue"],
            "booking_lead_time": last["booking_lead_time"],
            "length_of_stay": last["length_of_stay"],
            "min_nights": MIN_NIGHTS,
            "active_listings_count": last["active_listings_count"],
        }

    market = os.environ.get("PRICELABS_MARKET") or market_from_filename(files["market_history"])
    area = {
        "neighborhood": NEIGHBORHOOD,
        "marketName": f"{market} (PriceLabs)",
        "currency": CURRENCY,
        "summary": summary,
        "pacing": pacing,
        "minNights": [],
        "metrics": metrics,
        "filterLabel": os.environ.get("PRICELABS_FILTER_LABEL") or None,
    }
    return area, {"metrics": len(metrics), "pacing": len(pacing),
                  "pacingFrom": pacing[0]["date"] if pacing else None,
                  "pacingTo": pacing[-1]["date"] if pacing else None, "market": market}


# ------------------------------------------------------------------ post
def post(payload):
    url = f"{APP_URL}/api/market/pricelabs"
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    if SCRAPER_API_KEY:
        req.add_header("x-scraper-key", SCRAPER_API_KEY)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    dry = "--dry-run" in sys.argv or os.environ.get("DRY_RUN") == "1"
    srcdir = args[0] if args else os.environ.get("PRICELABS_DIR", ".")
    if not os.path.isdir(srcdir):
        print(f"not a directory: {srcdir}", file=sys.stderr)
        sys.exit(2)

    print(f"Parsing PriceLabs CSVs in {srcdir}")
    area, stats = build_area(srcdir)
    s = area["summary"] or {}
    print(f"  Market : {stats['market']}  -> area '{area['neighborhood']}'")
    print(f"  Metrics: {stats['metrics']} month(s)")
    print(f"  Pacing : {stats['pacing']} day(s)  {stats['pacingFrom']} → {stats['pacingTo']}")
    if s:
        print(f"  Summary: occ {s['occupancy'] * 100:.0f}%  ADR {CURRENCY} {s['average_daily_rate']:.0f}  "
              f"RevPAR {CURRENCY} {s['rev_par']:.0f}  listings {s['active_listings_count']:.0f}")

    if area["summary"] is None and not area["pacing"] and not area["metrics"]:
        print("[error] no usable data parsed", file=sys.stderr)
        sys.exit(1)

    payload = {"source": "pricelabs-csv", "areas": [area]}
    if dry:
        print("\n--- payload (--dry-run, not posted; metrics/pacing truncated) ---")
        preview = json.loads(json.dumps(payload))
        preview["areas"][0]["metrics"] = preview["areas"][0]["metrics"][:2] + ["…"]
        preview["areas"][0]["pacing"] = preview["areas"][0]["pacing"][:2] + ["…"]
        print(json.dumps(preview, indent=2, ensure_ascii=False))
        return

    try:
        print(f"  -> posted: {post(payload)}")
    except urllib.error.HTTPError as e:
        print(f"[error] POST {APP_URL}/api/market/pricelabs -> HTTP {e.code}: "
              f"{e.read().decode(errors='replace')[:300]}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"[error] posting to {APP_URL}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
