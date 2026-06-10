// Tunable knobs for the price→position learner. One place to review the "magic
// numbers", mirroring src/lib/config/pricing.ts.

/** Airbnb web results/page — matches the scraper so rank ↔ (page, position) agree. */
export const WEB_PAGE_SIZE = 18;

export const LEARNING = {
  /** Only train on ladder rows from the last N days. */
  windowDays: 21,
  /** Recency weight half-life (days): weight = 0.5^(ageDays / halfLifeDays). */
  halfLifeDays: 7,
  /** Cap observations per fit (perf bound on PAVA + bootstrap). */
  maxObs: 2000,
  /** Below this many obs in a segment → "low" confidence (fall back to heuristic). */
  nMin: 25,
  /** At/above this many obs (with a tight-enough CI) → "high" confidence. */
  nHigh: 80,
  /** Bootstrap resamples for the price/rank confidence interval. */
  bootstrap: 200,
  /** Curve samples returned for charting. */
  curveSamples: 40,
  /** A latest scan older than this (days) caps confidence regardless of n. */
  staleAfterDays: 10,
} as const;

/** Raw-ladder retention (design §4.3): keep full-resolution search_results for
 *  rawDays, then downsample older runs to per-decile percentile summaries. */
export const LADDER_RETENTION = {
  rawDays: 120,
  /** Prune runs at most this often (guarded via meta, called from recordRun). */
  pruneEveryHours: 24,
} as const;

export interface LeadBucket {
  key: string;
  min: number;
  max: number;
  label: string;
}

// Default booking-window buckets (design §14, pending operator confirmation).
export const LEAD_BUCKETS: LeadBucket[] = [
  { key: "0-7", min: 0, max: 7, label: "0–7 days" },
  { key: "8-14", min: 8, max: 14, label: "8–14 days" },
  { key: "15-30", min: 15, max: 30, label: "15–30 days" },
  { key: "31-60", min: 31, max: 60, label: "31–60 days" },
  { key: "61+", min: 61, max: 100000, label: "61+ days" },
];

export function leadBucketOf(leadDays: number): LeadBucket {
  const d = Math.max(0, leadDays);
  return (
    LEAD_BUCKETS.find((b) => d >= b.min && d <= b.max) ?? LEAD_BUCKETS[LEAD_BUCKETS.length - 1]
  );
}

export function leadBucketByKey(key: string): LeadBucket | null {
  return LEAD_BUCKETS.find((b) => b.key === key) ?? null;
}
