import {
  LEARNING,
  WEB_PAGE_SIZE,
  leadBucketByKey,
  leadBucketOf,
  type LeadBucket,
} from "./config";
import { evalCurve, invertCurve, isotonicNonDecreasing, type IsoCurve, type IsoInput } from "./isotonic";
import {
  listingPriceHistory,
  listingState,
  marketObservations,
  pendingAppliedListingIds,
} from "./dataset";
import { demandSignal } from "./demand";
import { listingOffset, ownElasticity } from "./longitudinal";
import type {
  Confidence,
  CurvePoint,
  ElasticityResult,
  LearnedRecCompact,
  Observation,
  SegmentCurve,
  SegmentKey,
} from "./types";
import {
  costDefaults,
  floorMarginPct,
  getProfile,
  listListings,
  type TrackedListing,
} from "@/lib/repos/visibility";

const pageOf = (rank: number) => Math.max(1, Math.ceil(rank / WEB_PAGE_SIZE));
const round = (n: number, step = 1) => Math.round(n / step) * step;
const round1 = (n: number) => Math.round(n * 10) / 10;

type CostDefaults = ReturnType<typeof costDefaults>;

// Lowest ASKING nightly that still clears the configured margin floor for this
// listing — the same floor recommend() enforces, expressed in nightly terms:
//   minMonthlyRev = fixed / (1 − feePct − floorMargin)         [recommend()]
//   askingNightly = minMonthlyRev / (30 · (1 − monthlyDiscount))
// Null when economics are unknown (no rent) or the floor is infeasible. The
// learner never recommends below this — buying a search slot at a loss isn't a
// real move.
function floorNightly(
  listing: TrackedListing,
  costs: CostDefaults,
  floorPct: number,
): number | null {
  if (listing.monthlyRent == null) return null;
  const feePct = (costs.bgFeePct + costs.airbnbFeePct) / 100;
  const fixed =
    (listing.utilities ?? costs.defaultUtilities) +
    (listing.cleaningFee ?? costs.defaultCleaning) +
    listing.monthlyRent;
  const denom = 1 - feePct - floorPct / 100;
  const disc = 1 - costs.monthlyDiscountPct / 100;
  if (denom <= 0 || disc <= 0) return null;
  return fixed / denom / (30 * disc);
}

function fitCurve(obs: Observation[]): IsoCurve {
  return isotonicNonDecreasing(
    obs.map((o): IsoInput => ({ x: o.priceNightly, y: o.rank / o.total, w: o.weight })),
  );
}

function leadDaysFrom(checkIn: string): number | null {
  const dt = new Date(`${checkIn}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((dt.getTime() - today.getTime()) / 86_400_000);
}

function sampleCurve(curve: IsoCurve, T: number): CurvePoint[] {
  const out: CurvePoint[] = [];
  if (curve.xs.length < 2 || !T) return out;
  const min = curve.xs[0];
  const max = curve.xs[curve.xs.length - 1];
  const k = LEARNING.curveSamples;
  for (let i = 0; i < k; i++) {
    const nightly = min + ((max - min) * i) / (k - 1);
    const er = evalCurve(curve, nightly) * T;
    out.push({ nightly: Math.round(nightly), expectedRank: Math.round(er), expectedPage: pageOf(er) });
  }
  return out;
}

// 80% bootstrap interval on the price that hits qTarget: resample obs, refit, invert.
function bootstrapTarget(obs: Observation[], qTarget: number): { lo: number; hi: number } | null {
  const n = obs.length;
  if (n < 8) return null;
  const xs: number[] = [];
  for (let b = 0; b < LEARNING.bootstrap; b++) {
    const sample: IsoInput[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = obs[(Math.random() * n) | 0];
      sample[i] = { x: o.priceNightly, y: o.rank / o.total, w: o.weight };
    }
    const inv = invertCurve(isotonicNonDecreasing(sample), qTarget);
    if (Number.isFinite(inv.x)) xs.push(inv.x);
  }
  if (xs.length < 10) return null;
  xs.sort((a, b) => a - b);
  const pick = (p: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.round((xs.length - 1) * p)))];
  return { lo: pick(0.1), hi: pick(0.9) };
}

function confidenceLevel(
  n: number,
  freshnessDays: number | null,
  ci: { lo: number; hi: number } | null,
  targetNightly: number | null,
): Confidence {
  if (n < LEARNING.nMin) return "low";
  if (freshnessDays != null && freshnessDays > LEARNING.staleAfterDays) return "low";
  // No CI measured (bootstrap skipped) → gate "high" on sample size alone.
  const tight =
    ci == null
      ? true
      : targetNightly != null && targetNightly > 0
        ? (ci.hi - ci.lo) / targetNightly < 0.2
        : false;
  if (n >= LEARNING.nHigh && tight) return "high";
  return "medium";
}

// GET /api/learning/curve helper — the fitted price→position curve for a segment.
export function segmentCurve(
  profileId: string,
  nights: number,
  leadBucketKey: string,
): SegmentCurve {
  const bucket = leadBucketByKey(leadBucketKey) ?? leadBucketOf(20);
  const seg: SegmentKey = { profileId, nights, leadBucket: bucket.key };
  const { obs, medianTotal, freshnessDays } = marketObservations(seg, bucket);
  const curve = fitCurve(obs);
  const area = getProfile(profileId)?.label ?? profileId;
  return {
    segment: { ...seg, area },
    n: obs.length,
    medianTotal,
    freshnessDays: freshnessDays == null ? null : round1(freshnessDays),
    points: sampleCurve(curve, medianTotal || 0),
  };
}

// GET /api/learning/elasticity helper — the recommendation for one listing: the
// price to reach a target page, the marginal positions per ₪, and confidence.
export function elasticityForListing(
  listingId: string,
  opts: { nights?: number; checkIn?: string | null; targetPage?: number; bootstrap?: boolean } = {},
): ElasticityResult | null {
  const nights = opts.nights ?? 30;
  const state = listingState(listingId, nights, opts.checkIn ?? null);
  if (!state) return null;

  const leadDays = state.checkIn ? leadDaysFrom(state.checkIn) : null;
  const bucket: LeadBucket = leadBucketOf(leadDays ?? 9999);
  const seg: SegmentKey = { profileId: state.listing.profileId, nights, leadBucket: bucket.key };

  const { obs, medianTotal, freshnessDays } = marketObservations(seg, bucket);
  const n = obs.length;
  const curve = fitCurve(obs);
  const T = medianTotal || state.total || 0;
  const cur = state.currentNightly;
  const costs = costDefaults();
  const floorPct = floorMarginPct();

  // The market curve's rank for our current price, and a single-point calibration
  // to this listing: how many positions it sits above/below what its price implies
  // (a lightweight stand-in for the longitudinal offset Model B estimates in M4).
  const modeledRankAtCur = cur != null && T && curve.xs.length ? evalCurve(curve, cur) * T : null;
  // Model B: prefer a recency-weighted offset from the listing's whole history;
  // fall back to the single current point, then to none.
  const history = listingPriceHistory(listingId, nights);
  const histOffset =
    T && curve.xs.length ? listingOffset(history, curve, T, LEARNING.halfLifeDays) : null;
  const singleOffset =
    state.found && state.currentRank != null && modeledRankAtCur != null
      ? state.currentRank - modeledRankAtCur
      : 0;
  const offsetRank = histOffset && histOffset.n >= 2 ? histOffset.offset : singleOffset;
  const own = ownElasticity(history);
  // This listing's expected rank at a price = market curve + its offset.
  const listingRankAt = (price: number) =>
    T && curve.xs.length ? Math.max(1, evalCurve(curve, Math.max(1, price)) * T + offsetRank) : null;
  const curExpectedRank = cur != null ? listingRankAt(cur) : null;

  // Target: the price for THIS listing to reach (the bottom of) the requested page.
  const targetPage = Math.min(10, Math.max(1, Math.round(opts.targetPage ?? 1)));
  const targetRank = targetPage * WEB_PAGE_SIZE;

  let target: ElasticityResult["target"] = null;
  let ci: { lo: number; hi: number } | null = null;
  if (T && curve.xs.length >= 2) {
    // Solve on the market curve for the rank that, after the offset, lands us at
    // the target rank.
    const qAdj = Math.min(0.999, Math.max(0.001, (targetRank - offsetRank) / T));
    const inv = invertCurve(curve, qAdj);
    let targetNightly = round(inv.x, 5);
    // Margin floor (parity with recommend()): never recommend below the price
    // that still clears the configured floorMargin. The curve may point lower;
    // we hold at the floor rather than chase a position into a loss.
    const floorN = floorNightly(state.listing, costs, floorPct);
    const floored = floorN != null && targetNightly < floorN;
    if (floored) targetNightly = round(floorN, 5);
    ci = opts.bootstrap === false ? null : bootstrapTarget(obs, qAdj);
    target = {
      page: targetPage,
      rank: targetRank,
      nightly: targetNightly,
      deltaNightly: cur != null ? Math.round(targetNightly - cur) : null,
      deltaPct: cur != null && cur > 0 ? round1(((targetNightly - cur) / cur) * 100) : null,
      // At the floored price we sit higher than the target rank — report it
      // honestly rather than the (unreachable-within-margin) target.
      expectedRank: floored ? Math.round(listingRankAt(targetNightly) ?? targetRank) : targetRank,
      reachable: inv.clamped !== "low",
      floored,
    };
  }

  // Marginal: positions gained from a ₪100/night and a 1% cut at the current price
  // (the offset cancels in the difference, so this is the pure curve slope).
  let positionsPer100Nightly: number | null = null;
  let positionsPerPct: number | null = null;
  if (cur != null && curExpectedRank != null) {
    const r100 = listingRankAt(cur - 100);
    const rPct = listingRankAt(cur * 0.99);
    if (r100 != null) positionsPer100Nightly = round1(Math.max(0, curExpectedRank - r100));
    if (rPct != null) positionsPerPct = round1(Math.max(0, curExpectedRank - rPct));
  }

  const before = cur != null ? Math.round(cur * nights) : null;
  const after = target?.nightly != null ? Math.round(target.nightly * nights) : null;

  // Monthly profit impact (costs are monthly), using the shared cost defaults
  // (computed above) so the numbers match the Search & Profit / Profitability views.
  const profitAt = (nightly: number | null): { profit: number | null; margin: number | null } => {
    const rent = state.listing.monthlyRent;
    if (nightly == null || rent == null) return { profit: null, margin: null };
    const rev = nightly * 30 * (1 - costs.monthlyDiscountPct / 100);
    const fees = (rev * (costs.bgFeePct + costs.airbnbFeePct)) / 100;
    const bills =
      (state.listing.utilities ?? costs.defaultUtilities) +
      (state.listing.cleaningFee ?? costs.defaultCleaning);
    const profit = rev - fees - bills - rent;
    return { profit: Math.round(profit), margin: rev ? profit / rev : null };
  };
  const econBefore = profitAt(cur);
  const econAfter = profitAt(target?.nightly ?? null);
  const economics = {
    rentKnown: state.listing.monthlyRent != null,
    profitBefore: econBefore.profit,
    profitAfter: econAfter.profit,
    marginBefore: econBefore.margin != null ? round1(econBefore.margin * 100) : null,
    marginAfter: econAfter.margin != null ? round1(econAfter.margin * 100) : null,
  };

  const level = confidenceLevel(n, freshnessDays, ci, target?.nightly ?? null);

  // Relative demand for this check-in: a hot/cold read tempers (never overrides)
  // the price advice. Drops still come from the curve; demand frames urgency.
  const demand = state.checkIn ? demandSignal(seg.profileId, nights, state.checkIn) : null;

  let note: string | null = null;
  if (n === 0) note = "No market ladder captured for this segment yet — run scans to build it.";
  else if (n < LEARNING.nMin) note = `Learning — only ${n} market points in this segment; treat as indicative.`;
  else if (target?.floored)
    note = `Held at your ${floorPct}% margin floor — the curve points lower, but pricing there would fall below cost.`;
  else if (target && cur != null && target.deltaNightly != null && target.deltaNightly >= 0)
    note = `Already priced for page ${targetPage} or better — no cut needed.`;
  else if (target && !target.reachable)
    note = `Page ${targetPage} may not be reachable on price alone here — consider non-price levers.`;
  else if (demand?.label === "hot" && target && target.deltaNightly != null && target.deltaNightly < 0)
    note = `Demand is running hot for this date (top of its own range) — the market may climb to you; consider a smaller drop or a short hold.`;
  else if (demand?.label === "cold" && target && target.deltaNightly != null && target.deltaNightly < 0)
    note = `Demand is cold for this date — position buys less; lean on the cut (or non-price levers) early.`;

  return {
    listingId,
    label: state.listing.label,
    checkIn: state.checkIn,
    nights,
    leadDays,
    segment: { profileId: seg.profileId, area: state.area, nights, leadBucket: bucket.key },
    current: {
      nightly: cur != null ? Math.round(cur) : null,
      rank: state.currentRank,
      page: state.currentPage,
      total: state.total,
      found: state.found,
      expectedRank: curExpectedRank != null ? Math.round(curExpectedRank) : null,
      expectedPage: curExpectedRank != null ? pageOf(curExpectedRank) : null,
    },
    target,
    marginal: { positionsPer100Nightly, positionsPerPct },
    revenue: { nights, before, after, delta: before != null && after != null ? after - before : null },
    economics,
    model: {
      offsetRank: Math.round(offsetRank),
      offsetN: histOffset && histOffset.n >= 2 ? histOffset.n : state.found ? 1 : 0,
      ownPositionsPerPct: own ? round1(own.positionsPerPct) : null,
      ownN: own?.n ?? 0,
    },
    confidence: {
      level,
      n,
      ciNightlyLow: ci ? round(ci.lo, 5) : null,
      ciNightlyHigh: ci ? round(ci.hi, 5) : null,
      freshnessDays: freshnessDays == null ? null : round1(freshnessDays),
    },
    demand,
    curve: sampleCurve(curve, T),
    note,
  };
}

// Compact per-listing recommendation for the dashboard batch — skips the
// bootstrap CI (confidence is gated on sample size + freshness there).
export function learnedRec(
  listingId: string,
  nights: number,
  targetPage: number,
): LearnedRecCompact | null {
  const r = elasticityForListing(listingId, { nights, targetPage, bootstrap: false });
  if (!r || !r.target) return null;
  return {
    targetPage: r.target.page,
    suggestedNightly: r.target.nightly,
    deltaPct: r.target.deltaPct,
    expectedPage: r.current.expectedPage,
    reachable: r.target.reachable,
    confidence: r.confidence.level,
    n: r.confidence.n,
  };
}

// ------------------------------------------------------------- suggestions queue
// The actionable subset of the portfolio: listings whose learned target price
// differs meaningfully from what they charge now. This is what the operator works
// from — instead of stepping through every apartment, only movers show up.
export interface SuggestionRow {
  listingId: string;
  unitId: string | null;
  label: string;
  area: string;
  /** The check-in (stay start) date this suggestion is computed for — the
   *  soonest scanned window for the listing × stay length. Null = none scanned. */
  checkIn: string | null;
  nights: number;
  direction: "increase" | "decrease";
  currentNightly: number;
  suggestedNightly: number;
  deltaNightly: number;
  deltaPct: number;
  currentPage: number | null;
  expectedPage: number | null;
  targetPage: number;
  confidence: Confidence;
  n: number;
  /** Monthly profit delta when listing economics are known (₪/mo), else null. */
  profitDelta: number | null;
  /** Suggested price was clamped up to the margin floor (curve pointed lower). */
  floored: boolean;
}

export interface SuggestionBatch {
  nights: number;
  targetPage: number;
  minAbsPct: number;
  scanned: number;
  hiddenLowConfidence: number;
  /** Would-be suggestions suppressed because the move was already applied and no
   *  scan has re-priced the listing yet (shown as "applied, awaiting scan"). */
  appliedPending: number;
  suggestions: SuggestionRow[];
}

export function suggestionList(
  nights: number,
  targetPage: number,
  minAbsPct = 2,
): SuggestionBatch {
  const listings = listListings().filter((l) => l.active);
  const pending = pendingAppliedListingIds(nights);
  const suggestions: SuggestionRow[] = [];
  let hiddenLowConfidence = 0;
  let appliedPending = 0;

  for (const l of listings) {
    const r = elasticityForListing(l.id, { nights, targetPage, bootstrap: false });
    if (!r || !r.target || r.target.nightly == null) continue;
    if (r.current.nightly == null || r.target.deltaPct == null) continue;
    const suggestedNightly = r.target.nightly;
    const deltaPct = r.target.deltaPct;
    if (Math.abs(deltaPct) < minAbsPct) continue; // already priced about right
    if (deltaPct < 0 && !r.target.reachable) continue; // page not reachable on price alone
    if (r.confidence.level === "low") {
      hiddenLowConfidence++;
      continue;
    }
    // Already acted on, awaiting the next scan to reflect the new live price —
    // don't re-nag the same move (it shows in the scorecard as "awaiting scan").
    if (pending.has(l.id)) {
      appliedPending++;
      continue;
    }
    const profitDelta =
      r.economics && r.economics.profitBefore != null && r.economics.profitAfter != null
        ? r.economics.profitAfter - r.economics.profitBefore
        : null;
    suggestions.push({
      listingId: l.id,
      unitId: l.unitId ?? null,
      label: r.label,
      area: r.segment.area,
      checkIn: r.checkIn,
      nights,
      direction: deltaPct >= 0 ? "increase" : "decrease",
      currentNightly: r.current.nightly,
      suggestedNightly,
      deltaNightly: r.target.deltaNightly ?? Math.round(suggestedNightly - r.current.nightly),
      deltaPct,
      currentPage: r.current.page,
      expectedPage: r.current.expectedPage,
      targetPage: r.target.page,
      confidence: r.confidence.level,
      n: r.confidence.n,
      profitDelta,
      floored: r.target.floored,
    });
  }

  suggestions.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  return {
    nights,
    targetPage,
    minAbsPct,
    scanned: listings.length,
    hiddenLowConfidence,
    appliedPending,
    suggestions,
  };
}
