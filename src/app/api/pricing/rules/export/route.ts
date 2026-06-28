import { NextResponse } from "next/server";
import { PRICING_RULES, PRICING_AGENT } from "@/lib/config/pricing";
import {
  effectiveRules,
  effectiveHumanGatePct,
  getRuleOverrides,
  rulesWithOverrides,
  type RuleScope,
} from "@/lib/pricing/rules-config";
import { listUnits, listPricingHistory } from "@/lib/repos/units";
import { listMarketSnapshots } from "@/lib/repos/market";
import { marketRateBands, marketMinNightsBenchmark } from "@/lib/repos/visibility";
import { suggestionList } from "@/lib/learning/elasticity";
import { reservationStats, reservationReport } from "@/lib/repos/reservations";
import { searchResultsStats } from "@/lib/repos/search-results";
import { buildScorecard } from "@/lib/learning/scorecard";
import { listGroupNames } from "@/lib/repos/groups";

export const dynamic = "force-dynamic";

// Raw-data export for the human/AI-in-the-loop tuning workflow: download one
// JSON bundle, hand it to an AI to reason over, and the AI returns an override
// file you re-import (POST /api/pricing/rules/import). The bundle carries the
// CURRENT config (defaults + the scope's overrides + the resolved effective
// config) plus the performance context an AI needs to tune sensibly: the
// portfolio's units, recent price moves, market snapshots, and the learner's
// actionable suggestions. Pricing stays deterministic — the AI only proposes
// knob settings; the import path previews and a human commits them.

function validScope(scope: string | null): RuleScope | { error: string } {
  const s = (scope || "account").trim();
  if (s === "account") return s;
  if (s.startsWith("group:")) {
    const name = s.slice(6);
    if (!listGroupNames().includes(name)) return { error: `unknown group "${name}"` };
    return s;
  }
  if (s.startsWith("unit:")) {
    const id = s.slice(5);
    if (!listUnits().some((u) => u.id === id)) return { error: `unknown unit "${id}"` };
    return s;
  }
  return { error: "scope must be account, group:<name> or unit:<id>" };
}

export async function GET(req: Request) {
  const scope = validScope(new URL(req.url).searchParams.get("scope"));
  if (typeof scope !== "string") return NextResponse.json(scope, { status: 400 });

  const overrides = getRuleOverrides(scope);
  const effective =
    scope === "account"
      ? { ...effectiveRules(), humanGatePct: effectiveHumanGatePct() }
      : { ...rulesWithOverrides(overrides), humanGatePct: effectiveHumanGatePct() };

  const units = listUnits().map((u) => ({
    id: u.id,
    name: u.name,
    neighborhood: u.neighborhood,
    bedrooms: u.bedrooms,
    group: u.group,
    subgroup: u.subgroup,
    baseRate: u.baseRate,
    currentRate: u.currentRate,
    minRate: u.minRate,
    maxRate: u.maxRate,
    occupancy30d: u.occupancy30d,
    minStay: u.minStay,
    lowestMinStay: u.lowestMinStay,
    weeklyDiscountPct: u.weeklyDiscountPct,
    monthlyDiscountPct: u.monthlyDiscountPct,
    lastRateChangeAt: u.lastRateChangeAt,
  }));

  const market = listMarketSnapshots().map((s) => ({
    neighborhood: s.neighborhood,
    marketName: s.marketName,
    fetchedAt: s.fetchedAt,
    currency: s.currency,
    filterLabel: s.filterLabel,
    summary: s.summary,
    pacingDays: s.pacing.length,
  }));

  const suggestions = suggestionList(30, 1).suggestions.map((s) => ({
    listingId: s.listingId,
    unitId: s.unitId,
    label: s.label,
    area: s.area,
    direction: s.direction,
    currentNightly: s.currentNightly,
    suggestedNightly: s.suggestedNightly,
    deltaPct: s.deltaPct,
    // Ranking context: where the listing sits now and where the move lands it.
    currentPage: s.currentPage,
    expectedPage: s.expectedPage,
    targetPage: s.targetPage,
    suggestedPage: s.suggestedPage,
    confidence: s.confidence,
    profitAfter: s.profitAfter,
  }));

  // Reservations: compact aggregates (monthly NET, totals, VAT basis) plus
  // bounded raw bookings so an AI sees the actual demand, not just summaries.
  const report = reservationReport();
  const reservations = {
    stats: reservationStats(),
    byMonth: report.byMonth,
    totals: report.totals,
    recent: report.rows.slice(0, 200),
  };

  // Success / outcomes: did past price changes reach their predicted rank and
  // book within the window? This is the engine's own self-grading.
  const scorecard = buildScorecard({ windowDays: 21 });

  return NextResponse.json({
    _readme:
      "Raw pricing-intelligence snapshot: current config, the portfolio's units, " +
      "every recent price change (pricingHistory), actual bookings (reservations), " +
      "the search-rank ladder (ranking), the learner's suggestions, and an outcome " +
      "scorecard grading whether past moves hit their target rank and booked " +
      "(success). To tune: hand this to an AI and ask for an override file shaped " +
      "{ scope, overrides }, where `overrides` is a partial of `config.effective` " +
      "(only the sections to change). Re-import it via POST /api/pricing/rules/import " +
      "to preview the price impact before it goes live.",
    meta: {
      generatedAt: new Date().toISOString(),
      scope,
      app: "Rental Orchestrator Hub — pricing engine",
      engine: "deterministic rule stack (no model); overrides drive it per scope",
    },
    config: {
      scope,
      defaults: { ...PRICING_RULES, humanGatePct: PRICING_AGENT.humanGatePct },
      overrides,
      effective,
    },
    portfolio: { units },
    pricingHistory: listPricingHistory(undefined, 200),
    reservations,
    market: {
      snapshots: market,
      bands: marketRateBands(),
      minNights: marketMinNightsBenchmark(),
    },
    ranking: { ladderRuns: searchResultsStats(20) },
    learning: { suggestions },
    success: { scorecard },
  });
}
