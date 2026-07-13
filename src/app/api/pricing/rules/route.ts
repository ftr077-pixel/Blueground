import { NextResponse } from "next/server";
import { PRICING_RULES, PRICING_AGENT } from "@/lib/config/pricing";
import {
  effectiveRules,
  effectiveRulesForUnit,
  effectiveHumanGatePct,
  getRuleOverrides,
  saveRuleOverrides,
  resetRuleOverrides,
  rulesWithOverrides,
  sectionSourcesForUnit,
  scopeStoreKey,
  type RuleOverrides,
  type RuleScope,
} from "@/lib/pricing/rules-config";
import { listGroupNames } from "@/lib/repos/groups";
import { listUnits } from "@/lib/repos/units";
import { liveMonthlySeasonality } from "@/lib/pricing/providers";

export const dynamic = "force-dynamic";

// Scope = "account" (default) | "group:<name>" | "unit:<id>" — PriceLabs's
// account / group / listing customization levels. A group blob applies whether
// listings attach it as group or sub-group.
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

function payload(scope: RuleScope) {
  const overrides = getRuleOverrides(scope);
  const base = {
    scope,
    defaults: { ...PRICING_RULES, humanGatePct: PRICING_AGENT.humanGatePct },
    overrides,
    // The scope's standalone effective view: ITS overrides on code defaults
    // (PriceLabs levels don't combine within a section — see resolveChain).
    effective:
      scope === "account"
        ? { ...effectiveRules(), humanGatePct: effectiveHumanGatePct() }
        : { ...rulesWithOverrides(overrides), humanGatePct: effectiveHumanGatePct() },
    groups: listGroupNames(),
    // What "automatic" currently resolves to per calendar month: the live
    // market curve where the synced snapshot has forward data, null elsewhere
    // (the UI then shows the built-in fallback curve for those months).
    liveSeasonality: liveMonthlySeasonality(),
  };
  // For a listing scope, also surface the TRUE config it actually prices on:
  // the full account → group → sub-group → listing merge, with per-section
  // attribution. Lets the operator see, e.g., that last-minute is OFF for this
  // listing even when it's ON at the account level — a more specific scope
  // shadows the parent (and the per-scope `effective` above, edited in
  // isolation, doesn't reveal what the listing inherits).
  if (scope.startsWith("unit:")) {
    const unit = listUnits().find((u) => u.id === scope.slice(5));
    if (unit) {
      return {
        ...base,
        merged: { ...effectiveRulesForUnit(unit), humanGatePct: effectiveHumanGatePct() },
        sources: sectionSourcesForUnit(unit),
      };
    }
  }
  return base;
}

// Pricing Configuration → engine rules. Browser-facing (behind the dashboard login).
export async function GET(req: Request) {
  const scope = validScope(new URL(req.url).searchParams.get("scope"));
  if (typeof scope !== "string") return NextResponse.json(scope, { status: 400 });
  return NextResponse.json(payload(scope));
}

// PUT { scope?, ...RuleOverrides } merges a partial patch into the scope;
// PUT { scope?, reset: true } clears the scope's overrides.
export async function PUT(req: Request) {
  let body: (RuleOverrides & { reset?: boolean; scope?: string }) | null;
  try {
    body = (await req.json()) as RuleOverrides & { reset?: boolean; scope?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const scope = validScope(body?.scope ?? null);
  if (typeof scope !== "string") return NextResponse.json(scope, { status: 400 });
  // Guard against a scope string that can't map to a settings key.
  scopeStoreKey(scope);
  if (body?.reset) {
    resetRuleOverrides(scope);
    return NextResponse.json({ ok: true, ...payload(scope) });
  }
  const { reset: _r, scope: _s, ...patch } = body ?? {};
  saveRuleOverrides(patch, scope);
  return NextResponse.json({ ok: true, ...payload(scope) });
}
