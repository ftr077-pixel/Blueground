import { NextResponse } from "next/server";
import { PRICING_RULES, PRICING_AGENT } from "@/lib/config/pricing";
import {
  effectiveRules,
  effectiveHumanGatePct,
  getRuleOverrides,
  saveRuleOverrides,
  resetRuleOverrides,
  type RuleOverrides,
} from "@/lib/pricing/rules-config";

export const dynamic = "force-dynamic";

function payload() {
  return {
    defaults: { ...PRICING_RULES, humanGatePct: PRICING_AGENT.humanGatePct },
    overrides: getRuleOverrides(),
    effective: { ...effectiveRules(), humanGatePct: effectiveHumanGatePct() },
  };
}

// Settings → Pricing engine rules. Browser-facing (behind the dashboard login).
export async function GET() {
  return NextResponse.json(payload());
}

// PUT { ...RuleOverrides } merges a partial patch; PUT { reset: true } clears all.
export async function PUT(req: Request) {
  let body: (RuleOverrides & { reset?: boolean }) | null;
  try {
    body = (await req.json()) as RuleOverrides & { reset?: boolean };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (body?.reset) {
    resetRuleOverrides();
    return NextResponse.json({ ok: true, ...payload() });
  }
  saveRuleOverrides(body ?? {});
  return NextResponse.json({ ok: true, ...payload() });
}
