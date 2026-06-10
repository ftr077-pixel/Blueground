# PriceLabs Feature Catalog & Build Backlog

> Internal reference for the **Rental Orchestrator Hub**. Captures the full PriceLabs
> product surface so we can borrow the right ideas when building new capabilities —
> primarily for the **Pricing Specialist** worker and the **Revenue & Yield** department,
> but also for market-data, analytics, and portfolio-management features elsewhere in the app.
>
> **Last updated:** 2026-06-10

---

## How this was built (and its limits)

- **Sourcing method:** a WebSearch sweep run in three parallel passes (pricing engine; stay
  controls + market data; ops/analytics/integrations/verticals). PriceLabs' help center
  (`help.pricelabs.co`) returns **HTTP 403** to automated fetchers (bot protection) and this
  execution environment blocks direct `curl` (host allowlist), so the pages **could not be
  scraped verbatim**. Everything here is distilled from PriceLabs' indexed help + marketing
  pages via search, with source links at the end of each Part.
- **Confidence:** feature names and behaviors are well-corroborated across multiple PriceLabs
  pages. A handful of exact option labels, formulas, API rate limits, and enterprise limits are
  marked **"(unverified)"** inline. 2026 pricing figures are third-party/marketing summaries.
- **MTR relevance tag:** every feature carries a **High / Medium / Low** tag judged for *our*
  use case — a 30–90+ night furnished mid-term-rental (MTR) portfolio in Tel Aviv — where
  monthly/length-of-stay pricing and minimum-stay floors dominate, and nightly last-minute
  discounting, orphan-gap logic, and day-of-week tuning mostly do **not** apply.
- **2026-06-10 re-check:** swept the [Customizations KB category index](https://help.pricelabs.co/portal/en/kb/pricelabs/dynamic-pricing/customizations)
  (still HTTP 403 to fetchers; reconstructed via search). Cross-checked Part 1 against the live
  "List of all PriceLabs Customizations" article and added four items previously missing:
  **Rounding**, **Smoothing**, **Neighborhood Profile Data Source**, and **adjacent-day
  min-stay rules** (before/after an unavailable night).

## How to use this catalog

1. **Learning:** Parts 1–3 are the full feature inventory, grouped by area, each item with what
   it does, its key settings, and MTR relevance.
2. **Building:** when we add a new capability, skim the relevant Part for prior art, then check
   the **Build Backlog** below for the curated, ranked shortlist that fits our architecture.
3. **Keep it alive:** this was a point-in-time scrape (PriceLabs ships fast — see the 2026
   "Revenue Accelerator" in Part 3). Re-run the sweep periodically and bump *Last updated*.

---

## TL;DR — the mid-term-rental lens

PriceLabs is a **base-price-anchored** engine: you set one number (the yearly *average* nightly
rate), it multiplies that base by a stack of market factors per date (seasonality, demand,
pacing, adjacency, lead time), then **clamps the result to a min-price floor / max ceiling** and
applies customizations. Prices + minimum-stays recompute daily and sync to channels.

For **our** 30–90+ night furnished portfolio, the takeaways invert the STR defaults:

- **The min-price floor is king.** PriceLabs' single most important MTR knob; it protects the
  monthly-equivalent economics from being undercut by any discount logic. *Built since 06-07:
  per-unit floor/ceiling plus per-date min/max overrides.*
- **LOS + weekly/monthly discounts are the real lever.** The effective *monthly* rate wins or
  loses the booking, not the nightly number. *Built since 06-07: weekly/monthly/quarterly
  discounts and a surfaced `effectiveMonthlyRate`.*
- **Minimum-stay floors define the product.** A "Lowest Min Stay Allowed" of e.g. 30 nights is
  what makes a unit mid-term rather than short-term. *Built since 06-07: per-unit `minStay` with
  a 30-night `lowestMinStay` hard floor (competitor min-nights still benchmarked).*
- **Mostly ignore the STR machinery:** last-minute discounts, orphan/gap-night pricing,
  day-of-week, and high pacing sensitivity are short-stay mechanics with Low MTR relevance.
  *The rule engine ships last-minute and day-of-week implemented but OFF by default.*
- **Date-dimension features are no longer blocked.** The rule engine + Rates Calendar give every
  unit a per-date price curve (180-day horizon) with Date-Specific Overrides; pricing is no
  longer a single `currentRate`.
- **One thing we already do that PriceLabs gates behind enterprise/preview:** a human approval
  queue (our **Action Center**, the ±15% gate). Keep it — it's a differentiator.

---

## What our app already has (and the gaps)

> Snapshot refreshed **2026-06-10** — the rule-engine settings editor (`8daaa9d`), the Rates
> Calendar with Date-Specific Overrides, and the MiniHotel Pull/Push integration all landed
> after the original 06-07 sweep, closing most of the ❌ rows below.

| Area | PriceLabs | Our app today | Where | Gap / priority |
|---|---|---|---|---|
| Base-price anchor | Base Price (yearly avg) | `Unit.baseRate`; agent + rule engine price off base | `units.ts`, `pricing/engine.ts` | ✅ have |
| Min / Max price floor | Min/Max + "Safety Minimum Price" | per-unit floor/ceiling (`floorPctOfBase` / `ceilingPctOfBase`) + per-date min/max overrides | `config/pricing.ts`, `repos/rates.ts` | ✅ have |
| Seasonality factor | Seasonality (broad, by month) | monthly-index rule in the engine | `config/pricing.ts`, `pricing/engine.ts` | ✅ have (per-season min/base/max profiles still ❌) |
| Demand factor | Demand (events / holidays / DoW) | demand-events rule (capped ±15%) over the learned market demand index | `pricing/engine.ts`, `learning/demand.ts` | ✅ have |
| Pacing factor | Pace vs. historical trend | pacing rule vs. seasonal norm (±10% cap) | `pricing/engine.ts` | ✅ have |
| Occupancy-based | OBA bands (own + portfolio) | OBA bands in the engine + agent `occTilt` | `config/pricing.ts`, `pricing-specialist.ts` | ✅ have (portfolio-level bands ❌) |
| Last-minute / far-out | lead-time curves | both rules implemented; last-minute OFF by default (MTR), far-out premium ON | `config/pricing.ts` | ✅ have |
| LOS / weekly / monthly discount | LOS tiers + weekly/monthly | per-unit weekly/monthly + quarterly LOS tier; effective monthly rate surfaced | `config/pricing.ts`, `agents/pricing-specialist.ts` | ✅ have |
| Minimum-stay policy + hierarchy | default / lowest-allowed / far-out + engine | per-unit `minStay`, 30-night `lowestMinStay` floor, demand-tier bumps, far-out hierarchy; competitor `minNights` benchmarked | `config/pricing.ts`, `visibility.ts` | ✅ have |
| Orphan / gap nights | gap pricing + min-stay shaping | none | — | ❌ Low (MTR) |
| Comp-set / market data | Market Dashboards, Neighborhood Data | scraper + p25/50/75 neighborhood percentile bands (our "Neighborhood Data") | `repos/visibility.ts`, `scraper/` | ✅ have |
| Multi-listing groups / bulk | Account → Group → Listing | flat unit list | — | ❌ Medium |
| Sync / Sync-Now / Timed | overnight + manual + real-time | pricing pass + MiniHotel **Pull/Push** with end-to-end write verification | `api/agents/pricing/run`, `integrations/minihotel.ts` | ✅ real PMS sync (MiniHotel) |
| Analytics / KPIs | Portfolio Analytics, Report Builder + AI | visibility trends/movers + mocked dept KPIs | `analytics-panel.tsx`, `mock-data.ts` | ⚠️ partial |
| Date-specific overrides | per-date price / min-stay | Rates Calendar **Date Specific Overrides**: fixed price (final), per-date min/max, range apply/clear + stay totals | `repos/rates.ts`, `visibility/rate-calendar.tsx` | ✅ have |
| Rounding / smoothing | Rounding & Smoothing (Advanced tab) | rates rounded to nearest ₪5 (`roundRate`) | `config/pricing.ts` | ⚠️ cosmetic gap — no charm endings / stay-level smoothing (Low for MTR) |
| Human gate / preview | Group-Level Preview Prices | **Action Center** approval queue (±15% gate) | `action-center`, `pricing-specialist.ts` | ✅ have (differentiator) |
| Notifications / nudges | Notification center, Base Price Nudge | Activity Feed | `activity-feed.tsx` | ⚠️ analog |
| API / integrations | Customer API (read rates / write settings) | MiniHotel two-way (pull rates/actuals, push prices) — first real integration | `integrations/minihotel.ts` | ⚠️ partial (no general API surface) |

---

## Build Backlog — top features to add (ranked)

Curated for **impact × fit with our architecture × effort**, and constrained to things we can
build *inside the current mock/SQLite milestone* (no real PMS/channel integrations — respects
spec.md §6). Effort: **S** ≈ <½ day, **M** ≈ 1–2 days, **L** ≈ multi-day.

> **Status check 2026-06-10:** #1–#5 have shipped — floor/ceiling + per-date min/max (#1),
> weekly/monthly/quarterly discounts + effective monthly rate (#2), first-class min-stay with a
> 30-night hard floor (#3), p25/50/75 neighborhood percentile bands (#4), and per-date factor
> decomposition in the rule engine (#5). Still open: #6 (base-price drift nudge), #7 (seasonal
> profiles with per-season min/base/max), #8 (group-level preview).

| # | Feature | Impact | Fit | Effort | What changes |
|---|---|---|---|---|---|
| 1 | **Price floor & ceiling per unit** ("Safety Minimum Price") | High | High | **S** | Add `minRate`/`maxRate` to `Unit`; clamp `newRate` in `computeProposal`; show floor/ceiling in pricing panel. Closes the only real downside risk in today's model. |
| 2 | **Monthly / weekly / LOS discount model + effective monthly rate** | High | High | **M** | Add discount tiers to `Unit`; compute and surface the *effective monthly rate* (the number that actually wins MTR bookings) in the panel + activity feed. Directly serves spec §3.3. |
| 3 | **Minimum-stay policy as a first-class agent output** | High | High | **M** | Add `minStay` + a "Lowest Min Stay Allowed" floor (e.g. 30) to `Unit`; agent emits a min-stay recommendation alongside price; benchmark against competitor `minNights` we already scrape. |
| 4 | **Market comp-set panel from our visibility data** (percentile bands) | High | High | **M** | Compute 25/50/75th-percentile nightly rates per neighborhood × stay-length from `listing_snapshots` — our home-grown "Neighborhood Data." Feeds base-price decisions; reuses data we already collect. |
| 5 | **Explainable factor decomposition** (Seasonality + Demand + Pacing) | Med-High | High | **M** | Split the single mocked `demandIndex` into named factors and render a tooltip-style "why" per decision — big legibility win for the Synthesis View / Coach (spec §4). |
| 6 | **Recommended Base Price + drift "Nudge" → Action Center** | Med-High | High | **M** | Agent derives a recommended base from the comp-set (#4) and raises an Action Center nudge when the current base drifts > ~7%. Ties pricing + visibility + Action Center together. |
| 7 | **Seasonal profiles** (per-season min / base / max) | Med-High | Med | **M** | Model TLV MTR seasonality (relocation / academic / High-Holiday cycles) with per-season floors. Best done after #1. |
| 8 | **Group-level pricing preview** (dry-run before apply) | Med | High | **S-M** | Preview a pricing pass across all units before it writes — maps to PriceLabs "Group-Level Preview Prices" on top of our Action Center pattern. |

**Deliberately *not* prioritized** (low MTR value or out of scope this milestone): last-minute
discounts, orphan/gap-night pricing, day-of-week / "define your own weekend", high pacing
sensitivity, real PMS/channel sync + Customer API (spec §6 non-goal), and true per-date
date-specific overrides (needs a full pricing-calendar model — a separate, larger milestone).
Likewise charm-price rounding and multi-night smoothing (Advanced-tab cosmetics; we already
round to ₪5 steps).

---
---

# Full Catalog

## Part 1 — Core Pricing Engine, Market Factors & Customizations

PriceLabs' engine anchors every recommendation on a user-set **base price**, then layers market
factors (seasonality, demand, pacing, adjacency) and a stack of user customizations on top,
bounded by per-date min/max floors and ceilings.

### Base Price

- **Base Price** — The single anchor number: the *average* nightly rate you'd charge across the whole year (not your peak, not your floor). PriceLabs fluctuates rates around it based on season, day-of-week, events/holidays, demand, and lead time; every guest-facing price flows from this one number. For mid-term, the guidance is to set base from the monthly rate you typically charge, then use length-of-stay/monthly discounts on top. *Key settings:* a single nightly value per listing (can be overridden seasonally via Custom Seasonal Profiles); set under Pricing Dashboard → Review Prices. *MTR relevance:* High — the base is still the anchor, but for 30–90+ night furnished units it should be derived from a monthly target divided to a nightly equivalent, since LOS/monthly discounts and min-stay floors carry the actual pricing.
- **Base Price Help tool ("Help me choose a base price")** — A guided tool that suggests an optimal starting base price from inputs like bedroom count and market data; "Market-Driven" is the recommended starting mode for most users. *Key settings:* Market-Driven (recommended) vs. manual; suggestion based on bedrooms, market data, listing attributes. *MTR relevance:* Medium — useful for a first nightly anchor, but mid-term operators usually adjust the suggestion to reflect monthly economics rather than nightly STR comps.
- **Recommended Base Price** — A personalized base-price recommendation generated after ~14–21 days of consistent price syncing, computed from your listing's performance vs. the market over a ~60-day window, weighting recent data more heavily. Can appear blank temporarily after a recent base-price change (needs days to recalibrate). *Key settings:* none directly configurable; surfaces as a suggested value. *MTR relevance:* Medium — the recommendation is built on STR-style occupancy/performance signals; for long-stay portfolios treat it as a directional input, not a literal nightly target.
- **Base Price Nudge** — A proactive alert raised when PriceLabs detects your base price has drifted more than ~7% from its current recommendation. Nudges never auto-apply; you accept or reject. *Key settings:* automatic; threshold ~7% (vendor-set). *MTR relevance:* Low-Medium — periodic nudges help stay market-aligned, but mid-term pricing changes are usually deliberate/quarterly rather than nudge-driven.

### Minimum, Maximum & Advanced Min Price

- **Minimum Price (floor)** — The lowest nightly rate PriceLabs will ever recommend; dynamic adjustments and customizations are clamped so prices never fall below it. Strongly recommended as a guardrail because without it, dynamic discounting (last-minute, occupancy, orphan) can push rates unexpectedly low. *Key settings:* single floor value per listing; can vary by season via Custom Seasonal Profiles. *MTR relevance:* High — arguably the most important knob for furnished mid-term units; it protects monthly-equivalent economics and prevents nightly discount logic from undercutting a long-stay rate.
- **Maximum Price (ceiling)** — The highest nightly rate PriceLabs will recommend; caps surge pricing on peak/event dates. Optional but useful to keep rates plausible. *Key settings:* single ceiling value per listing; seasonal via profiles. *MTR relevance:* Medium — peak nightly surges matter less for monthly stays, but a ceiling still prevents far-out/event premiums from quoting unrealistic long-stay rates.
- **Seasonal Min/Base/Max (Custom Seasonal Profiles for prices)** — Set *different* minimum, base, and maximum prices for different seasons/date ranges across the year. *Key settings:* per-season date ranges each with their own min/base/max; percentage or fixed; managed under More Customizations → Seasonal & Minimum Prices (bulk upload/download for many listings). *MTR relevance:* High — seasonal floors/ceilings map well to mid-term demand cycles (e.g., higher floors in peak relocation months); seasonal min-price control is the cleanest way to protect monthly rates by season.
- **Advanced Minimum Price Settings / Minimum Far-Out Price** — A safeguard that prevents prices for dates beyond a set horizon from dropping below a chosen threshold (e.g., "any date > 60 days out must stay ≥ $250"). *Key settings:* horizon in days + a separate (usually higher) far-out minimum; can also lower the far-out minimum if desired. *MTR relevance:* High — stops the engine from discounting distant calendar dates you'd rather hold for a longer/higher long-term booking, protecting future inventory.

### How Recommendations Are Calculated (pipeline & algorithm)

- **Recommendation pipeline (base × factors → bounded by min/max)** — All recommendations are applied as adjustments *to the base price*; e.g., base $66 with +4% demand → $68. Prices fluctuate around the base for season, day-of-week, supply/demand from holidays/events, and lead time (close-in dates get last-minute discounts). The result is then clamped to the min/max and modified by customizations and date-specific overrides. *MTR relevance:* High — understanding that everything is a multiplier on base (then floored) explains why setting base + min correctly is the core lever.
- **Hyper Local Pulse (HLP) market model** — Prices a property against a hyper-local comp set of ~350 similar-sized nearby listings within a max ~15 km radius (Airbnb/Vrbo data), and estimates price sensitivity per comp set and per future date. *Key settings:* not directly user-configurable (nudge via sensitivity factors and customizations). *MTR relevance:* Medium — the comp set is STR-oriented; for furnished mid-term units the nightly comp signal is directionally useful but should be combined with LOS pricing and min-stay rules.
- **Revenue-maximizing / dynamic-programming optimization** — Forecasts occupancy and booking probability per future date, then searches price points to maximize *expected revenue*, using dynamic-programming techniques to handle changing booking opportunities over time. *MTR relevance:* Medium — expected-revenue optimization assumes nightly turnover; for 30–90+ night stays, min-stay floors and LOS discounts do more of the work.

### Market Factors (calendar tooltip)

Hovering a date shows a tooltip explaining the rate: market factors detected (Seasonality, Demand, Pacing), a supply estimate (occupancy in other rentals), any occupancy adjustment, applied customizations, and min/max bounds. Factors group into broad trends (base + seasonality), daily demand trends, and lead-time trends.

- **Seasonality (Seasonality Factor + Sensitivity)** — A "broad trend" raising/lowering prices by time of year; relatively stable across nearby dates. Set from market data by default; a Sensitivity customization dials how strongly seasonal swings affect prices. *Key settings:* sensitivity options (No / Low / Recommended / High style — exact labels unverified, mirror Demand Factor Sensitivity). *MTR relevance:* Medium — seasonal demand exists in mid-term markets (academic terms, relocation cycles) but is smoother than STR; lower sensitivity often suits long-stay portfolios.
- **Demand Factor (+ Sensitivity)** — Captures date-specific demand spikes (holidays, events, day-of-week); shown as "Demand Factor" in the tooltip. Sensitivity controls how much external/hotel (Booking.com) demand signal influences prices. *Key settings:* Recommended (default), Low/Conservative, High/Aggressive, or No Demand Factor; Smart Presets phrase these as Conservative / Recommended / Aggressive (a "Moderately Aggressive" tier referenced, unverified). *MTR relevance:* Low-Medium — short, event-driven nightly spikes rarely benefit a 30–90 night booking; many MTR operators set this Low or off.
- **Pacing Factor** — Compares current booking pace (listed rates + occupancy for future dates) against historical seasonal trends and the market; adjusts where projected demand deviates significantly from norms. A "leading indicator" of filling too fast/slow. *Key settings:* applied automatically in eligible markets; surfaced in Pacing Reports. *MTR relevance:* Low-Medium — tuned to nightly booking curves; for sparse long-stay calendars the signal is noisier.
- **Adjacent Factor** — Adjusts prices for days immediately before/after an existing booking to encourage or discourage back-to-back reservations and manage gaps. *Key settings:* Fixed or Percent; discount or premium; days before/after (1–30); optional "Also apply on weekends" (off by default). Stacking: multiple discounts → largest used; multiple premiums → all stacked; mix → largest discount + premium. *MTR relevance:* Low — back-to-back-night turnover management is an STR concern.

### Lead-Time Adjustments (last-minute & far-out)

- **Last-Minute Prices / Discounts** — Adjusts rates for arrivals within a near horizon (covers reservations within ~29 days of arrival). Default applies a ~30% discount spread *gradually* over ~15 days; replaceable with flat or tiered rules, fixed rates, or opt-out. *Key settings:* percentage or fixed; multiple tiered day-bands; gradual vs. flat; disable the default. *MTR relevance:* Low — the canonical feature that mostly does NOT apply to mid-term; you generally don't slash a 30–90 night rate just because arrival is near.
- **Far-Out Prices** — Controls pricing for dates far in the future: raise or lower the min for far-out dates, or *gradually increase* prices up to your booking horizon (an advanced, market-driven customization). Pairs with the Minimum Far-Out Price safeguard. *Key settings:* far-out horizon (days); higher/lower far-out min; optional gradual ramp. *MTR relevance:* High — holding firmer (or rising) prices on distant dates is valuable for long-stay inventory you don't want to discount early.

### Day-of-Week / Weekend

- **Day of Week Pricing Adjustments** — Fine-tunes prices by weekday on top of recommendations. *Key settings:* per-day percentage, range −75% to +500%. *MTR relevance:* Low — weekday/weekend differences are largely irrelevant when a booking spans many weeks.
- **Define Your Own Weekend** — Redefine which days count as "weekend" for markets where the local weekend differs (e.g., Fri–Sat). *Key settings:* selectable weekend day(s). *MTR relevance:* Low — rarely affects monthly-stay pricing. *(Note: TLV's Fri–Sat weekend would matter for STR, not MTR.)*

### Occupancy-Based Adjustments

- **Occupancy Based Adjustments (OBA)** — Automatically raises/lowers a listing's prices based on its own occupancy/booked level for a period — cheaper when empty, dearer as it fills. *Key settings:* occupancy-band → price adjustment rules. *MTR relevance:* Low-Medium — a single long booking swings a unit 0%→~100% instantly, so per-listing bands behave coarsely for MTR.
- **Portfolio / Multi-Room Occupancy Based Adjustments** — Adjusts a listing's price based on occupancy across a defined portfolio or room-type group, to balance sell-through across inventory. *Key settings:* group/room-type definition + occupancy-band adjustments at portfolio level. *MTR relevance:* Medium — more useful than single-unit occupancy for an operator managing a building of similar furnished units.

### Seasonal Profiles & Pricing Profiles

- **Custom Seasonal Profiles** — Define seasons (date ranges) and assign each its own config, including different min/base/max and a chosen Pricing Profile of customizations. Supports bulk download/edit/upload. *Key settings:* season date ranges; per-season min/base/max; per-season assigned Pricing Profile; account-level seasonal customizations supersede listing-level. *MTR relevance:* High — the primary tool to encode mid-term seasonality with distinct floors and LOS strategies per season.
- **Pricing Profiles (Seasonal Pricing Customizations)** — A reusable, named bundle of the (~11) pricing customizations attachable to seasons within a seasonal profile. *Key settings:* select/configure customizations; assign profile → season. *MTR relevance:* Medium-High — lets you run, say, a "long-stay peak" profile (higher floors, deeper monthly discount, longer min-stay) vs. an off-peak profile.

### Date-Specific Overrides, Fixed Prices & Hierarchy

- **Date-Specific Overrides** — Make exceptions for specific dates without changing the whole calendar; override the recommended price and/or min-night by click-drag or "+". *Key settings:* per-date fixed price OR % override (and/or min-nights); listing- or account/group-level. *MTR relevance:* Medium — handy for known events, blackout periods, or holding dates for a pending long-term deal.
- **Fixed Price Override** — A hard-set price for a date: when applied, *no other customization* is layered on — it's the final price. *Key settings:* fixed value (account/group "% of base price" overrides count as "fixed"). *MTR relevance:* Medium — useful to lock a negotiated monthly-equivalent nightly rate on specific dates.
- **Customization & Override Hierarchy** — Which rule wins when several apply. For fixed overrides: date-specific > last-minute > orphan-day. For min-nights: date-specific > far-out > last-minute > default. Listing-level overrides account/group level, but any seasonal-profile customization supersedes listing-level customization. *MTR relevance:* Medium — important so a seasonal long-stay strategy isn't silently overridden and locked rates take precedence as intended.
- **Blocked-Date Handling** — For most integrations, blocked dates count as "booked" in occupancy; too many blocks make the market comparison unreliable and recommendations pause until blocks clear. *MTR relevance:* Medium — MTR calendars often have long blocked stretches; expect occupancy-based logic to behave conservatively or pause.

### Length-of-Stay, Weekly/Monthly Discounts & Other Customizations

- **Length of Stay (LOS) Pricing Adjustments** — Applies a percentage change to the final recommended price based on booked stay length — not just standard weekly/monthly tiers. *Key settings:* per-LOS-band percentage, range −75% to +500%, applied last; listing-level. *MTR relevance:* High — a core MTR lever: price 30/60/90-night stays distinctly; the mechanism that turns nightly recommendations into competitive long-stay rates.
- **Weekly & Monthly Discounts** — Dedicated discount fields for 7-night and ~28/30-night bookings that integrate with automated pricing (e.g., 10% weekly, 20% monthly). Availability limited to listings syncing with select PMSs/channels (incl. Airbnb). *Key settings:* weekly % and monthly % discount; depends on PMS/channel support; can be set at group level. *MTR relevance:* High — the monthly discount is central to mid-term economics; note the constraint that it's only exposed for certain integrations, so the LOS adjustment is the fallback elsewhere. *(Exact stacking order vs. last-minute discounts unverified.)*
- **Monthly-Discount guidance** — Explicit PriceLabs guidance on sizing monthly discounts relative to nightly base and target monthly rate. *Key settings:* conceptual (derive discount so nightly base × nights × (1−discount) ≈ target monthly rate) — exact formula unverified. *MTR relevance:* High — directly aimed at the MTR problem of reconciling a nightly base with a monthly target.
- **Orphan Day / Gap pricing** — Discounts (or prices) short 1–2 night gaps between bookings; default 20% on gaps of ≤2 nights, and if an orphan is also last-minute, the larger discount applies. *Key settings:* up to 5 ascending gap-length ranges, each Fixed or % discount. *MTR relevance:* Low — 1–2 night orphan gaps are an STR turnover artifact.
- **Default Discounts and Premiums (account/group level)** — Apply standard discounts/premiums uniformly across all listings under a PMS/channel or a group. *Key settings:* account- vs. group-level scope; offset/premium/discount percentages; group membership. *MTR relevance:* Medium — efficient way to push a consistent monthly-discount or floor policy across similar units.
- **Pricing Offsets (mapped listings)** — Account-level adjustment nudging all (or mapped) listings' prices up/down by a set amount/percentage. *Key settings:* offset value, scope. *MTR relevance:* Medium — portfolio-wide trims/uplifts for standardizing a building's pricing posture.
- **Rounding (Advanced tab)** — Rounds final recommended prices to end with a chosen digit (e.g. $99 / $109 / $299) for charm/psychological pricing, applied after all other adjustments. *Key settings:* target price ending; under Customizations → Advanced. *MTR relevance:* Low-Medium — cosmetic polish on the quoted nightly rate. *(We already round to the nearest ₪5 via `roundingStep` in `config/pricing.ts`; charm endings would be a small variant.)*
- **Smoothing (Advanced tab)** — Averages nightly rates across a stay window so guests see one uniform nightly price instead of date-by-date variation (e.g. $123 Fri + $107 Sat → $115 for both nights). *Key settings:* toggle; under Customizations → Advanced. *MTR relevance:* Low — a 30–90 night quote already collapses to a single effective rate, so per-night display variance barely shows.
- **Neighborhood Profile Data Source** — Choose which comp-data profile drives a listing's recommendations (the default "Nearby Listings" pool vs. an alternative market/custom profile). *Key settings:* per-listing data-source selector. *MTR relevance:* Medium — steering the comp pool toward furnished/long-stay supply is one of the few levers to de-STR the market signal.

### Sources (Part 1)

- [How to set up your base price?](https://help.pricelabs.co/portal/en/kb/articles/setting-base-price)
- [What are minimum, base, and maximum prices — how to set them up](https://help.pricelabs.co/portal/en/kb/articles/what-are-minimum-base-and-maximum-prices-how-to-set-them-up)
- [How Are the Price Recommendations Calculated?](https://help.pricelabs.co/portal/en/kb/articles/how-is-pricing-calculated)
- [Understanding the Dynamic Pricing Calendar](https://help.pricelabs.co/portal/en/kb/articles/pricing-calendar)
- [Different Prices on Your Calendar - Tooltip Explained](https://help.pricelabs.co/portal/en/kb/articles/different-prices-on-your-calendar-explained)
- [Demand Factor Sensitivity](https://help.pricelabs.co/portal/en/kb/articles/demand-factor-sensitivity)
- [Seasonality Factor Sensitivity](https://help.pricelabs.co/portal/en/kb/articles/seasonality)
- [Pacing Factor](https://help.pricelabs.co/portal/en/kb/articles/pacing-factor)
- [Adjacent Factor](https://help.pricelabs.co/portal/en/kb/articles/adj)
- [Last Minute Prices](https://help.pricelabs.co/portal/en/kb/articles/last-minute-prices)
- [Far-out Prices](https://help.pricelabs.co/portal/en/kb/articles/far-out-prices)
- [Advanced Minimum Price Settings](https://help.pricelabs.co/portal/en/kb/articles/advanced-minimum-price-settings)
- [Seasonal Pricing Settings (Seasonal Minimum, Base and Max)](https://help.pricelabs.co/portal/en/kb/articles/seasonal-minimum-base-and-max-price-settings)
- [Seasonal Pricing Customizations (aka Pricing Profiles)](https://help.pricelabs.co/portal/en/kb/articles/pricing-customizations-profiles)
- [How to Get Seasonal Prices Right in PriceLabs?](https://help.pricelabs.co/portal/en/kb/articles/how-to-get-seasonal-prices-right-in-pricelabs)
- [Setting pricing customizations in PriceLabs](https://help.pricelabs.co/portal/en/kb/articles/pricing-customizations)
- [List of all PriceLabs Customizations](https://help.pricelabs.co/portal/en/kb/articles/list-of-all-pricelabs-customizations)
- [Customizations — KB category index](https://help.pricelabs.co/portal/en/kb/pricelabs/dynamic-pricing/customizations)
- [Rounding and Smoothing](https://help.pricelabs.co/portal/en/kb/articles/rounding-and-smoothing)
- [Occupancy Based Adjustments](https://help.pricelabs.co/portal/en/kb/articles/occupancy-based-adjustments)
- [Portfolio Occupancy Based Adjustments](https://help.pricelabs.co/portal/en/kb/articles/portfolio-occupancy-based-adjustments)
- [Date-Specific Overrides](https://help.pricelabs.co/portal/en/kb/articles/date-specific-overrides)
- [Understanding Customization and Date-Specific Override Hierarchy](https://help.pricelabs.co/portal/en/kb/articles/customization-hierarchy)
- [Managing Multiple Listings with Account and Group-Level Customization](https://help.pricelabs.co/portal/en/kb/articles/account-group-customization)
- [Default Discounts and Premiums](https://help.pricelabs.co/portal/en/kb/articles/default-discounts-and-premiums)
- [Length of Stay Pricing Adjustments](https://help.pricelabs.co/portal/en/kb/articles/length-of-stay-pricing)
- [Weekly and Monthly discount](https://help.pricelabs.co/portal/en/kb/articles/weekly-monthly-discount)
- [How to think about and come up with monthly discounts?](https://help.pricelabs.co/portal/en/kb/articles/how-to-think-about-and-come-up-with-monthly-discounts)
- [Using PriceLabs for Midterm Rentals](https://help.pricelabs.co/portal/en/kb/articles/using-pricelabs-for-mid-term-rentals)
- [Overview of PriceLabs' Dynamic Pricing Algorithm (Part 1)](https://hello.pricelabs.co/blog/overview-of-pricelabs-dynamic-pricing-algorithm-part-1/)
- [Overview of PriceLabs' Dynamic Pricing Algorithm (Part 2)](https://hello.pricelabs.co/blog/overview-of-pricelabs-dynamic-pricing-algorithm-part-2/)

---

## Part 2 — Stay-Length Controls & Market Data

MTR relevance is assessed against a mid-term portfolio of 30–90+ night furnished apartments,
where monthly/LOS pricing and minimum-stay floors dominate.

### Minimum-Stay Engine

- **Minimum Stay Recommendation Engine ("Dynamic Min Stay")** — A data-driven engine (marketed as the industry's first) that recommends and applies minimum-night rules per date, flexing them by seasonality, market trends, listing performance, and a risk-factor model. Recalculated daily and synced. Balances "guaranteed revenue now" vs. "opportunity cost" (a booking reducing bookability of neighboring dates) plus turnover operational cost. *Key settings:* toggle on/off; works alongside default/last-minute/orphan/far-out rules; auto-fills unbooked orphan nights. *MTR relevance:* Medium — tuned to STR turnover economics and typically recommends short floors (case study moved avg stay 3.1→4.3 nights), so an MTR operator overrides it with high fixed floors more than relying on auto-recommendations; its orphan-filling can help at the margins.
- **Default Minimum Stay (default min nights)** — Baseline minimum applied to all dates not covered by a more specific rule, configurable separately for weekdays and weekends. *Key settings:* separate weekday vs. weekend values. *MTR relevance:* High — the primary lever to enforce a portfolio-wide floor (e.g., 28/30 nights) that defines a property as mid-term.
- **Lowest Minimum Stay Allowed** — A hard floor overriding every other minimum-stay restriction, ensuring no booking shorter than this threshold is ever accepted regardless of last-minute, far-out, orphan, or date-specific rules. *Key settings:* single absolute-minimum value. *MTR relevance:* High — the single most important min-stay control; set to e.g. 30 nights, it guarantees no automation drops below the mid-term threshold.
- **Last-Minute Minimum Stay Adjustments** — Automatically reduces the minimum stay as check-in approaches. *Key settings:* up to 3 last-minute rules, each with a lead-time window and reduced minimum. *MTR relevance:* Low-Medium — mostly an STR conversion tactic; conflicts with strict 30+ night floors (and is overridden by Lowest Minimum Stay Allowed).
- **Minimum Stay for Far-Out Bookings** — Set a (typically higher) minimum length for bookings far in advance. *Key settings:* minimum nights; "far-out" horizon (days ahead). *MTR relevance:* Medium — require longer commitments for advance bookings, reinforcing longer stays on the far horizon.
- **Day-of-Week Minimum Stay Restrictions** — Adjusts minimum stays by check-in day of week. *Key settings:* per-weekday minimum values. *MTR relevance:* Low — day-of-week tuning is largely irrelevant to 30–90+ night stays.
- **Adjacent-Day Minimum Stay (before/after an unavailable night)** — Sets a different minimum stay for dates immediately before or after existing unavailable/booked nights, with separate rules for the before- and after- side. *Key settings:* min-stay value per side. *MTR relevance:* Low — gap-shaping around bookings is mostly an STR tool (and Lowest Min Stay Allowed still floors it), though it can tidy month-boundary gaps.
- **Minimum Stay on Arrival (MLOS) vs. Minimum Stay Through** — Two restriction types: on Arrival applies only to reservations that *start* on a date; Through applies to any booking that *spans* that date. *MTR relevance:* Medium — matters when blocking short bookings around fixed dates, but more impactful for STR gap management.
- **Hierarchy of Minimum-Stay Restrictions** — Which rule wins. "Lowest Minimum Stay Allowed" is the ultimate override; an orphan/gap rule outranks a last-minute rule when both apply; for scope, listing-level beats group-level beats account-level; date-specific overrides take precedence over most customizations. *MTR relevance:* High — knowing listing-level beats group/account and that Lowest Min Stay Allowed is the master floor is essential to guarantee MTR minimums are never undercut.

### Gap / Orphan Handling

- **Orphan Gap (gap-day) Minimum Stay** — Detects unbooked "orphan" gaps between two reservations and adjusts the minimum stay so new bookings won't leave un-fillable scraps, while discounting gap nights to fill them. *Key settings:* gap-size threshold (e.g., ≤2 nights); discount on qualifying gaps — default 20% on gaps of ≤2 nights. *MTR relevance:* Low — orphan gaps between 30–90 night bookings are rare and usually too long to be STR-style "orphan nights."
- **Orphan vs. Last-Minute conflict resolution** — When a date is both orphan and last-minute, the orphan rule wins min-stay; for discounts, the larger of the two applies. *MTR relevance:* Low — edge-case logic with little bearing on long stays.

### Length-of-Stay & Discounts

- **Length-of-Stay (LOS) Pricing Adjustments** — A percentage premium/discount on the final recommended nightly price based on nights booked, layered last. *Key settings:* stay-length tiers + % per tier (e.g., 10% off 7+, 15% off 14+) via Customizations → General → "Edit Adjustments"; PMS/OTA support varies. *MTR relevance:* High — central to MTR; encode 30/60/90-night pricing curves (MTR operators often want tiers well beyond 14 nights; PMS support gates it).
- **Weekly and Monthly Discounts** — Percentage discounts for weekly/monthly thresholds, set at listing level. *Key settings:* weekly % and monthly %, per listing; applied relative to the dynamic nightly rate. *MTR relevance:* High — the monthly discount is arguably the most-used MTR lever; for 30–90+ stays it effectively sets the realized rate. *(Exact stacking vs. last-minute discounts unverified.)*
- **Extra Person Fee** — Per-extra-guest charge above a guest-count threshold, sent to the channel. *Key settings:* Fixed (per extra guest) or Percent; guest-count threshold; toggled in Customizations → All Customizations → Extra Person Fee. *MTR relevance:* Medium — relevant where furnished units price by headcount, but many MTR leases are flat monthly regardless of occupancy.
- **Check-in / Check-out Day Restrictions** — Designate permitted check-in/out days (e.g., restrict turnovers to Fri/Sat/Sun). *Key settings:* allowed check-in days, allowed check-out days; PMS/OTA support varies. *MTR relevance:* Low — with monthly turnovers, constraining weekday check-in/out is rarely necessary.
- **Date-Specific Overrides (stay rules)** — Manual per-date overrides for min-stay (and price) for events/seasons. *Key settings:* per-date min-stay and/or price. *MTR relevance:* Medium — useful for peak windows, but the standing floor matters more.

### Market Data & Dashboards

- **Market Dashboards** — Pre-built market-intelligence reports covering supply, demand, pricing, and bookings across Airbnb and Vrbo, daily-updated; 200+ STR markets, 1 free dashboard for new accounts. Cover 1k/5k/10k listings within 0.1–50 km, ~2 years history + projections up to one year out. *Key settings:* radius/listing-count; 40+ comp filters; custom map-drawn areas. *MTR relevance:* Medium — valuable benchmarking, but underlying data is STR-centric; MTR-specific demand isn't isolated, so insights are directional.
- **Comp Sets (comparable-listings selection)** — Build custom competitive sets via 40+ filters (bedrooms, amenities, price, location) or by drawing an area on the map. *Key settings:* 40+ filters; listing count; map-based custom area. *MTR relevance:* Medium — useful, but filters are STR-oriented and don't natively segment by min-stay/MTR positioning *(unverified whether min-stay is a comp filter)*.
- **Price & Occupancy Trends (Future Prices + percentiles)** — Charts of future market occupancy and a Future Prices band at 25th/50th/75th percentile rates, with an optional Median Booked Price line (off by default). *Key settings:* date-range sliders; toggle median booked price; look-back window. *MTR relevance:* Medium — helps gauge pricing, but percentile/booked-rate estimates reflect nightly STR rates.
- **Future Occupancy, Bookings & Cancellations (pacing/forecast view)** — Multi-line graph of future occupancy, pickup, and cancellations, with last-year-final and last-year-as-of-today comparison lines, to reveal soft vs. busy future dates. *MTR relevance:* Medium — directionally useful for spotting soft far-out periods to fill with longer stays.
- **Length of Stay vs. Booking Window** — Paired charts breaking occupied nights down by booking lead-time and by LOS category over the past 365 days vs. prior period (median LOS to handle long stays). *MTR relevance:* High — one of the more directly MTR-relevant market views; quantifies demand in longer LOS buckets and longer booking windows, informing whether a market supports 30–90 night positioning.
- **Neighborhood Data (Listing Market Data)** — Listing-level benchmarking vs. ~350+ similar nearby listings (default "Nearby Listings"). *Key settings:* "Nearby Listings" vs. alternative comp; feeds pricing context. *MTR relevance:* Medium — good local context, but the pool is STR supply, not MTR-segmented.
- **Hyperlocal Pulse (HLP)** — PriceLabs' core hyperlocal algorithm adjusting rates using real-time, forward-looking demand signals at the neighborhood level (~350 similar listings within ~15 km). Four-way event detection (prior-year pacing, early demand, competitor pricing, hotel price indications); auto-adjusts last-minute discounts and far-out premiums; reported ~26% RevPAR lift in 3 months for new users. *Key settings:* largely automatic; influenced by base/min/max + customizations. *MTR relevance:* Low-Medium — real-time, last-minute-oriented signals are optimized for nightly STR demand.
- **Booking Pace / Pickup & Pacing Factor** — "Pacing" measures a future date's current occupancy vs. historical reference at the same booking window; pickup tracks how quickly nights book. Feeds dashboards and the pricing forecast. *MTR relevance:* Low — pace/pickup is meaningful for high-velocity nightly bookings; long bookings arrive infrequently, making pace noisy.
- **Occupancy-Based Adjustments (OBA) & Booking Recency** — Adjust nightly rates based on the listing's own occupancy and how recently bookings came in; auto-discount slower dates. *Key settings:* user-configurable OBA rules; works with the pacing factor. *MTR relevance:* Low — occupancy-velocity nightly discounting is an STR mechanic largely orthogonal to MTR.
- **Portfolio Analytics (KPIs & pacing)** — Tracks owned-portfolio KPIs (revenue, occupancy, ADR, RevPAR, booking pickup, LOS patterns) across listings/groups/portfolio, with historic reports and goal-pacing against monthly targets. *MTR relevance:* Medium — KPI tracking is useful for any portfolio; LOS distributions are the most MTR-relevant slice.
- **Free Market-Data Tools (World STR Index / Explore Market Data)** — No-login public tools tracking worldwide STR performance (active listings, occupancy, RevPAR, ADR) from 2021, refreshed monthly; search any region for metrics and trends. *MTR relevance:* Low — high-level STR-aggregate macro data; useful for scouting, not unit-level MTR pricing.

### Sources (Part 2)

- [PriceLabs' Minimum Stay Recommendation Engine Algorithm (blog)](https://hello.pricelabs.co/blog/minimum-stay-recommendation-engine/)
- [How the Min Stay Recommendation Engine Works (help)](https://help.pricelabs.co/portal/en/kb/articles/introducing-data-driven-dynamic-minimum-night-recommendations)
- [Setting Dynamic Minimum Stay Restrictions in PriceLabs (help)](https://help.pricelabs.co/portal/en/kb/articles/understanding-min-nights)
- [Hierarchy of Minimum Stay Restrictions (help)](https://help.pricelabs.co/portal/en/kb/articles/hierarchy-of-minimum-stay-restrictions)
- [Customization and Date-Specific Override Hierarchy](https://hello.pricelabs.co/customization-hierarchy/)
- [How to Set Minimum Stay Restrictions That Align With Your Market](https://hello.pricelabs.co/minimum-stay-restrictions/)
- [Minimum Stay on Arrival vs. Minimum Stay Through (help)](https://help.pricelabs.co/portal/en/kb/articles/minimum-stay-on-arrival-vs-minimum-stay-through)
- [Check-in & Check-out feature (help)](https://help.pricelabs.co/portal/en/kb/articles/checkin-checkout-feature)
- [What are Orphan Gaps, and How to Use PriceLabs to Leverage Them?](https://hello.pricelabs.co/how-to-use-orphan-gaps-for-increasing-revenue/)
- [Length of Stay Pricing Adjustments (help)](https://help.pricelabs.co/portal/en/kb/articles/length-of-stay-pricing)
- [Weekly and Monthly discount (help)](https://help.pricelabs.co/portal/en/kb/articles/weekly-monthly-discount)
- [How to think about and come up with monthly discounts (help)](https://help.pricelabs.co/portal/en/kb/articles/how-to-think-about-and-come-up-with-monthly-discounts)
- [Extra Person Fee (help)](https://help.pricelabs.co/portal/en/kb/articles/extra-person-fee)
- [Date-specific Overrides (help)](https://help.pricelabs.co/portal/en/kb/articles/date-specific-overrides)
- [Market Dashboards (product page)](https://hello.pricelabs.co/market-dashboards/)
- [Understanding the Market Dashboards (help)](https://help.pricelabs.co/portal/en/kb/articles/market-intel-dashboard)
- [Market Dashboards - Price and Occupancy Trends (help)](https://help.pricelabs.co/portal/en/kb/articles/price-occupancy-trends)
- [Market Dashboards - Listing Map and Comp Sets (help)](https://help.pricelabs.co/portal/en/kb/articles/listing-map-compsets)
- [Market Dashboards - Length of Stay versus Booking Window (help)](https://help.pricelabs.co/portal/en/kb/articles/los-booking-window)
- [Listing Neighborhood Data (help)](https://help.pricelabs.co/portal/en/kb/articles/listing-market-data)
- [About Hyper Local Pulse (New Algorithm) and FAQ (help)](https://help.pricelabs.co/portal/en/kb/articles/about-hyper-local-pulse-new-algorithm-and-faq)
- [Pacing Factor (help)](https://help.pricelabs.co/portal/en/kb/articles/pacing-factor)
- [Occupancy Based Adjustments (help)](https://help.pricelabs.co/portal/en/kb/articles/occupancy-based-adjustments)
- [Portfolio Analytics (product page)](https://hello.pricelabs.co/portfolio-analytics/)
- [World STR Index — Free Vacation Rental Market Data](https://hello.pricelabs.co/str-index/)
- [Dynamic Min Stay by PriceLabs (Rental Scale-Up)](https://www.rentalscaleup.com/pricelabs-dynamic-min-stay-feature/)

---

## Part 3 — Portfolio Ops, Analytics, Integrations & Verticals

### Account Setup & Onboarding

- **Account creation & listing import** — Connect/import listings from OTAs (Airbnb, Vrbo, Booking.com) or via a PMS/channel manager; PriceLabs retrieves listing + historical booking data but changes no prices until you turn on sync. *Key settings:* connect by OTA login/OAuth or PMS token; import read-only until "Sync Prices" enabled. *MTR relevance:* High — import-without-sync lets an autonomous-agent dashboard validate recommendations before any rate goes live.
- **Base price setup** — The base price is the single average annual nightly rate; set via Pricing Dashboard → Review Prices → "Help me choose a base price" ("Market-Driven" recommended). *MTR relevance:* High — for MTR, take target monthly price ÷ ~30 to derive nightly base.
- **Free training & onboarding sessions** — Free live training/onboarding webinars + knowledge base. *MTR relevance:* Low — useful for humans, less so for automation.

### Multi-Listing / Portfolio Management

- **Customization Groups (Group-Level customization)** — Group listings (by city, bedroom count, type) so the same customizations and overrides apply to all members. *Key settings:* create group from Customization page; assign via Manage Listings; sub-groups supported. *MTR relevance:* High — segment a furnished portfolio and push consistent MTR rules in bulk.
- **Account-level customization** — Set portfolio-wide rules that cascade Account → Group → Listing (more specific overrides less specific). *MTR relevance:* High — a single account-level baseline (e.g., 30-night minimum, monthly discount) with exceptions below.
- **Bulk edit / Edit Customization** — From Account/Groups/Listings tabs, tick items and "Edit Customization" to apply changes across many listings at once. *MTR relevance:* High — core operation for an autonomous dashboard managing many units.
- **Manage Listings page** — Central surface to view listings, toggle sync, run manual sync, assign groups, and hide inactive listings; filters by PMS, Group, Listing, Sync status, Availability. *Key settings:* filters; "Hide Listing" removes a unit from dashboard/multi-calendar/reports. *MTR relevance:* High — filtering by sync/availability surfaces only units needing attention.
- **Copy settings to child/mapped listings** — When editing a parent listing, copy its settings down to mapped children. *MTR relevance:* Medium — for a unit distributed across channels.
- **Sync on/off toggle** — Enable/disable sync per listing or in bulk (Manage Listings or Multi-Calendar). *Key settings:* off = recommendations only; on = prices pushed. *MTR relevance:* High — keep some units advisory, others fully automated.
- **Seasonal Profiles / Pricing Profiles** — Reusable bundle of pricing customizations (~11); Seasonal Profiles automate base-price and min-stay changes across the year; download/edit offline/re-upload for large portfolios. *MTR relevance:* Medium — encode season-dependent monthly rates and min-stay floors.

### Sync & Automation (Price Push to Channels)

- **Daily automatic overnight sync** — Recalculates prices and min-stays daily and syncs overnight to the connected channel/PMS for any sync-enabled listing. *MTR relevance:* High — keeps long-stay rates current (MTR moves slower than nightly STR).
- **Timed Sync (scheduled sync)** — Schedule the daily sync at a specific local-timezone time. *MTR relevance:* Medium — align price pushes to an operational window.
- **Sync Now (manual sync)** — Push prices instantly on demand from Review Prices / Multi-Calendar. *MTR relevance:* High — force an immediate push after changing customizations.
- **Additional daily syncs (paid)** — Sync more than once per 24h for ~$1/listing/month per extra sync. *MTR relevance:* Low — long-stay rarely needs intraday repricing.
- **Real-Time Sync (event-driven, paid)** — PMS webhooks recalculate and push immediately on triggers (new reservation, cancellation, date/duration change, blocks); up to 24 updates/day, min 60-min interval between revenue triggers. *MTR relevance:* Medium — instant repricing after a long booking/cancellation protects the remaining calendar.
- **Sync verification & error handling** — Error emails on sync failure; listings must be live/bookable and have an initial PMS rate before PriceLabs can push. *Key settings:* "check if synced" tooling; common causes = inactive listing, missing PMS rates, expired token. *MTR relevance:* High — an agent must detect and remediate failed pushes to avoid stale pricing.

### Analytics & Reporting

- **Portfolio Analytics (KPIs & Historic Reports)** — Free suite analyzing listing/group/portfolio performance: revenue, occupancy, ADR, RevPAR, booking pickup, LOS patterns; verifies whether settings are working. *MTR relevance:* High — exactly the KPI surface an MTR agent dashboard would consume.
- **Report Builder + "Ask AI"** — Build custom reports and query them in plain English ("Which listings saw the biggest RevPAR drop?"); AI summarizes/detects patterns; scheduled refresh. *MTR relevance:* High — natural-language reporting + scheduled exports map to an autonomous dashboard.
- **Multi-Calendar** — Consolidated calendar across listings: recommended prices per night, set customizations/overrides, toggle sync, run manual sync, add forward-occupancy metrics + market-demand color-coding. *Key settings:* "Add Metrics" (15/30/60-day forward occupancy). *MTR relevance:* Medium — most useful for visual nightly management; forward occupancy still informs availability planning.
- **Performance Metrics on Review Prices dashboard** — Per-listing performance indicators to guide pricing. *MTR relevance:* Medium — context for tuning base/min prices.
- **Enterprise portfolio metrics (40+ metrics)** — Identify listings needing attention using 40+ customizable metrics (Occupancy, Last Booked Date, etc.) with easy data downloads. *MTR relevance:* High — "Last Booked Date" + occupancy filters triage stale long-stay units across a big book.
- **Owner Analytics (AI-summarized owner reports)** — AI turns operational data into branded performance reports to explain pricing and build owner loyalty. *MTR relevance:* Medium — relevant if the operation reports to owners/investors.

### Market Intelligence & Revenue Estimation

- **Market Dashboards (Market Intel, paid)** — Personalized dashboards tracking ~8 KPIs (est. revenue, RevPAR, est. occupancy %, ADR, active listings, bookings, booking window, LOS); future occupancy/pickup curves vs. last year. *Key settings:* priced by comp count (~$9.99/1k, $19.99/5k, $39.99/10k). *MTR relevance:* Medium — booking-pace + LOS trends inform MTR demand, though comp data skews short-stay.
- **Neighborhood Data / Comp Sets** — Per-listing neighborhood data (future/past occupancy vs. market, percentile rates, recommended-price bands) with saveable custom comp sets. *MTR relevance:* Medium — comp benchmarking is weaker for furnished long-stay niches but still anchors base price.
- **Revenue Estimator Pro (paid)** — Enter any address worldwide for monthly/annual revenue, ADR, occupancy projections vs. a customizable comp set; for acquisitions/forecasting. *Key settings:* ~$10/month; customizable comparables. *MTR relevance:* Medium — STR-oriented projections, useful for underwriting new furnished units. *(Maps to our Growth dept "Underwriter Agent.")*
- **Forecasting & goal-setting tools** — Newer (2026 Revenue Accelerator) tools to set revenue goals and spot revenue gaps early. *MTR relevance:* Medium — goal/gap tracking aligns with portfolio revenue management.

### Integrations (PMS / Channel Managers / OTAs)

- **160+ PMS & channel manager integrations** — Connects to 160+ PMSs and channel managers (reported 161); recalculated rates/min-stays then sync across the channels that PMS distributes to. *Key settings:* searchable directory; some support Real-Time Sync. *MTR relevance:* High — MTR portfolios typically run through a PMS (Guesty, Hostaway, OwnerRez), so broad coverage matters.
- **Direct Airbnb integration** — Push prices/min-stays directly to Airbnb without a PMS. *MTR relevance:* Medium — Airbnb supports monthly stays, but most MTR demand is off-Airbnb.
- **Direct Vrbo integration** — Direct price/min-stay push. *MTR relevance:* Low — Vrbo skews vacation/short-stay.
- **Direct Booking.com integration (Connectivity Partner)** — Certified direct integration pushing prices + min-stay (but NOT availability — availability still needs iCal). *MTR relevance:* Medium — Booking.com is strong in Europe and supports longer stays; the availability caveat matters.
- **Listing mapping across channels (parent/child)** — Map the same property across channels/PMSs as parent + child to maintain rate parity and avoid double billing. *Key settings:* children inherit neighborhood data, same bedroom count; child from a different PMS billed $1/month; Pricing Offset handles differing OTA commissions. *MTR relevance:* Medium — keeps a unit's rates consistent across its distribution.
- **Direct booking website pricing** — Via the Customer API, recommended rates can populate a direct booking site (WordPress/Wix guides) for commission-free bookings. *MTR relevance:* High — direct-booking sites are central to MTR (corporate/relocation guests).

### API (Developer / Partner)

- **Customer API** — REST API to read recommended prices and edit settings for actively-syncing listings; base URL `https://api.pricelabs.co/v1/listings`, auth via `X-API-Key`. *Key settings:* key under Account Settings → API Details; only works for actively-syncing listings; rate limits not public *(unverified)*. *MTR relevance:* High — the primary programmatic surface an autonomous-agent dashboard would use.
- **Customer API endpoints** — GET all listings, GET listing, POST update listings, GET/POST/DELETE date-level overrides, POST prices, POST add new listings, POST push listings, GET neighborhood data. Postman collection published. *MTR relevance:* High — date-level override POST/DELETE + push endpoints let an agent set monthly rates, block ranges, and force syncs.
- **Customer API use cases** — (1) populate direct booking sites with live rates, (2) import rate updates into BI/databases for custom analytics, (3) automate settings (rule-based base-price updates, special-event pricing). *MTR relevance:* High — matches an agent loop of "read recommendation → apply business rules → write back override."
- **Integration/Partner API (iAPI) for PMSs** — Separate API for PMSs (or custom/in-house PMS) to integrate into PriceLabs. *MTR relevance:* Medium — relevant only if running a proprietary PMS.
- **Revenue Estimator API & Widget** — API/embeddable widget exposing revenue-estimate data. *MTR relevance:* Low — acquisition/marketing tool.
- **Open API** — Publicly announced initiative broadening programmatic access. *MTR relevance:* Medium — signals expanding automation surface. *(Details unverified beyond announcement.)*

> **Note for us:** spec.md §6 lists real integrations (Blueground / Airbnb / Yad2) as a non-goal
> for the current milestone, so the Customer API is reference-only for now — but its read-rates /
> write-overrides shape is a clean blueprint for how our Pricing Specialist could eventually talk
> to a real engine.

### Automation Rules, Triggers, Alerts & Notifications

- **Occupancy-based adjustments (triggers)** — Raise/lower rates based on how booked a date/window is. *Key settings:* occupancy thresholds → discount/premium per band. *MTR relevance:* Medium — slower cadence for long stays; useful to discount soft far-out months.
- **Last-minute discounts** — Rate reductions as unbooked dates approach. *MTR relevance:* Low — last-minute windows matter little for 30–90 night bookings.
- **Far-out / lead-time pricing** — Adjust pricing for distant dates by lead time. *MTR relevance:* Medium — MTR guests often book months ahead.
- **Event-based / demand triggers** — Detect local demand spikes and auto-adjust rates; can raise min-stay during premium periods. *MTR relevance:* Low — short event spikes rarely move 30+ night pricing.
- **Dynamic minimum-stay restrictions** — Auto set/flex min-night requirements via a defined hierarchy + Min Stay Recommendation Engine. *MTR relevance:* High — enforcing a 30/60/90-night minimum is foundational.
- **Safety Minimum Price (price floor)** — An automated floor preventing recommendations from dropping below a margin-protecting threshold. *MTR relevance:* High — guarantees long-stay nightly equivalents never fall below a sustainable monthly margin.
- **Notification center & base-price alerts** — In-app notifications advising when to adjust base price and limits. *MTR relevance:* Medium — an agent can consume these to re-tune monthly base prices.
- **Group-Level Preview Prices** — Simulate pricing rules at the group level and preview impact before pushing live. *MTR relevance:* High — validate a portfolio-wide MTR rule change before it goes live.

### AI Features

- **AI-assisted Market-Driven Base Price Helper** — Suggests a base price from a listing's profile, amenities, reviews, and quality vs. local competitors. *MTR relevance:* High — automates deriving the right base/monthly-equivalent price per unit.
- **Ask AI in Report Builder** — Plain-English querying of report data with AI summaries + pattern detection. *MTR relevance:* High — conversational analytics over portfolio KPIs fits an agent dashboard.
- **Listing Optimizer (AI, Airbnb)** — Scores each Airbnb listing (overall + A–D grade) on titles, descriptions, photos, amenities, rating, Guest Favorites, review count; flags issues, generates a ranked fix checklist, and tracks Airbnb search-rank/visibility weekly vs. competitors and across segments / lengths of stay. *MTR relevance:* Low — Airbnb-specific content/ranking optimization is tangential to off-platform MTR demand. *(Note: overlaps our own visibility/rank-tracking module + "Listing Optimizer" worker.)*
- **Generative AI insights** — Converts data charts into plain-language sentences across analytics/owner reporting. *MTR relevance:* Medium — easier consumption of portfolio data.

### Reviews / Reputation

- **Reputation/review handling (limited)** — Extensive guidance on managing Airbnb/Vrbo reviews and hotel reputation; some review-score signals feed the Listing Optimizer, but review management is not a core standalone module *(unverified whether any in-app review-response tooling exists)*. *MTR relevance:* Low — not a meaningful lever for an automated MTR pricing/portfolio dashboard.

### Vertical-Specific Modes

- **Mid-term / monthly rentals mode** — Same dynamic engine tuned for long stays: set a 30/60/90-night minimum, derive max/base by monthly price ÷ ~30, and layer weekly/monthly + LOS discounts. *MTR relevance:* High — the exact mode for our portfolio; monthly-to-nightly derivation and LOS discounting are the central mechanics.
- **Length-of-Stay (LOS) pricing adjustment** — A % change to the final price by nights booked (applied last), e.g., −10% for 7+, −15% for 14+, with bespoke 30/60/90-night tiers. *MTR relevance:* High — the primary way to make a unit progressively cheaper per night the longer a guest commits.
- **Weekly & monthly discounts** — Built-in % discounts for weekly/monthly stays (e.g., 10% weekly, 20% monthly). *MTR relevance:* High — monthly discount is the headline lever for 30+ night stays.
- **Orphan gap / gap-night management** — Auto-discount (default 20% for ≤2-night gaps) or re-price short unbookable gaps; can set min-stay equal to (or one night shorter than) the gap. *MTR relevance:* High *(per the ops-research pass; note Part 2 rates pure orphan handling Low for MTR — the value here is gap management at month boundaries, not 1–2 night STR scraps)*.
- **Aparthotels mode** — Pricing logic for aparthotels with weekly/monthly + LOS discounts, occupancy-based adjustments, booking-window rules, last-minute/far-out preferences. *MTR relevance:* High — room-type segmentation + long-stay discounting closely mirrors a furnished multi-unit MTR building.
- **Hotels / multi-unit room-type revenue management** — Tailor strategies by room type, season, booking window, occupancy; organize rooms into groups/sub-groups; uses HLP to optimize over-supplied markets. *MTR relevance:* Medium — room-type grouping maps to unit-type grouping, though hotel rate-plan mechanics differ.

### Pricing / Plans Model (brief)

- **Per-listing flat fee with sliding scale** — ~$19.99/listing/month (US/UK/CA/EU/AU/NZ/Israel; ~$9.99 elsewhere), discounted from the 2nd listing on a sliding scale toward ~$5.99/unit past ~100 properties. *Key settings:* volume discount; mapped child listings $1/month; extra daily syncs +$1/listing/month. *MTR relevance:* High — per-unit economics directly affect the cost of running a 30–90+ unit portfolio.
- **Revenue-based (usage) pricing option** — Pay ~1% of booking revenue instead of per-listing. *MTR relevance:* Medium — high per-booking revenue on long stays may make % less attractive than per-unit; worth modeling.
- **Portfolio Plan** — Flat ~$499/month for 60+ units. *MTR relevance:* High — likely the relevant tier for a sizable portfolio.
- **Add-on pricing** — Market Dashboards from ~$9.99/month; Revenue Estimator Pro ~$10/month; Portfolio Analytics free. *MTR relevance:* Medium.
- **Enterprise plan** — For hundreds–thousands of units: group/sub-group segmentation, 40+ attention-metrics, automated/scheduled reporting, data downloads, API access, dedicated account manager. *MTR relevance:* High — the backbone for an autonomous-agent-managed operation at scale.

### Other Notable Modules

- **2026 Revenue Accelerator** — An April-2026 release of 30+ features repositioning PriceLabs from a pricing engine to an end-to-end revenue-growth platform: AI base-price helper, Group-Level Preview Prices, Safety Minimum Price, enhanced Listing Optimizer w/ rank tracking, Min Stay Recommendation Engine, forecasting/goal-setting, Revenue Estimator Pro, AI Owner Analytics. *MTR relevance:* Medium — several components (preview prices, safety floor, min-stay engine, forecasting) apply directly to automated MTR management.
- **Hyper Local Pulse algorithm** — The core engine recalculating prices and min-stays daily from local supply/demand, with 30+ customizations layered on the base price. *MTR relevance:* High — the algorithmic backbone all MTR customizations sit on.

### Sources (Part 3)

- [Customization Groups](https://hello.pricelabs.co/customization-groups/)
- [Managing Multiple Listings with Account and Group-Level Customization](https://help.pricelabs.co/portal/en/kb/articles/account-group-customization)
- [Managing pricing for a large portfolio](https://hello.pricelabs.co/large-portfolio/)
- [Understanding the Manage Listings Page](https://help.pricelabs.co/portal/en/kb/articles/understanding-manage-listings-page)
- [Scheduling When Your Listing Syncs (Timed Sync)](https://help.pricelabs.co/portal/en/kb/articles/timed-sync)
- [Real-Time Sync](https://help.pricelabs.co/portal/en/kb/articles/real-time-sync)
- [How Often Are Rates Synced & How to Sync Listings](https://help.pricelabs.co/portal/en/kb/articles/how-often-are-my-rates-sycned-to-my-pms-and-how-does-sync-now-work)
- [How to check if my listings are synced successfully](https://help.pricelabs.co/portal/en/kb/articles/how-to-check-if-my-listings-are-synced-successfully)
- [Portfolio Analytics: KPIs & Historic Reports](https://help.pricelabs.co/portal/en/kb/articles/portfolio-analytics-kpi)
- [Portfolio Analytics (product page)](https://hello.pricelabs.co/portfolio-analytics/)
- [Market Dashboards (product page)](https://hello.pricelabs.co/market-dashboards/)
- [Understanding the PriceLabs Multi Calendar](https://help.pricelabs.co/portal/en/kb/articles/multicalendar)
- [160+ PMS and Channel Manager integrations](https://hello.pricelabs.co/integrations/)
- [Available Integrations](https://help.pricelabs.co/portal/en/kb/articles/available-integrations)
- [Using a PMS/Channel Manager to list prices to multiple OTAs](https://help.pricelabs.co/portal/en/kb/articles/pms)
- [PriceLabs Launches Official Booking.com Integration](https://hello.pricelabs.co/blog/pricelabs-launches-official-booking-com-integration/)
- [Mapping Listings From Different Channels](https://help.pricelabs.co/portal/en/kb/articles/mapping-listings)
- [Pricing offsets for mapped listings](https://help.pricelabs.co/portal/en/kb/articles/pricing-offsets-for-mapped-listings)
- [Customer API](https://help.pricelabs.co/portal/en/kb/articles/pricelabs-api)
- [Building an API integration with PriceLabs](https://help.pricelabs.co/portal/en/kb/articles/building-an-integration-with-pricelabs)
- [PriceLabs API Postman documentation](https://documenter.getpostman.com/view/507656/SVSEurQC)
- [Dynamic Pricing API to Connect with your PMS](https://hello.pricelabs.co/dynamic-pricing-api/)
- [How to use PriceLabs Customer API to send prices to WordPress/Wix](https://help.pricelabs.co/portal/en/kb/articles/how-to-use-pricelabs-customer-api-to-send-the-prices-to-wordpress-wix-website)
- [PriceLabs launches Open API](https://hello.pricelabs.co/blog/pricelabs-launches-open-api/)
- [How to integrate PriceLabs as a PMS via iAPI](https://help.pricelabs.co/portal/en/kb/articles/how-to-integrate-pricelabs-as-a-pms-via-iapi)
- [Using PriceLabs for Midterm Rentals](https://help.pricelabs.co/portal/en/kb/articles/using-pricelabs-for-mid-term-rentals)
- [Revenue Management for Mid-Term Rentals](https://hello.pricelabs.co/mid-term-rentals/)
- [Boost your aparthotel revenue management with PriceLabs](https://hello.pricelabs.co/aparthotels/)
- [Hotel Revenue Management Software with Dynamic Pricing](https://hello.pricelabs.co/hotel/)
- [Dynamic Pricing for Enterprise](https://hello.pricelabs.co/enterprise/dynamic-pricing/)
- [Pricing Plans](https://hello.pricelabs.co/plans/)
- [How much does PriceLabs cost after the trial](https://help.pricelabs.co/portal/en/kb/articles/how-much-does-pricelabs-costs)
- [PriceLabs 2026 Revenue Accelerator](https://hello.pricelabs.co/blog/revenue-accelerator-release/)
- [Listing Optimizer - AI-Powered Airbnb Listing Optimization](https://hello.pricelabs.co/listing-optimizer/)
- [Getting Started with Revenue Estimator Pro](https://help.pricelabs.co/portal/en/kb/articles/understanding-getting-started-pricelabs-revenue-estimator-pro)
- [Creating an Account and Importing Listings](https://help.pricelabs.co/portal/en/kb/articles/getting-started)
