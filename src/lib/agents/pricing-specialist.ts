import { logActivity } from "@/lib/repos/activity";
import { createApprovalItem, listPending } from "@/lib/repos/action-center";
import {
  listUnits,
  recordPricing,
  setUnitRate,
  setUnitMinStay,
  type PricingHistoryRow,
} from "@/lib/repos/units";
import { PRICING_AGENT } from "@/lib/config/pricing";
import { marketProviders, type MarketProviders } from "@/lib/pricing/providers";
import { representativeQuote, type FactorResult } from "@/lib/pricing/engine";

const {
  humanGatePct: HUMAN_GATE_PCT,
  noOpThresholdPct: NO_OP_PCT,
  highBlastRadiusPct: HIGH_BLAST_PCT,
} = PRICING_AGENT;

export interface PricingDecision {
  unitId: string;
  unitName: string;
  neighborhood: string;
  oldRate: number;
  newRate: number;
  deltaPct: number;
  reason: string;
  signals: Record<string, unknown>;
  status: PricingHistoryRow["status"];
  /** Audit row — absent for no-ops (not written, per config) and for moves already awaiting approval. */
  history?: PricingHistoryRow;
  /** Whether the price was pinned by the floor/ceiling/override. */
  bound: "floor" | "ceiling" | "override" | null;
  effectiveMonthlyRate: number;
  minStay: number;
  prevMinStay: number;
  minStaySource: string;
  /** The lead-time (days out) the representative rate was quoted for. */
  leadDays: number;
  /** Full, ordered breakdown of every rule that moved the price. */
  factors: FactorResult[];
}

export interface PricingRunResult {
  ranAt: string;
  decisions: PricingDecision[];
  flagged: PricingDecision[];
  applied: PricingDecision[];
  noOps: PricingDecision[];
  /** Unit ids skipped because they have no rate yet (imported, not rate-synced). */
  skipped: string[];
  /** Unit ids whose move was NOT re-filed because an escalation is already awaiting a decision. */
  alreadyPending: string[];
}

const fpct = (f: number) => `${f >= 1 ? "+" : ""}${((f - 1) * 100).toFixed(1)}%`;

/**
 * Run one pricing pass over the whole portfolio. The nightly price is built by
 * the rule engine (src/lib/pricing/engine.ts) from `providers`; this function
 * owns the side-effects: applying sub-gate moves, escalating big ones to the
 * Action Center (spec.md §5), updating min-stay, and writing history + activity.
 */
export function runPricingPass(providers: MarketProviders = marketProviders()): PricingRunResult {
  const asOf = new Date();
  const ranAt = asOf.toISOString();
  const units = listUnits();
  const decisions: PricingDecision[] = [];
  const skipped: string[] = [];
  const alreadyPending: string[] = [];

  // Units with an escalation still awaiting a decision: re-filing the same move
  // every pass would stack one duplicate Action-Center item per run. Items carry
  // the unit id in their payload; the prefix match covers items filed before
  // payloads existed.
  const pendingItems = listPending();
  const hasOpenEscalation = (unitId: string, unitName: string) =>
    pendingItems.some(
      (p) =>
        (p.payload as { kind?: string; unitId?: string } | null)?.unitId === unitId ||
        (p.worker === "Pricing Specialist" && p.proposedAction.startsWith(`Move ${unitName} from `)),
    );

  for (const unit of units) {
    // Units imported but not yet rate-synced (e.g. fresh MiniHotel imports) have
    // no base/current rate. There's nothing to reprice, and a 0 current rate would
    // make the % delta NaN and violate the pricing_history NOT NULL constraint.
    if (unit.baseRate <= 0 || unit.currentRate <= 0) {
      skipped.push(unit.id);
      continue;
    }
    const q = representativeQuote(unit, providers, asOf);
    const newRate = q.rate;
    const deltaPct = ((newRate - unit.currentRate) / unit.currentRate) * 100;
    const absDelta = Math.abs(deltaPct);

    const boundNote =
      q.bound === "floor"
        ? ` [held at floor ₪${unit.minRate}]`
        : q.bound === "ceiling"
          ? ` [capped at ceiling ₪${unit.maxRate}]`
          : q.bound === "override"
            ? " [date override]"
            : "";
    const topFactors = [...q.factors]
      .sort((a, b) => Math.abs(b.factor - 1) - Math.abs(a.factor - 1))
      .slice(0, 3)
      .map((f) => `${f.label} ${fpct(f.factor)}`)
      .join(", ");
    const reason =
      `${q.leadDays}d-out quote: ${topFactors || "base only"}.` +
      `${boundNote} · min-stay ${q.minStay}n (${q.minStaySource}).`;

    const signals: Record<string, unknown> = {
      base: q.base,
      rawRate: q.rawRate,
      rate: q.rate,
      bound: q.bound,
      leadDays: q.leadDays,
      factors: q.factors,
      effectiveMonthlyRate: q.effectiveMonthlyRate,
      monthlyDiscountPct: unit.monthlyDiscountPct,
      weeklyDiscountPct: unit.weeklyDiscountPct,
      recommendedMinStay: q.minStay,
      minStaySource: q.minStaySource,
      lowestMinStay: unit.lowestMinStay,
    };

    const isNoOp = absDelta < NO_OP_PCT;
    let status: PricingDecision["status"] = "applied";
    if (absDelta > HUMAN_GATE_PCT) status = "pending_approval";

    const escalationOpen = status === "pending_approval" && hasOpenEscalation(unit.id, unit.name);

    // History is the audit trail of things that happened: no-ops are not written
    // (per config — nothing moved), and a move already sitting in the Action
    // Center isn't re-recorded each pass.
    const history =
      isNoOp || escalationOpen
        ? undefined
        : recordPricing({
            unitId: unit.id,
            oldRate: unit.currentRate,
            newRate,
            deltaPct,
            reason,
            signals,
            status,
            ts: ranAt,
          });

    const decision: PricingDecision = {
      unitId: unit.id,
      unitName: unit.name,
      neighborhood: unit.neighborhood,
      oldRate: unit.currentRate,
      newRate,
      deltaPct,
      reason,
      signals,
      status,
      history,
      bound: q.bound,
      effectiveMonthlyRate: q.effectiveMonthlyRate,
      minStay: q.minStay,
      prevMinStay: unit.minStay,
      minStaySource: q.minStaySource,
      leadDays: q.leadDays,
      factors: q.factors,
    };
    decisions.push(decision);

    // Min-stay is a low-blast lever (never below the unit's floor) — apply directly.
    if (q.minStay !== unit.minStay) {
      setUnitMinStay(unit.id, q.minStay);
      logActivity({
        department: "revenue",
        worker: "Pricing Specialist",
        message: `${unit.name} (${unit.neighborhood}) min-stay ${unit.minStay}→${q.minStay} nights (${q.minStaySource}).`,
        level: "info",
      });
    }

    if (status === "applied" && !isNoOp) {
      setUnitRate(unit.id, newRate, ranAt);
      logActivity({
        department: "revenue",
        worker: "Pricing Specialist",
        message: `${unit.name} (${unit.neighborhood}) rate ${decision.oldRate}→${newRate} ILS (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%). ${reason}`,
        level: deltaPct >= 0 ? "success" : "info",
      });
    } else if (status === "pending_approval" && escalationOpen) {
      // Same move, still awaiting the operator — don't re-file or re-log it.
      alreadyPending.push(unit.id);
    } else if (status === "pending_approval" && history) {
      const item = createApprovalItem({
        department: "revenue",
        worker: "Pricing Specialist",
        proposedAction: `Move ${unit.name} from ${decision.oldRate} to ${newRate} ILS (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%).`,
        rationale: reason,
        blastRadius: absDelta >= HIGH_BLAST_PCT ? "high" : "medium",
        amount: `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}% (above ${HUMAN_GATE_PCT}% ceiling)`,
        rule: `spec.md §5 — pricing move > ±${HUMAN_GATE_PCT}%`,
        // Carries what "approve" must execute — the Action Center applies it on decision.
        payload: { kind: "pricing_move", unitId: unit.id, newRate, historyId: history.id },
      });
      logActivity({
        department: "revenue",
        worker: "Pricing Specialist",
        message: `Escalated ${unit.name}: proposed ${deltaPct.toFixed(1)}% move queued for human review (${item.id}).`,
        level: "warning",
      });
    }
  }

  return {
    ranAt,
    decisions,
    flagged: decisions.filter((d) => d.status === "pending_approval"),
    applied: decisions.filter((d) => d.status === "applied" && Math.abs(d.deltaPct) >= NO_OP_PCT),
    noOps: decisions.filter((d) => Math.abs(d.deltaPct) < NO_OP_PCT),
    skipped,
    alreadyPending,
  };
}
