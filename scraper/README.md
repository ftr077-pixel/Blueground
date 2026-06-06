# Airbnb rank proof

Proves the core of the product: capture **what page + position** one listing
holds in Airbnb search, for several date windows. Uses the open-source
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

## Notes / known limits

- "Page" assumes Airbnb's web UI shows ~18 results/page; **global rank** is the
  hard number. We can recalibrate page size against the live site.
- Airbnb personalizes results; this measures from a neutral (logged-out)
  vantage, so treat the index as a **relative trend**, not absolute truth.
- Airbnb caps total search results (~a few hundred). "Not found but in-area"
  means *ranked beyond the cap* — itself a useful signal.
