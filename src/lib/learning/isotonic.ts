// Dependency-free weighted isotonic regression (non-decreasing) via PAVA, with
// linear interpolation for evaluation and inversion. This fits the market's
// price → rank-percentile curve: as nightly price rises, the typical rank
// percentile rises (worse position) — a monotone non-decreasing relationship.

export interface IsoInput {
  x: number;
  y: number;
  w?: number;
}

// Monotone knots: xs strictly increasing, ys non-decreasing.
export interface IsoCurve {
  xs: number[];
  ys: number[];
}

// Pool-Adjacent-Violators. Collapses the fit to one knot per pooled block at the
// block's weighted-mean x, yielding a monotone non-decreasing curve.
export function isotonicNonDecreasing(input: IsoInput[]): IsoCurve {
  const pts = input
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);

  const blocks: { wy: number; wx: number; w: number; value: number }[] = [];
  for (const p of pts) {
    const w = p.w && p.w > 0 ? p.w : 1;
    let b = { wy: w * p.y, wx: w * p.x, w, value: p.y };
    // Merge while the previous block sits above this one (a monotonicity violation).
    while (blocks.length && blocks[blocks.length - 1].value > b.value) {
      const last = blocks.pop()!;
      const wy = last.wy + b.wy;
      const wx = last.wx + b.wx;
      const wsum = last.w + b.w;
      b = { wy, wx, w: wsum, value: wy / wsum };
    }
    blocks.push(b);
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of blocks) {
    const x = b.wx / b.w;
    if (xs.length && x <= xs[xs.length - 1]) {
      // Tie after averaging: keep the (monotone) latest value at this x.
      ys[ys.length - 1] = b.value;
    } else {
      xs.push(x);
      ys.push(b.value);
    }
  }
  return { xs, ys };
}

// Evaluate the fitted curve at x (linear interpolation, clamped at the ends).
export function evalCurve(c: IsoCurve, x: number): number {
  const { xs, ys } = c;
  if (xs.length === 0) return NaN;
  if (xs.length === 1) return ys[0];
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = xs[hi] - xs[lo];
  const t = span === 0 ? 0 : (x - xs[lo]) / span;
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

// Invert: the x at which the (non-decreasing) curve reaches yTarget — i.e. the
// highest price that still achieves rank-percentile ≤ yTarget. `clamped` flags
// when the target is outside the observed range: "low" = better than anything in
// range (price alone won't get there), "high" = met at any price.
export function invertCurve(
  c: IsoCurve,
  yTarget: number,
): { x: number; clamped: "low" | "high" | null } {
  const { xs, ys } = c;
  if (xs.length === 0) return { x: NaN, clamped: null };
  if (xs.length === 1) return { x: xs[0], clamped: null };
  if (yTarget <= ys[0]) return { x: xs[0], clamped: "low" };
  if (yTarget >= ys[ys.length - 1]) return { x: xs[xs.length - 1], clamped: "high" };
  let lo = 0;
  let hi = ys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ys[mid] <= yTarget) lo = mid;
    else hi = mid;
  }
  const dy = ys[hi] - ys[lo];
  const t = dy === 0 ? 0 : (yTarget - ys[lo]) / dy;
  return { x: xs[lo] + t * (xs[hi] - xs[lo]), clamped: null };
}
