# Airbnb visibility scraper

Captures **what page + position** a listing holds in Airbnb search, by stay
length and check-in date, and feeds the dashboard. Uses the open-source
[`pyairbnb`](https://github.com/johnbalvin/pyairbnb) library, which calls
Airbnb's internal `StaysSearch` GraphQL API.

## Scripts

- **`airbnb_rank_proof.py`** — the original proof: page/position of one listing
  for three fixed date windows.
- **`airbnb_visibility.py`** — the measurement layer: auto-detects the listing's
  **minimum-stay** from its calendar, builds an **eligibility** map (which
  stay-lengths can even appear), sweeps rank across **shifted check-in dates**,
  and reports a v2 index that keeps *ineligible (min-stay)* separate from
  *eligible-but-ranked-low*.
- **`run_agent.py`** — **server mode** (the box's cron entrypoint): pulls tracked
  searches from the dashboard (`GET /api/visibility/config`), scans each, and posts
  results back (`POST /api/visibility/snapshot`). This is what runs on the box.

> ⚠️ Run this on a **residential IP** (your laptop / home connection). Datacenter
> IPs get blocked by Airbnb. If you hit blocks or empty results, add a proxy.

## Run

```bash
cd scraper
python3 -m venv .venv && source .venv/bin/activate   # optional but recommended
pip install -r requirements.txt
python airbnb_rank_proof.py
```

### Options (env vars)

| Var | Purpose |
|-----|---------|
| `PROXY_URL` | Route requests through a proxy, e.g. `http://user:pass@host:port` |
| `AUTO_BOX=1` | Center the search box on the listing automatically (use if it isn't in Tel Aviv) |

## What it does

1. Searches the Tel Aviv area for **2 guests** across three windows anchored at
   **Aug 1, 2026**: 1 week, 2 weeks, 1 month.
2. Finds listing `1602229503214826484` in the ranked results and reports its
   **page**, **position**, global **rank**, the **price** it's showing, and rating.
3. Prints a provisional **Visibility Index** (placeholder formula — we'll tune it).
4. If the listing isn't found, fetches it directly to tell you whether it's
   *outside the search box* or *ranked beyond Airbnb's result cap*.

Edit the `CONFIG` block at the top of `airbnb_rank_proof.py` to change the
listing, guests, currency, search box, or date windows.

## Server mode (the box)

`run_agent.py` is what runs on the always-on box — it connects the scraper to the
dashboard so the two share data.

```bash
APP_URL="http://localhost:3000" \
SCRAPER_API_KEY="<same value as the app's SCRAPER_API_KEY>" \
PROXY_URL="http://user:pass@host:port" \
python run_agent.py
```

| Var | Purpose |
|-----|---------|
| `APP_URL` | Dashboard base URL (default `http://localhost:3000`) |
| `SCRAPER_API_KEY` | Must match the app's `SCRAPER_API_KEY`, or the app rejects writes |
| `PROXY_URL` | Residential proxy — **required on a datacenter box** (Airbnb blocks cloud IPs) |

Daily cron at 08:00:

```
0 8 * * * cd ~/app/scraper && . .venv/bin/activate && APP_URL=http://localhost:3000 SCRAPER_API_KEY=xxx PROXY_URL=http://user:pass@host:port python run_agent.py >> ~/scan.log 2>&1
```

## Troubleshooting

- **`CONNECT tunnel failed, response 407` / `Proxy Authentication Required`** —
  your **proxy** rejected the credentials in `PROXY_URL` (this happens at the
  proxy, before any request reaches Airbnb — it is *not* an Airbnb block). The
  run aborts immediately with a non-zero exit instead of retrying. Check: the
  `user:pass` is current and any `@ : / # %` in them are **URL-encoded**; the
  box's IP is whitelisted if the plan uses IP auth; the plan still has quota.

## Notes / known limits

- "Page" assumes Airbnb's web UI shows ~18 results/page; **global rank** is the
  hard number. We can recalibrate page size against the live site.
- Airbnb personalizes results; this measures from a neutral (logged-out)
  vantage, so treat the index as a **relative trend**, not absolute truth.
- Airbnb caps total search results (~a few hundred). "Not found but in-area"
  means *ranked beyond the cap* — itself a useful signal.

---

# PriceLabs market data (PDF) — `pricelabs_pdf.py`

A second, separate tool (not Airbnb). If you have a PriceLabs subscription, you can
feed its **Market Dashboard** into the Hub without scraping the site, hitting the
API, or using the proxy: **download the dashboard as a PDF**, then parse it.

```bash
cd scraper
pip install -r requirements.txt          # adds pypdf
python pricelabs_pdf.py MarketDashboardTLV.pdf --dry-run   # preview, post nothing
APP_URL=http://localhost:3000 SCRAPER_API_KEY=xxx \
  python pricelabs_pdf.py MarketDashboardTLV.pdf           # parse + ingest
```

It POSTs to `POST /api/market/pricelabs` (same `x-scraper-key` auth as the other box
endpoints) and the rows land in `market_snapshots` — the **same** table the pricing
engine already reads (`src/lib/pricing/providers.ts`), so prices start using it with
no further wiring.

| Var | Purpose |
|-----|---------|
| `APP_URL` | Dashboard base URL (default `http://localhost:3000`) |
| `SCRAPER_API_KEY` | Must match the app's `SCRAPER_API_KEY` |
| `PRICELABS_NEIGHBORHOOD` | Which area the report is for. `*` (default) fans a city-wide report out to **every** portfolio neighborhood; or set a specific `unit.neighborhood`, or a comma-separated list |
| `PRICELABS_CURRENCY` | Display currency label (default `ILS`) |

### Routine: drop a PDF, auto-ingest — `pricelabs_ingest_dir.py`

For a hands-off routine, don't automate the PriceLabs login (brittle + ToS). Instead:
**export the PDF whenever** (MTR market data moves slowly — weekly/monthly is plenty)
and **drop it in the inbox**. A cron scans the folder and ingests anything new, then
moves it to `processed/` (or `failed/`) so each PDF loads exactly once.

```bash
PRICELABS_INBOX=~/pricelabs-inbox APP_URL=http://localhost:3000 SCRAPER_API_KEY=xxx \
  python pricelabs_ingest_dir.py
```

`deploy/setup-box.sh` wires this up automatically (on by default): it creates
`<app>/scraper/pricelabs-inbox` and a cron (`PRICELABS_CRON_SCHEDULE`, default every
30 min). Drop a PDF in that folder and the next tick loads it — `tail -f
/var/log/pricelabs-pdf.log`. Turn it off with `PRICELABS_INGEST=0`.

### What it extracts (and what it can't)

Only the PDF **text layer** is read, which covers the summary-level data cleanly:

- **KPIs** — occupancy, ADR, RevPAR, booking window, length-of-stay, listings, revenue.
- **Summary Table** — per-bedroom median nightly / weekly / **monthly** booked price
  (the monthly median is the key mid-term comp).
- **Key Future Dates** — high-demand date ranges with a % occupancy lift, projected
  onto the baseline occupancy as per-day `pacing` points.

The dashboard's **charts are images**, so their granular per-date series (the
future-occupancy curve, booking curves, day-of-week factors, amenities, policies)
are **not** in the PDF and can't be read from it. For those, use PriceLabs' **CSV
export / API** and POST `pacing[]` / `metrics[]` to the same endpoint — the shape
already supports them.

> ℹ️ The app reads **one active market source** at a time (`market_source` setting).
> Importing PriceLabs flips it to `pricelabs`; the AirROI sync no-ops while it's set.
> Each source's rows are tagged, so switching back to `airroi` restores them.

---

## PriceLabs CSV exports → dashboard source — `pricelabs_csv.py`

The Market Dashboard's per-report **CSV** exports carry the full per-date series the
PDF can't (daily occupancy, price percentiles, monthly history). Point the ingester
at a folder holding them and PriceLabs becomes the **market source of truth** — the
Market Analytics dashboard, the pricing engine, base-price and pacing all switch from
AirROI to PriceLabs (the POST flips `market_source`; AirROI sync no-ops while set).

```bash
cd scraper && pip install -r requirements.txt
python pricelabs_csv.py ./reports --dry-run          # preview, post nothing
APP_URL=http://localhost:3000 SCRAPER_API_KEY=xxx \
  python pricelabs_csv.py ./reports                  # ingest + switch source
```

Drop the exports in the folder (any filename prefix is fine):

| File | Mapped to |
|------|-----------|
| `*market_history.csv` | monthly `metrics[]` — Occ/ADR/RevPAR/Rev/BW/LOS (Aggregate) |
| `*supply_demand.csv`  | active listings per month + summary |
| `*occupancy.csv`      | forward `pacing[]` fill-rate (daily occupancy %) |
| `*prices.csv`         | forward booked / listed nightly rate (median booked, p50) |
| `*LOS.csv`, `*Booking_Curves.csv` | not mapped yet (no snapshot slot — see below) |

| Var | Purpose |
|-----|---------|
| `PRICELABS_NEIGHBORHOOD` | area label. Default `Tel Aviv` = one clean dashboard row; `*` fans out to every portfolio neighborhood so the engine applies it per-unit |
| `PRICELABS_MIN_NIGHTS` | market min-stay floor for the summary (default 4 — CSVs don't carry min-stay) |
| `PRICELABS_MARKET` / `PRICELABS_CURRENCY` | market name / currency label shown on the dashboard |

Switch back to AirROI any time by setting `market_source` to `airroi`. `LOS.csv` and
`Booking_Curves.csv` (LOS distribution, pickup curves) have no `market_snapshots`
slot yet — a richer store/charts can be added later without re-exporting.

---

## Daily refresh via the browser (Cowork) — `pricelabs_browser.py`

A scheduled **Cowork** session can refresh the dashboard daily with no SSH and no
shared folder: Cowork drives a browser to PriceLabs, exports the reports to its own
disk, then `pricelabs_csv.py` POSTs them to your app's **public URL**.

```
[daily Cowork session]
  pricelabs_browser.py  → log into PriceLabs, export reports → ./pricelabs-downloads
  pricelabs_csv.py ./pricelabs-downloads   (APP_URL=https://your-app  SCRAPER_API_KEY=…)
        → POST /api/market/pricelabs → dashboard + engine refresh
```

**Step 1 — discovery (one time).** PriceLabs' login fields and CSV-export controls
can't be scripted blind. Discovery logs in and dumps the page + network + export
candidates to `pricelabs-captures/`:

```bash
pip install playwright      # Cowork already ships Chromium; don't `playwright install` there
PRICELABS_EMAIL=… PRICELABS_PASSWORD=… \
PRICELABS_DASHBOARD_URLS="https://app.pricelabs.co/market-dashboard/…" \
  python pricelabs_browser.py --discovery
```

Share `pricelabs-captures/manifest.json` (+ a `page-*.png`) and the exact export step
gets wired — either clicking the CSV buttons (`--download`) or reading the dashboard's
own JSON (often more robust than the buttons).

**Step 2 — daily run (after calibration).**

```bash
PRICELABS_EMAIL=… PRICELABS_PASSWORD=… PRICELABS_DASHBOARD_URLS=… \
  python pricelabs_browser.py --download            # → ./pricelabs-downloads
APP_URL=https://your-app SCRAPER_API_KEY=… \
  python pricelabs_csv.py ./pricelabs-downloads      # → ingest + switch source
```

| Var | Purpose |
|-----|---------|
| `PRICELABS_EMAIL` / `PRICELABS_PASSWORD` | PriceLabs login — Cowork **secrets**, never commit |
| `PRICELABS_DASHBOARD_URLS` | Market Dashboard URL(s) you export from (comma-separated) |
| `PRICELABS_STATE` | saved session so it skips re-login (default `.pricelabs_state.json`) |
| `APP_URL` / `SCRAPER_API_KEY` | your **public** app + key, for the ingest POST |
| `PROXY_URL` | optional residential proxy (if PriceLabs blocks the datacenter IP) |

**Scheduling.** Point a daily Claude Code on the web trigger at this flow (docs:
code.claude.com/docs/en/claude-code-on-the-web).

> ⚠️ Automating PriceLabs' site is brittle (UI changes, bot checks) and may breach
> their ToS — it's your account's risk. If your plan exposes market data via the
> **official PriceLabs API**, that's the robust alternative for an unattended daily job.
