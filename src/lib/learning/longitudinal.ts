// Model B — the listing's OWN behaviour over time, learned from its scan history.
// Two estimates, both pure over a (price, rank) time series:
//
//  1) listingOffset — a recency-weighted mean residual (actual rank − the market
//     curve's rank for that price). It says "this listing sits N positions above/
//     below what its price implies", a stable replacement for the single-point
//     calibration in elasticityForListing.
//  2) ownElasticity — a robust (median pairwise) estimate of how the listing's
//     OWN rank responded to its OWN price moves: Δrank per Δln(price).
//
// Both degrade gracefully: too little history → null, and the caller falls back
// to the cross-sectional market curve (Model A).

import { evalCurve, type IsoCurve } from "./isotonic";

export interface HistPoint {
  ts: string;
  nightly: number;
  rank: number;
  total: number;
}

export interface ListingOffset {
  offset: number; // positions above(-)/below(+) the market curve
  n: number;
}

export function listingOffset(
  history: HistPoint[],
  curve: IsoCurve,
  T: number,
  halfLifeDays: number,
  now: number = Date.now(),
): ListingOffset | null {
  if (!history.length || !T || curve.xs.length === 0) return null;
  let wsum = 0;
  let acc = 0;
  let n = 0;
  for (const h of history) {
    const modeled = evalCurve(curve, h.nightly) * T;
    if (!Number.isFinite(modeled)) continue;
    const ageDays = (now - new Date(h.ts).getTime()) / 86_400_000;
    const w = Math.pow(0.5, ageDays / halfLifeDays);
    acc += w * (h.rank - modeled);
    wsum += w;
    n++;
  }
  if (!n || wsum === 0) return null;
  return { offset: acc / wsum, n };
}

export interface OwnElasticity {
  beta: number; // Δrank per unit Δln(price) (positive: pricier ⇒ worse rank)
  positionsPerPct: number; // positions GAINED per 1% price cut (β · 0.01)
  n: number; // number of price-move pairs used
}

// Median pairwise slope across consecutive appearances where price moved by at
// least `minRelMove`. Median → robust to the noise from non-price rank factors.
export function ownElasticity(history: HistPoint[], minRelMove = 0.02): OwnElasticity | null {
  const pts = [...history].sort((a, b) => a.ts.localeCompare(b.ts));
  const slopes: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.nightly <= 0 || b.nightly <= 0) continue;
    const dlnp = Math.log(b.nightly) - Math.log(a.nightly);
    if (Math.abs(dlnp) < minRelMove) continue; // ignore ~flat price
    slopes.push((b.rank - a.rank) / dlnp);
  }
  if (slopes.length < 2) return null;
  slopes.sort((x, y) => x - y);
  const mid = Math.floor(slopes.length / 2);
  const beta = slopes.length % 2 ? slopes[mid] : (slopes[mid - 1] + slopes[mid]) / 2;
  return { beta, positionsPerPct: beta * 0.01, n: slopes.length };
}
