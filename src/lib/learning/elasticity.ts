import {
  LEARNING,
  WEB_PAGE_SIZE,
  leadBucketByKey,
  leadBucketOf,
  type LeadBucket,
} from "./config";
import { evalCurve, invertCurve, isotonicNonDecreasing, type IsoCurve, type IsoInput } from "./isotonic";
import { listingState, marketObservations } from "./dataset";
import type {
  Confidence,
  CurvePoint,
  ElasticityResult,
  Observation,
  SegmentCurve,
  SegmentKey,
} from "./types";
import { getProfile } from "@/lib/repos/visibility";

const pageOf = (rank: number) => Math.max(1, Math.ceil(rank / WEB_PAGE_SIZE));
const round = (n: number, step = 1) => Math.round(n / step) * step;
const round1 = (n: number) => Math.round(n * 10) / 10;

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
  const tight =
    ci != null && targetNightly != null && targetNightly > 0
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
  opts: { nights?: number; checkIn?: string | null; targetPage?: number } = {},
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

  // The market curve's rank for our current price, and a single-point calibration
  // to this listing: how many positions it sits above/below what its price implies
  // (a lightweight stand-in for the longitudinal offset Model B estimates in M4).
  const modeledRankAtCur = cur != null && T && curve.xs.length ? evalCurve(curve, cur) * T : null;
  const offsetRank =
    state.found && state.currentRank != null && modeledRankAtCur != null
      ? state.currentRank - modeledRankAtCur
      : 0;
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
    const targetNightly = round(inv.x, 5);
    ci = bootstrapTarget(obs, qAdj);
    target = {
      page: targetPage,
      rank: targetRank,
      nightly: targetNightly,
      deltaNightly: cur != null ? Math.round(targetNightly - cur) : null,
      deltaPct: cur != null && cur > 0 ? round1(((targetNightly - cur) / cur) * 100) : null,
      expectedRank: targetRank,
      reachable: inv.clamped !== "low",
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

  const level = confidenceLevel(n, freshnessDays, ci, target?.nightly ?? null);

  let note: string | null = null;
  if (n === 0) note = "No market ladder captured for this segment yet — run scans to build it.";
  else if (n < LEARNING.nMin) note = `Learning — only ${n} market points in this segment; treat as indicative.`;
  else if (target && cur != null && target.deltaNightly != null && target.deltaNightly >= 0)
    note = `Already priced for page ${targetPage} or better — no cut needed.`;
  else if (target && !target.reachable)
    note = `Page ${targetPage} may not be reachable on price alone here — consider non-price levers.`;

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
    confidence: {
      level,
      n,
      ciNightlyLow: ci ? round(ci.lo, 5) : null,
      ciNightlyHigh: ci ? round(ci.hi, 5) : null,
      freshnessDays: freshnessDays == null ? null : round1(freshnessDays),
    },
    curve: sampleCurve(curve, T),
    note,
  };
}
