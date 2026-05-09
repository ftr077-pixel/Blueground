import { logActivity } from "@/lib/repos/activity";
import { createApprovalItem } from "@/lib/repos/action-center";
import {
  listUnits,
  recordPricing,
  setUnitRate,
  type PricingHistoryRow,
  type Unit,
} from "@/lib/repos/units";

const HUMAN_GATE_PCT = 15;

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

function computeProposal(unit: Unit, signal: MarketSignal | undefined): PricingDecision {
  const now = new Date().toISOString();
  const occ = unit.occupancy30d;
  const demand = signal?.demandIndex ?? 0;

  // Tilt: demand carries 70%, occupancy gap (vs 0.85 target) carries 30%.
  const occTilt = Math.max(-0.2, Math.min(0.2, (occ - 0.85) * 1.5));
  const tilt = 0.7 * demand + 0.3 * occTilt;
  // Clamp single-pass move at ±25% before the §5 gate; the gate then pulls
  // anything > ±15% out for human review.
  const clamped = Math.max(-0.25, Math.min(0.25, tilt));
  const newRate = Math.round(unit.baseRate * (1 + clamped) / 5) * 5;
  const deltaPct = ((newRate - unit.currentRate) / unit.currentRate) * 100;
  const absDelta = Math.abs(deltaPct);

  const reason = signal
    ? `${signal.driver} occupancy=${(occ * 100).toFixed(0)}%, demand=${(demand * 100).toFixed(0)}%`
    : `No signal for ${unit.neighborhood}; defaulting to occupancy tilt.`;

  const signals: Record<string, unknown> = {
    demandIndex: demand,
    occupancy30d: occ,
    occTilt,
    targetTilt: clamped,
    rawNewRate: unit.baseRate * (1 + clamped),
    driver: signal?.driver ?? "no-signal",
  };

  let status: PricingDecision["status"] = "applied";
  if (absDelta < 0.5) status = "applied"; // no-op-ish; we'll skip writes below
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
  };
}

export function runPricingPass(
  marketSignals: MarketSignal[] = defaultSignals(),
): PricingRunResult {
  const ranAt = new Date().toISOString();
  const units = listUnits();
  const byHood = new Map(marketSignals.map((s) => [s.neighborhood, s]));
  const decisions: PricingDecision[] = [];

  for (const unit of units) {
    const signal = byHood.get(unit.neighborhood);
    const decision = computeProposal(unit, signal);
    decisions.push(decision);

    const absDelta = Math.abs(decision.deltaPct);
    if (decision.status === "applied" && absDelta >= 0.5) {
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
        blastRadius: absDelta >= 20 ? "high" : "medium",
        amount: `${decision.deltaPct >= 0 ? "+" : ""}${decision.deltaPct.toFixed(1)}% (above ${HUMAN_GATE_PCT}% ceiling)`,
        rule: "spec.md §5 — pricing move > ±15%",
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
    applied: decisions.filter((d) => d.status === "applied" && Math.abs(d.deltaPct) >= 0.5),
    noOps: decisions.filter((d) => Math.abs(d.deltaPct) < 0.5),
  };
}
