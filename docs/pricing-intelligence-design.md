# Pricing Intelligence — Price→Position Learning System (Design)

> Status: **design / pre-implementation**. This spec is the agreed blueprint
> before any code is written. It turns the flat "▼ Lower → −5%" heuristic in
> `src/lib/revenue.ts` into a *learned* answer: **"drop ₪X (−Y%) and you'll move
> from page P₁ to page P₂ for this check-in, with this much confidence."**

---

## 1. Goal, in one sentence

Learn the relationship between **our price**, the **search position** Airbnb gives
us, and the **lead time** to check-in (plus, later, market demand) — then **invert
it** to recommend the smallest price change that buys a target position, and to
quantify the marginal positions gained per ₪ given up.

The two questions the operator actually acts on:

1. *To reach page 1 (or rank ≤ N) for this check-in, what price do I need?*
2. *Right now, how many positions does each ₪100/night (or each 1%) buy me?* — so
   we only give away as much margin as the climb is worth.

---

## 2. What already exists (and what we reuse)

This is **not** a greenfield build. The substrate is in place:

| Asset | Where | Role in the learner |
|---|---|---|
| `listing_snapshots` | `src/lib/db.ts` | Longitudinal log per listing × check-in × stay: `price`, `rank`, `page`, `position`, `total`, `ts`, `check_in`, `nights`. This is our label history. |
| `leadDays(checkIn)` | `src/lib/revenue.ts` | Lead time is already computed; `recommend()` uses it for **urgency** only. We extend it to drive **magnitude**. |
| `recommend()` | `src/lib/revenue.ts` | The heuristic we replace: today `suggested` = a flat `stepPct` (5%) cut to a floor margin. The learner supplies that number. |
| `marketRateBands()` | `src/lib/repos/visibility.ts` | Percentile nightly bands from priced appearances — our existing "market" analog. The ladder makes this far richer. |
| `portfolioTrend()`, `computeMovers()`, `listingHistory()` | `src/lib/repos/visibility.ts` | Existing time-series plumbing we extend, not duplicate. |
| Scraper `build_rankmap()` | `scraper/run_agent.py` | Already iterates **all** results to map our tracked IDs. Capturing the full ladder is a few extra lines on the same loop. |

The decisive gap: we record **our** listing's price+rank and the competitor
**count** (`total`), but **not the competitor price at each position**. Our own
code flags this twice — the note in `pricing-rank-panel.tsx` and "*Drop the price,
run a scan, and watch the rank climb*" in `listing-history.tsx`. Closing that gap
is M1 and the single biggest accuracy unlock.

---

## 3. Why the price ladder matters more than the model

- **With the full ladder** (price at rank 1, 2, 3, … ~280), a *single scan* hands
  us the entire price→position curve of the live market for that exact query. We
  can read "to sit at position 15 you need ≤ ₪993/night" **directly, today**, per
  check-in date. This is *cross-sectional* and fast.
- **Without it**, we can only learn from *our own* price moving across many scans —
  slow, confounded (Airbnb rank also reflects reviews, recency, instant-book,
  quality, host response, etc.), and impossible to separate "my price changed"
  from "the market moved."

So we capture the ladder first, then fit a deliberately **transparent** model on
top. The model's job is to smooth and invert a curve the data already contains —
not to be a black box the operator can't trust or act on.

---

## 4. Data model

### 4.1 New table: `search_results` (the competitor ladder)

One row per **(search, position)**, where a *search* = `profile_id × run_id ×
check_in × nights × guests`. Full ladder per the scope decision (~280 rows/search).

```sql
CREATE TABLE IF NOT EXISTS search_results (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL REFERENCES search_profiles(id),
  run_id        TEXT NOT NULL,
  ts            TEXT NOT NULL,        -- scan time (lead time = check_in − ts)
  check_in      TEXT NOT NULL,
  check_out     TEXT NOT NULL,
  nights        INTEGER NOT NULL,
  guests        INTEGER NOT NULL,
  total         INTEGER NOT NULL,     -- field size for this search
  room_id       TEXT,                 -- airbnb listing id at this position (may be null)
  rank          INTEGER NOT NULL,     -- 1..total, global
  page          INTEGER NOT NULL,     -- ceil(rank / 18)  (WEB_PAGE_SIZE = 18)
  position      INTEGER NOT NULL,     -- 1..18 within page
  price         REAL,                 -- stay total in `currency`
  price_nightly REAL,                 -- price / nights, precomputed
  currency      TEXT
);
CREATE INDEX IF NOT EXISTS idx_results_segment
  ON search_results(profile_id, nights, check_in, run_id);
CREATE INDEX IF NOT EXISTS idx_results_ts ON search_results(ts);
```

Notes:
- Our own listings appear in the ladder by `room_id`; we still keep
  `listing_snapshots` for the tracked-listing-centric views and **join by
  `room_id`** when we need "our point on the market curve."
- `price_nightly` is stored so segments with different stay lengths (7/14/30n) are
  directly comparable — same normalization `marketRateBands()` already uses.
- The data is public search-result pricing used for internal analytics. Worth a
  one-line ToS/robots acknowledgement, but no PII is stored.

### 4.2 New table: `listing_price_changes` (the experiment log)

`units` already have `pricing_history`; **tracked listings do not**. To learn
*causally* (Model B, §6.2) we log when a tracked listing's asking/target price
changes so we can attribute the next scan's rank move to it.

```sql
CREATE TABLE IF NOT EXISTS listing_price_changes (
  id          TEXT PRIMARY KEY,
  listing_id  TEXT NOT NULL REFERENCES tracked_listings(id),
  ts          TEXT NOT NULL,
  old_nightly REAL,
  new_nightly REAL,
  source      TEXT NOT NULL,   -- 'operator' | 'agent' | 'observed'
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_lpc_listing_ts ON listing_price_changes(listing_id, ts DESC);
```

### 4.3 Retention

Full ladder is ~280 rows/search; a 3-stay × 5-date profile = ~4,200 rows/run, ~380k
rows/profile over 90 runs. SQLite is fine into the millions, but we add a prune
job: keep **raw** ladder rows for `LADDER_RAW_DAYS` (default 120), then **downsample**
older runs to per-segment percentile summaries (p10/p25/p50/p75/p90 nightly by
rank-decile) in a `search_ladder_summary` table. Configurable in
`src/lib/config/pricing.ts`.

---

## 5. Pipeline changes (data capture)

### 5.1 Scraper — `scraper/run_agent.py`

`build_rankmap()` already walks every result. Add a sibling that emits the full
ladder for the search, and include it in the POST payload:

```python
def build_ladder(results, check_in, check_out, nights, guests, currency):
    out = []
    for i, r in enumerate(results):
        if not isinstance(r, dict):
            continue
        out.append({
            "rank": i + 1,
            "page": i // WEB_PAGE_SIZE + 1,
            "position": i % WEB_PAGE_SIZE + 1,
            "roomId": str(r.get("room_id")) if r.get("room_id") is not None else None,
            "price": result_price(r),          # existing helper
        })
    return {
        "checkIn": check_in, "checkOut": check_out, "nights": nights,
        "guests": guests, "total": len(results), "currency": currency,
        "results": out,
    }
```

Accumulate one ladder object per search and add `"searchResults": [...]` to the
existing snapshot payload. No new searches are issued — it's the **same** result
set we already fetch, so **zero extra proxy requests**; only the POST body and DB
grow. (Bandwidth/storage cost is the payload + rows, not new scrapes.)

### 5.2 Ingest — `POST /api/visibility/snapshot` + `recordRun()`

Extend `RecordRunInput` with an optional `searchResults` array and add
`recordSearchResults()` to `src/lib/repos/visibility.ts` (or a new
`src/lib/repos/search-results.ts`). For each result, compute
`price_nightly = price / nights` server-side and insert. Same `run_id`/`ts` as the
snapshots so ladder and our-listing rows line up exactly.

---

## 6. The model

Search rank is multi-factor; price is **one** lever. We therefore model the
**price→position relationship conditional on the field**, and we always report a
confidence so the operator knows when to trust it. Two complementary learners that
blend:

### 6.1 Model A — cross-sectional ladder curve (the workhorse, ships first)

For a **segment** `S = (profile/area, stay-length bucket, lead-time bucket)` and a
recent window `W` (e.g., 21 days, exponentially weighted toward now), gather all
ladder observations `(xᵢ = price_nightly, rankᵢ, totalᵢ)`.

- Normalize to **rank percentile** `qᵢ = rankᵢ / totalᵢ ∈ (0,1]` so different-sized
  searches combine (0 = top of results).
- Fit **isotonic regression** `g: x → q`, monotone non-decreasing (higher price ⇒
  worse percentile) via **PAVA** (Pool-Adjacent-Violators — small, dependency-free,
  lives in `src/lib/learning/isotonic.ts`). This smooths the noisy real curve into
  a monotone "price → expected position" mapping.
- **Invert** for a target page `p`: target rank `r* = p × 18`, target percentile
  `q* = r* / T` where `T` = segment's recent median `total`. Then
  `x* = g⁻¹(q*)` = the nightly price that *typically* sits at that position.
- **Recommendation** = `min(current_price, x*)`; report `Δ = current − x*`, `Δ%`,
  and expected new rank `g(current)·T → g(x*)·T`. We only ever suggest a **drop**
  here (raises are handled by the existing margin rule).
- **Marginal elasticity** at the current price = local slope `dq/dx · T` →
  *"each ₪100/night cut ≈ climb K positions right now."*

**Lead time** enters as the segment bucket (e.g., `0–7, 8–14, 15–30, 31–60, 61+`
days). Fitting per bucket lets the model *discover* your intuition rather than
assume it: at short lead time with a shrinking field (`total` falling run-over-run),
the curve shifts so a given price ranks better; at long lead time with a crowded
field, the same position costs a deeper cut. `total` and its trend are the
**supply-tightness** signal until real demand data arrives (§8).

**Worked example (seed data).** The seeded snapshot: 1-month stay, check-in
2026-08-01, our listing at `rank 51 / total 280`, `price 29783` →
`q = 51/280 = 0.18`, `nightly = 29783/30 = ₪993`. With the ladder we'd have the
other 279 points too; isotonic-fit `g`, then to hit **page 1** (`r*=18`,
`q*=18/280=0.064`) read `x* = g⁻¹(0.064)` — say ₪880/night → recommend −11%, with a
bootstrap CI and `n` attached.

### 6.2 Model B — longitudinal own-elasticity (causal-ish; accrues over time)

The cross-sectional curve says where a *typical* listing of a given price sits; our
listing has its own quality offset (reviews, photos, instant-book). Model B learns
**our** response from price moves over time, using `listing_price_changes` (§4.2):

- Per listing, between consecutive scans where our price moved materially, compute
  `Δrank`, `Δlog(price_own)`, `Δlog(comp_median_nightly)` (now available from the
  ladder), `Δlead`.
- Pool within segment (listing fixed effects when data allows) and regress
  `Δrank ~ β·Δlog(price_own) + γ·Δlog(comp_median) + δ·Δlead`. `β` is our own
  price-elasticity of rank; `γ` controls for **market drift** so we don't credit a
  price cut for a climb the whole market handed us.

**Blend.** Ship v1 on **A** alone (works the day ladder capture turns on). As B
accrues, apply it as a **listing-specific offset/correction** on A's inversion
(`our typical rank ≈ A-predicted rank + offset`). B needs price *variation*, which
the experiment loop (§7) deliberately creates.

### 6.3 Confidence (always reported)

- `n` = observations in segment×window.
- **Bootstrap** the isotonic fit (resample → refit → collect `x*`) → CI on the
  recommended price and expected rank.
- **Freshness** = days since the latest scan in the window.
- Gate: if `n < n_min`, CI too wide, or current price already ≤ `x*` → fall back to
  the heuristic and label it "learning" rather than emitting a false-precision number.

### 6.4 Why not a neural net / why in-app TS

Data volume is modest and the operator must **trust and act** on the output. A
monotone, segment-wise, invertible curve with a CI is more honest and debuggable
than a black box, needs no Python/infra, and reads SQLite live. A heavier offline
trainer or an LLM "analyst" explanation layer (the Anthropic SDK is already a dep)
can be added later as enhancements, not foundations.

---

## 7. Causality & the experiment loop

The question "*how much to decrease to climb*" is **interventional**, but most data
is observational. The cleanest signal is our own controlled nudges:

1. Operator (or agent) applies a recommended drop → logged to `listing_price_changes`.
2. Next scan captures the realized rank move.
3. We compare **predicted vs realized** Δrank and feed it back into Model B and the
   confidence calibration.

So the system gets smarter *as it acts*, not only from passive history. An optional
"nudge mode" can perturb price within a small band to actively probe elasticity —
gated by the existing Action Center rule (spec.md §5: moves > ±15% require human
approval) so it never acts beyond mandate.

---

## 8. Market demand & booking pace (your future data)

Designed to slot in with **no rearchitecting**. Two planned signals:

**Demand index** — a per-`(area, date)` value that **shifts the curve** (high
demand → a given price ranks better / books faster). Until then, ladder-derived
**supply tightness** (`total` and its run-over-run trend) is the proxy. Stub:

```ts
interface DemandSignal { area: string; date: string; index: number; /* -1..+1 */ }
```

**Market booking lead time (pacing)** — *planned: you'll provide the market's
booking-lead-time distribution.* This answers **"how aligned are we to the
market's pace?"** If the market for this area/stay-length typically books ~45 days
out and our comparable units are still unbooked at 20 days, we're **behind pace** —
a strong, demand-aware reason to cut *now*, independent of position. Conversely, if
we're booking *earlier* than the market, we may be leaving rate on the table.

Pacing pairs naturally with realized bookings (§9): market lead times set the
**benchmark**, MiniHotel gives **our** realized lead times, and the gap becomes
both a model feature and a headline metric in the Pricing Intelligence panel
("**pace vs market: −18 days**"). Stub:

```ts
interface MarketPace {
  area: string;
  nights: number;
  medianLeadDays: number;
  leadCdf: Array<{ leadDays: number; bookedPct: number }>; // share booked by N days out
}
```

---

## 9. North-star: position is a proxy; realized bookings are the truth

What you ultimately want to maximize is **expected profit = P(book | price, lead,
position) × profit(price)** — not position for its own sake. Position is the proxy
we model first because it's what we can observe today.

**Planned (once MiniHotel is connected in production):** real **booked prices and
dates** become available via `src/lib/integrations/minihotel.ts`. That unlocks the
real objective and, more importantly, lets us score **strategy success rate** — the
closed loop:

1. The model recommends a strategy (e.g. *"at 30d lead, drop to page 1"*).
2. We act and log it (`listing_price_changes`, §4.2).
3. MiniHotel tells us whether it **booked**, **when**, and at what **realized price**.
4. We attribute the outcome to the strategy → *"this policy converts X% of the
   time, at Y% of asking, and saves Z days on the shelf."*

At that point the target upgrades from *position* to *booking probability /
expected revenue*, the recommender optimizes profit directly, and §6's
position-curve becomes one **input** to a booking-conversion model rather than the
final answer. The design deliberately keeps `listing_price_changes` and the
experiment loop (§7) in place so this outcome data has somewhere to land.

---

## 10. Code & surface layout

```
src/lib/learning/
  types.ts            # Observation, SegmentKey, CurveFit, Elasticity, Recommendation
  dataset.ts          # assemble observations from search_results + listing_snapshots
  isotonic.ts         # PAVA isotonic regression (dependency-free)
  elasticity.ts       # fit segment curve (A), invert, slope, bootstrap CI, blend B
src/lib/repos/
  search-results.ts   # ladder insert + segment queries
src/app/api/learning/
  elasticity/route.ts # GET ?listingId=&targetPage= → rec + curve + confidence
  curve/route.ts      # GET ?profileId=&nights=&leadBucket= → fitted curve for charts
src/components/visibility/
  intelligence-panel.tsx
src/app/visibility/intelligence/page.tsx   # new "Pricing Intelligence" view
```

- **New sidebar entry** under the Revenue & Yield hub in `src/components/sidebar.tsx`
  (e.g. "Pricing Intelligence", `/visibility/intelligence`), beside "Pricing vs Rank".
- **Panel**: per listing, plot the fitted price→position curve with our current
  point; a target-page selector; recommended price + expected climb + **margin
  impact** (reuse `economics()`); confidence badge with `n` and freshness.
- **Wire into `recommend()`**: when a listing is buried *and* a confident curve
  exists, set `suggested` from the model (price to reach `rankWellPage`) instead of
  the flat `stepPct`, with a reason like *"learned: −6% → page 1 (n=142, ±₪300)."*
  Low confidence → existing heuristic, unchanged. The Search & Profit table keeps
  working; the number just gets smart. Floor guardrail unchanged (`floorMargin`,
  unit `min_rate`).

---

## 11. API contracts (sketch)

```
GET /api/learning/elasticity?listingId=lst-xxxx&targetPage=1&checkIn=2026-08-01
→ {
    listingId, checkIn, nights, leadDays, segment,
    current:    { nightly, rank, page, total },
    target:     { page, rank, nightly, deltaNightly, deltaPct, expectedRank },
    marginal:   { positionsPer100Nightly, positionsPerPct },
    economics:  { revenueBefore, revenueAfter, profitBefore, profitAfter, marginAfter },
    confidence: { n, ciNightlyLow, ciNightlyHigh, freshnessDays, level: "high"|"med"|"low" },
    curve:      [{ nightly, expectedRank }]   // sampled for charting
  }

GET /api/learning/curve?profileId=prof-xxx&nights=30&leadBucket=15-30
→ { segment, n, points: [{ nightly, q, expectedRank }], updatedAt }
```

---

## 12. Evaluation / backtest plan

- **Inversion accuracy** — hold out the most recent scans; for held-out (price,
  rank) of *our* listings, check predicted rank at that price (MAE on rank & page),
  and calibrate the "reaches page 1" call (Brier / AUC).
- **Causal check** — over historical own price changes, compare predicted vs actual
  Δrank (directional accuracy + MAE).
- **Online** — after a recommended drop is applied, log predicted vs realized move;
  track calibration over time (this is the real proof and feeds §7).
- **Guardrails** — never recommend below floor margin or unit `min_rate`; never emit
  a number below confidence threshold.

---

## 13. Phasing

| Milestone | Deliverable | Verifiable by | Status |
|---|---|---|---|
| **M1 Data** | `search_results` table + scraper ladder emit + ingest + `price_nightly` backfill | rows accumulate per scan; ladder visible in a debug query | ✅ shipped (+ §4.3 retention: `pruneLadder` → `search_ladder_summary`) |
| **M2 Model A + read UI** | `elasticity.ts` (cross-sectional) + `/api/learning/*` + Pricing Intelligence panel (read-only insight) | curve renders; "price for page 1" matches a manual read of the ladder | ✅ shipped |
| **M3 Wire-in** | learned `suggested` in `recommend()` + confidence gating + fallback | Search & Profit "▼ Lower → ₪X" reflects the curve, not 5% | ✅ shipped |
| **M4 Model B + experiments** | `listing_price_changes` + longitudinal fit + backtest harness | predicted vs realized Δrank tracked | ✅ shipped (`longitudinal.ts`; offset + own-elasticity feed the rec) |
| **M5 Demand & pace** | demand index + market booking-lead-time (pace) features | curve shifts with demand; "pace vs market" shown | ◐ pace shipped (`/api/learning/market-pace` ingest + "pace vs market"); demand index awaits the operator's feed |
| **M6 Outcomes** | MiniHotel realized bookings → strategy success-rate & expected-profit target | recommend→act→book attributed; policy conversion tracked | ✅ shipped (bookings sync + `attribution.ts` strategy report) |

---

## 14. Risks & open questions

**Risks (with mitigations)**
- *Rank is multi-factor* → cap claims, always show confidence, keep human-in-loop.
- *Sparse own-price variation for Model B* → lean on A; use the nudge loop to create variation.
- *Ladder volume* → retention + downsampling (§4.3).
- *Airbnb personalization/geo* → scraper already pins box, guests, currency,
  language; API results are effectively de-personalized — keep it that way.
- *Confounding market drift* → controlled via competitor median (`γ` term in B).

**Planned inputs (confirmed — the model is built to receive these)**
- **Realized bookings** via MiniHotel in production → strategy success-rate &
  expected-profit target (§9). Biggest lever after the ladder.
- **Market booking lead times** → pace-vs-market benchmark and a demand feature (§8).

**Still open for you**
1. **Demand index shape** — per area? per date? what index range/cadence? (§8)
2. **Retention window** — is 120 days of raw ladder + percentile summaries acceptable, or do you want longer raw history?
3. **Segment granularity** — confirm the lead-time buckets (`0–7 / 8–14 / 15–30 / 31–60 / 61+`) match how you think about booking windows.

---

*Next step on approval: implement **M1** (ladder capture) so data starts
accumulating immediately, since the model's quality is gated on history depth.*
