#!/usr/bin/env python3
"""
PriceLabs Market Dashboard PDF -> market_snapshots
==================================================
Parses a PriceLabs "Market Report" PDF export (the one you download from a Market
Dashboard) and feeds its market data into the Hub, where the pricing engine reads
it like any other market source (AirROI etc.).

Only the PDF's *text layer* is read. That gives the summary-level data cleanly:
  - KPIs (page "KPIs"): occupancy, ADR, RevPAR, booking window, LOS, listings, revenue
  - Summary Table: per-bedroom median nightly / weekly / MONTHLY booked price, LOS
  - Key Future Dates: high-demand date ranges with a % occupancy lift
The per-date charts (future-occupancy curve, booking curves, day-of-week, amenities,
policies) are images, NOT text — their granular series can't be read from the PDF.
For those, use PriceLabs' CSV export / API and POST pacing[]/metrics[] to the same
endpoint; the shape already supports them.

    POST {APP_URL}/api/market/pricelabs   <- parsed areas (x-scraper-key auth)

Usage:
    python pricelabs_pdf.py MarketDashboardTLV.pdf                 # parse + post
    python pricelabs_pdf.py MarketDashboardTLV.pdf --dry-run       # print JSON only
    PRICELABS_NEIGHBORHOOD="Lev HaIr" python pricelabs_pdf.py report.pdf

Env:
    APP_URL                 dashboard base URL (default http://localhost:3000)
    SCRAPER_API_KEY         must match the app's SCRAPER_API_KEY (omit in local dev)
    PRICELABS_NEIGHBORHOOD  which area this report represents. "*" (default) fans the
                            city-wide report out to EVERY portfolio neighborhood so
                            all units pick it up; or set a specific unit.neighborhood,
                            or a comma-separated list.
    PRICELABS_CURRENCY      display currency label (default ILS)
"""

import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request

from pypdf import PdfReader

APP_URL = os.environ.get("APP_URL", "http://localhost:3000").rstrip("/")
SCRAPER_API_KEY = os.environ.get("SCRAPER_API_KEY", "")
NEIGHBORHOOD = os.environ.get("PRICELABS_NEIGHBORHOOD", "*").strip() or "*"
CURRENCY = os.environ.get("PRICELABS_CURRENCY", "ILS").strip() or "ILS"

# Occupancy ceiling when projecting a key-date % lift onto the baseline, so a big
# "+11%" on an already-high baseline can't imply an impossible >100% fill.
OCC_CEILING = 0.98


# ------------------------------------------------------------------ parsing
def money(s):
    """'₪4.52K' -> 4520.0 ; '₪675' -> 675.0 ; '185k' -> 185000.0 ; '794' -> 794.0."""
    s = (s or "").replace("₪", "").replace(",", "").strip()
    mult = 1.0
    if s and s[-1] in "kKmM":
        mult = 1000.0 if s[-1] in "kK" else 1_000_000.0
        s = s[:-1]
    try:
        return float(s) * mult
    except ValueError:
        return None


def first(pattern, text, conv=lambda x: x, flags=0):
    m = re.search(pattern, text, flags)
    if not m:
        return None
    try:
        return conv(m.group(1))
    except (ValueError, TypeError):
        return None


def parse_kpis(text):
    """The KPI block + cover page -> a MarketSummary dict (or None if nothing found)."""
    occ_raw = first(r"Estimated Occupancy %\s*([\d.]+)", text, float)
    occupancy = None
    if occ_raw is not None:
        occupancy = occ_raw / 100.0 if occ_raw > 1.0 else occ_raw

    adr = first(r"ADR \(Average Daily Rate\)\s*₪?\s*([\d.,]+[kKmM]?)", text, money)
    revpar = first(r"RevPAR\s*₪?\s*([\d.,]+[kKmM]?)", text, money)
    # Cover page carries the market-total revenue ("...Revenue 185k"); the KPI tile
    # is hyphenated ("Rev-\nenue") and per-listing, so prefer the cover total.
    revenue = first(r"Estimated Rental Revenue\s+([\d.,]+[kKmM])", text, money)
    booking_window = first(r"Booking Window\s*([\d.]+)", text, float)
    los = first(r"Length of Stay\s*([\d.]+)", text, float)
    bookings = first(r"\nBookings\s*([\d.]+)", text, float)
    listings = first(r"Available Listings\s*([\d.]+)", text, float)
    # No min-stay KPI; the comp-set filter floor ("minimum N nights") is the proxy.
    min_nights = first(r"minimum\s+(\d+)\s+nights", text, float)

    if occupancy is None and adr is None and revpar is None:
        return None, bookings
    return {
        "occupancy": occupancy or 0.0,
        "average_daily_rate": adr or 0.0,
        "rev_par": revpar or 0.0,
        "revenue": revenue or 0.0,
        "booking_lead_time": booking_window or 0.0,
        "length_of_stay": los or 0.0,
        "min_nights": min_nights or 0.0,
        "active_listings_count": listings or 0.0,
    }, bookings


SUMMARY_COLS = [
    "activeListings",
    "medianListedPrice",
    "medianBookedNightly",
    "medianBookedWeekly",
    "medianBookedMonthly",
    "medianLos",
    "medianBookingWindow",
]


def parse_summary_table(text):
    """Per-category rows: 7 trailing integers (active, listed, nightly, weekly,
    monthly, LOS, booking window). The MONTHLY median is the key MTR comp."""
    rows = []
    seven = r"\s+".join([r"(\d+)"] * 7)
    patterns = [
        ("1 & 2 BR", r"bedrooms[^\d]*?" + seven),
        ("1 BR", r"\b1 BR\s+" + seven),
        ("2 BR", r"\b2 BR\s+" + seven),
    ]
    for label, pat in patterns:
        m = re.search(pat, text)
        if not m:
            continue
        vals = [int(g) for g in m.groups()]
        row = {"category": label}
        row.update(dict(zip(SUMMARY_COLS, vals)))
        rows.append(row)
    return rows


def parse_key_future_dates(text):
    """'Jul 09, 2026 to Jul 14, 2026 is seeing a 11.3 % increase' -> ranges."""
    out = []
    pat = r"(\w+ \d{1,2}, \d{4})\s+to\s+(\w+ \d{1,2}, \d{4})\s+is seeing a\s+([\d.]+)\s*%\s+increase"
    for m in re.finditer(pat, text):
        try:
            start = datetime.datetime.strptime(m.group(1), "%b %d, %Y").date()
            end = datetime.datetime.strptime(m.group(2), "%b %d, %Y").date()
        except ValueError:
            continue
        out.append((start, end, float(m.group(3))))
    return out


def build_pacing(occupancy, key_dates):
    """Project each key-date % lift onto the baseline occupancy as per-day fill_rate.
    Honest about its limits: booked/available counts and booked_rate are left 0
    (unknown from the PDF), so the engine only flexes occupancy/demand on these
    dates and falls back to the summary occupancy everywhere else."""
    base = occupancy or 0.0
    if base <= 0:
        return []
    pacing = []
    for start, end, pct in key_dates:
        fill = round(min(OCC_CEILING, base * (1.0 + pct / 100.0)), 4)
        day = start
        while day <= end:
            pacing.append({
                "date": day.isoformat(),
                "booked_count": 0,
                "available_count": 0,
                "booked_rate_avg": 0,
                "available_rate_avg": 0,
                "fill_rate": fill,
            })
            day += datetime.timedelta(days=1)
    return pacing


def short_filter(filter_line):
    if not filter_line:
        return None
    low = filter_line.lower()
    if "1 and 2 bedroom" in low:
        return "1 & 2 BR"
    m = re.search(r"(\d+)\s*bedroom", low)
    return f"{m.group(1)} BR" if m else None


def parse_pdf(path):
    reader = PdfReader(path)
    pages = [(p.extract_text() or "") for p in reader.pages]
    text = "\n".join(pages)

    report_for = first(r"Market Report for:\s*\n?\s*([^\n]+)", text, lambda s: s.strip())
    filter_line = first(r"\n(Airbnb:[^\n]+)", text, lambda s: s.strip())
    created = first(r"Created Date\s*\n?\s*([A-Za-z]+ \d{1,2}, \d{4})", text, lambda s: s.strip())

    summary, bookings = parse_kpis(text)
    summary_table = parse_summary_table(text)
    key_dates = parse_key_future_dates(text)
    pacing = build_pacing(summary["occupancy"] if summary else 0.0, key_dates)

    name_bits = [b for b in (report_for, short_filter(filter_line)) if b]
    market_name = (" — ".join(name_bits) + " (PriceLabs)") if name_bits else "PriceLabs market"

    return {
        "reportFor": report_for,
        "filterLine": filter_line,
        "createdDate": created,
        "bookings": bookings,
        "marketName": market_name,
        "filterLabel": short_filter(filter_line),
        "summary": summary,
        "pacing": pacing,
        "summaryTable": summary_table,
        "keyDates": [(s.isoformat(), e.isoformat(), p) for (s, e, p) in key_dates],
    }


# ------------------------------------------------------------------ payload + post
def build_payload(parsed):
    neighborhoods = [n.strip() for n in NEIGHBORHOOD.split(",") if n.strip()] or ["*"]
    areas = []
    for n in neighborhoods:
        areas.append({
            "neighborhood": n,
            "marketName": parsed["marketName"],
            "currency": CURRENCY,
            "summary": parsed["summary"],
            "pacing": parsed["pacing"],
            "minNights": [],
            "metrics": [],
            "filterLabel": parsed["filterLabel"],
            # Extra MTR context (median monthly price by bedroom). The endpoint
            # ignores unknown fields today; kept here so it's one wiring step away.
            "summaryTable": parsed["summaryTable"],
        })
    return {"source": "pricelabs-pdf", "areas": areas}


def post(payload):
    url = f"{APP_URL}/api/market/pricelabs"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    if SCRAPER_API_KEY:
        req.add_header("x-scraper-key", SCRAPER_API_KEY)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def print_summary(parsed):
    s = parsed["summary"] or {}
    print(f"  Report : {parsed['reportFor']}  ({parsed['createdDate']})")
    print(f"  Filter : {parsed['filterLine']}")
    if s:
        print(
            f"  KPIs   : occ {s['occupancy'] * 100:.0f}%  ADR ₪{s['average_daily_rate']:.0f}  "
            f"RevPAR ₪{s['rev_par']:.0f}  window {s['booking_lead_time']:.0f}d  "
            f"LOS {s['length_of_stay']:.0f}  listings {s['active_listings_count']:.0f}"
        )
    for r in parsed["summaryTable"]:
        print(
            f"  {r['category']:<8}: {r['activeListings']} listings  "
            f"nightly ₪{r['medianBookedNightly']}  monthly ₪{r['medianBookedMonthly']}  "
            f"LOS {r['medianLos']}  window {r['medianBookingWindow']}d"
        )
    print(f"  Key dates: {len(parsed['keyDates'])} range(s) -> {len(parsed['pacing'])} pacing day(s)")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    dry = "--dry-run" in sys.argv or os.environ.get("DRY_RUN") == "1"
    path = args[0] if args else os.environ.get("PRICELABS_PDF", "")
    if not path:
        print("usage: python pricelabs_pdf.py <report.pdf> [--dry-run]", file=sys.stderr)
        sys.exit(2)
    if not os.path.exists(path):
        print(f"file not found: {path}", file=sys.stderr)
        sys.exit(2)

    print(f"Parsing {path}")
    parsed = parse_pdf(path)
    print_summary(parsed)

    if parsed["summary"] is None and not parsed["pacing"]:
        print("[error] no usable market data parsed — is this a PriceLabs Market Report PDF?",
              file=sys.stderr)
        sys.exit(1)

    payload = build_payload(parsed)
    targets = ", ".join(a["neighborhood"] for a in payload["areas"])
    print(f"  -> {len(payload['areas'])} area payload(s) for: {targets}")

    if dry:
        print("\n--- payload (--dry-run, not posted) ---")
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return

    try:
        res = post(payload)
        print(f"  -> posted: {res}")
    except urllib.error.HTTPError as e:
        print(f"[error] POST {APP_URL}/api/market/pricelabs -> HTTP {e.code}: "
              f"{e.read().decode(errors='replace')[:300]}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"[error] posting to {APP_URL}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
