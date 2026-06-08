import { logActivity } from "@/lib/repos/activity";
import { createApprovalItem } from "@/lib/repos/action-center";
import {
  listUnits,
  recordPricing,
  setUnitRate,
  setUnitMinStay,
  type PricingHistoryRow,
  type Unit,
} from "@/lib/repos/units";
import { marketMinNightsBenchmark } from "@/lib/repos/visibility";
import { PRICING_AGENT, roundRate } from "@/lib/config/pricing";

const {
  humanGatePct: HUMAN_GATE_PCT,
  maxMinStay: MAX_MIN_STAY,
  noOpThresholdPct: NO_OP_PCT,
  highBlastRadiusPct: HIGH_BLAST_PCT,
} = PRICING_AGENT;

export interface MarketSignal {
  neighborhood: string;
  /** -1..+1 normalized demand pressure (search volume + comp set + events). */
  demandIndex: number;
  /** Free-text justification. */
  driver: string;
}

export interface PricingDecision {
  unit: Unit;
  oldRate: number;
  newRate: number;
  deltaPct: number;
  reason: string;
  signals: Record<string, unknown>;
  status: PricingHistoryRow["status"];
  history: PricingHistoryRow;
  /** Whether the price was pinned by the unit's floor/ceiling (PriceLabs min/max). */
  bound: "floor" | "ceiling" | null;
  /** Effective monthly rate after the monthly LOS discount (ILS total / 30n). */
  effectiveMonthlyRate: number;
  /** Recommended minimum stay (nights) and the value it replaces. */
  minStay: number;
  prevMinStay: number;
}

export interface PricingRunResult {
  ranAt: string;
  decisions: PricingDecision[];
  flagged: PricingDecision[];
  applied: PricingDecision[];
  noOps: PricingDecision[];
}

function defaultSignals(now: Date = new Date()): MarketSignal[] {
  // Mock: deterministic-ish per-day signals so reruns are stable inside a day.
  const seed = now.getUTCFullYear() * 1000 + now.getUTCMonth() * 50 + now.getUTCDate();
  const noise = (k: number) => {
    const x = Math.sin(seed * 9301 + k * 49297) * 233280;
    return x - Math.floor(x); // 0..1
  };
  return [
    {
      neighborhood: "Lev HaIr",
      demandIndex: 0.08 + 0.18 * (noise(1) - 0.5),
      driver: "Steady weekday demand from relocations.",
    },
    {
      neighborhood: "Neve Tzedek",
      demandIndex: 0.22 + 0.3 * (noise(2) - 0.5),
      driver: "DLD Festival week — comp set already up 14%.",
    },
    {
      neighborhood: "Florentin",
      demandIndex: 0.05 + 0.18 * (noise(3) - 0.5),
      driver: "Comp set flat; long-stay leads stable.",
    },
    {
      neighborhood: "Kerem HaTeimanim",
      demandIndex: 0.17 + 0.24 * (noise(4) - 0.5),
      driver: "Heatwave forecast pushing inbound search.",
    },
  ];
}

// Min-stay flexes with demand but never below the hard floor that defines the
// unit as mid-term. When the local market requires longer stays than we'd ask,
// nudge toward it (capped) so we don't leave commitment/term on the table.
function recommendMinStay(
  unit: Unit,
  demand: number,
  marketMedian: number | null,
): { minStay: number; note: string } {
  const floor = unit.lowestMinStay;
  const tiers = PRICING_AGENT.minStayDemandTiers;
  let rec = floor;
  let note = `floor ${floor}n`;
  for (const tier of tiers) {
    // tiers are ordered highest-threshold first, so the first match wins
    if (demand >= tier.threshold) {
      rec = floor + tier.bump;
      note = `${tier.label} → ${rec}n`;
      break;
    }
  }
  if (marketMedian && marketMedian > rec) {
    rec = Math.min(marketMedian, floor + tiers[0].bump);
    note = `matching market median ${marketMedian}n → ${rec}n`;
  }
  rec = Math.max(floor, Math.min(rec, MAX_MIN_STAY));
  return { minStay: rec, note };
}

function computeProposal(
  unit: Unit,
  signal: MarketSignal | undefined,
  marketMedianMinNights: number | null,
): PricingDecision {
  const now = new Date().toISOString();
  const occ = unit.occupancy30d;
  const demand = signal?.demandIndex ?? 0;

  // Tilt: demand and the occupancy gap (vs target) are blended by configured
  // weights. Constants live in src/lib/config/pricing.ts.
  const occGap = (occ - PRICING_AGENT.targetOccupancy) * PRICING_AGENT.occupancyTiltSlope;
  const occCap = PRICING_AGENT.occupancyTiltCap;
  const occTilt = Math.max(-occCap, Math.min(occCap, occGap));
  const tilt = PRICING_AGENT.demandWeight * demand + PRICING_AGENT.occupancyWeight * occTilt;
  // Clamp the single-pass move before the §5 gate; the gate then pulls anything
  // beyond ±humanGatePct out for human review.
  const cap = PRICING_AGENT.singlePassClamp;
  const clamped = Math.max(-cap, Math.min(cap, tilt));
  const rawNewRate = roundRate(unit.baseRate * (1 + clamped));

  // #1 — pin to the unit's price floor/ceiling (PriceLabs min/max price). The
  // floor is the key MTR guardrail: dynamic discounting can never undercut it.
  let newRate = rawNewRate;
  let bound: "floor" | "ceiling" | null = null;
  if (newRate < unit.minRate) {
    newRate = unit.minRate;
    bound = "floor";
  } else if (newRate > unit.maxRate) {
    newRate = unit.maxRate;
    bound = "ceiling";
  }

  const deltaPct = ((newRate - unit.currentRate) / unit.currentRate) * 100;
  const absDelta = Math.abs(deltaPct);

  // #2 — effective monthly rate after the monthly LOS discount: the number an
  // MTR guest actually compares on. This is what wins or loses the booking.
  const effectiveMonthlyRate = Math.round(newRate * 30 * (1 - unit.monthlyDiscountPct));

  // #3 — recommended minimum stay, benchmarked against competitor min-nights.
  const { minStay, note: minStayNote } = recommendMinStay(unit, demand, marketMedianMinNights);

  const boundNote =
    bound === "floor"
      ? ` [held at floor ₪${unit.minRate}]`
      : bound === "ceiling"
        ? ` [capped at ceiling ₪${unit.maxRate}]`
        : "";
  const reason =
    (signal
      ? `${signal.driver} occupancy=${(occ * 100).toFixed(0)}%, demand=${(demand * 100).toFixed(0)}%`
      : `No signal for ${unit.neighborhood}; defaulting to occupancy tilt.`) +
    `${boundNote} · min-stay ${minStayNote}`;

  const signals: Record<string, unknown> = {
    demandIndex: demand,
    occupancy30d: occ,
    occTilt,
    targetTilt: clamped,
    rawNewRate,
    minRate: unit.minRate,
    maxRate: unit.maxRate,
    bound,
    monthlyDiscountPct: unit.monthlyDiscountPct,
    weeklyDiscountPct: unit.weeklyDiscountPct,
    effectiveMonthlyRate,
    recommendedMinStay: minStay,
    lowestMinStay: unit.lowestMinStay,
    marketMedianMinNights,
    driver: signal?.driver ?? "no-signal",
  };

  let status: PricingDecision["status"] = "applied";
  if (absDelta < NO_OP_PCT) status = "applied"; // no-op-ish; we'll skip writes below
  else if (absDelta > HUMAN_GATE_PCT) status = "pending_approval";

  // Persist history + (sometimes) update the unit
  const history = recordPricing({
    unitId: unit.id,
    oldRate: unit.currentRate,
    newRate,
    deltaPct,
    reason,
    signals,
    status,
    ts: now,
  });

  return {
    unit,
    oldRate: unit.currentRate,
    newRate,
    deltaPct,
    reason,
    signals,
    status,
    history,
    bound,
    effectiveMonthlyRate,
    minStay,
    prevMinStay: unit.minStay,
  };
}

export function runPricingPass(
  marketSignals: MarketSignal[] = defaultSignals(),
): PricingRunResult {
  const ranAt = new Date().toISOString();
  const units = listUnits();
  const byHood = new Map(marketSignals.map((s) => [s.neighborhood, s]));
  const marketMedianMinNights = marketMinNightsBenchmark().median;
  const decisions: PricingDecision[] = [];

  for (const unit of units) {
    const signal = byHood.get(unit.neighborhood);
    const decision = computeProposal(unit, signal, marketMedianMinNights);
    decisions.push(decision);

    // Min-stay is a low-blast lever (it can never drop below the unit's floor),
    // so apply it directly whenever it moves — independent of the price gate.
    if (decision.minStay !== decision.prevMinStay) {
      setUnitMinStay(unit.id, decision.minStay);
      logActivity({
        department: "revenue",
        worker: "Pricing Specialist",
        message: `${unit.name} (${unit.neighborhood}) min-stay ${decision.prevMinStay}→${decision.minStay} nights.${marketMedianMinNights ? ` Market median ${marketMedianMinNights}n.` : ""}`,
        level: "info",
      });
    }

    const absDelta = Math.abs(decision.deltaPct);
    if (decision.status === "applied" && absDelta >= NO_OP_PCT) {
      setUnitRate(unit.id, decision.newRate, ranAt);
      logActivity({
        department: "revenue",
        worker: "Pricing Specialist",
        message: `${unit.name} (${unit.neighborhood}) rate ${decision.oldRate}→${decision.newRate} ILS (${decision.deltaPct >= 0 ? "+" : ""}${decision.deltaPct.toFixed(1)}%). ${decision.reason}`,
        level: decision.deltaPct >= 0 ? "success" : "info",
      });
    } else if (decision.status === "pending_approval") {
      const item = createApprovalItem({
        department: "revenue",
        worker: "Pricing Specialist",
        proposedAction: `Move ${unit.name} from ${decision.oldRate} to ${decision.newRate} ILS (${decision.deltaPct >= 0 ? "+" : ""}${decision.deltaPct.toFixed(1)}%).`,
        rationale: decision.reason,
        blastRadius: absDelta >= HIGH_BLAST_PCT ? "high" : "medium",
        amount: `${decision.deltaPct >= 0 ? "+" : ""}${decision.deltaPct.toFixed(1)}% (above ${HUMAN_GATE_PCT}% ceiling)`,
        rule: `spec.md §5 — pricing move > ±${HUMAN_GATE_PCT}%`,
      });
      logActivity({
        department: "revenue",
        worker: "Pricing Specialist",
        message: `Escalated ${unit.name}: proposed ${decision.deltaPct.toFixed(1)}% move queued for human review (${item.id}).`,
        level: "warning",
      });
    } else {
      // No-op; skip activity log to avoid noise.
    }
  }

  return {
    ranAt,
    decisions,
    flagged: decisions.filter((d) => d.status === "pending_approval"),
    applied: decisions.filter((d) => d.status === "applied" && Math.abs(d.deltaPct) >= NO_OP_PCT),
    noOps: decisions.filter((d) => Math.abs(d.deltaPct) < NO_OP_PCT),
  };
}
