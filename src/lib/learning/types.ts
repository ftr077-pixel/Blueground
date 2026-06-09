// Public shapes for the price→position learner (Model A, cross-sectional).

export interface SegmentKey {
  profileId: string;
  nights: number;
  leadBucket: string;
}

// One market ladder observation feeding the curve.
export interface Observation {
  priceNightly: number;
  rank: number;
  total: number;
  weight: number; // recency weight
}

export type Confidence = "high" | "medium" | "low";

export interface CurvePoint {
  nightly: number;
  expectedRank: number;
  expectedPage: number;
}

// What GET /api/learning/curve returns for a segment.
export interface SegmentCurve {
  segment: SegmentKey & { area: string };
  n: number;
  medianTotal: number;
  freshnessDays: number | null;
  points: CurvePoint[];
}

// What GET /api/learning/elasticity returns for one listing.
export interface ElasticityResult {
  listingId: string;
  label: string;
  checkIn: string | null;
  nights: number;
  leadDays: number | null;
  segment: { profileId: string; area: string; nights: number; leadBucket: string };
  current: {
    nightly: number | null;
    rank: number | null;
    page: number | null;
    total: number | null;
    found: boolean;
    expectedRank: number | null;
    expectedPage: number | null;
  };
  target: {
    page: number;
    rank: number;
    nightly: number | null;
    deltaNightly: number | null;
    deltaPct: number | null;
    expectedRank: number | null;
    reachable: boolean;
  } | null;
  marginal: {
    positionsPer100Nightly: number | null;
    positionsPerPct: number | null;
  };
  revenue: { nights: number; before: number | null; after: number | null; delta: number | null };
  // Monthly profit impact (null fields when rent isn't set). Margins are percentages.
  economics: {
    rentKnown: boolean;
    profitBefore: number | null;
    profitAfter: number | null;
    marginBefore: number | null;
    marginAfter: number | null;
  } | null;
  confidence: {
    level: Confidence;
    n: number;
    ciNightlyLow: number | null;
    ciNightlyHigh: number | null;
    freshnessDays: number | null;
  };
  curve: CurvePoint[];
  note: string | null;
}

// Compact per-listing recommendation the dashboard attaches (drives recommend()).
export interface LearnedRecCompact {
  targetPage: number;
  suggestedNightly: number | null;
  deltaPct: number | null;
  expectedPage: number | null;
  reachable: boolean;
  confidence: Confidence;
  n: number;
}
