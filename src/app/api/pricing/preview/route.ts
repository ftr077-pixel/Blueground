import { NextResponse } from "next/server";
import { listUnits } from "@/lib/repos/units";
import { bookedDatesForUnit } from "@/lib/repos/rates";
import { marketProviders } from "@/lib/pricing/providers";
import { quoteNight } from "@/lib/pricing/engine";
import { PRICING_RULES } from "@/lib/config/pricing";
import {
  effectiveRules,
  getRuleOverrides,
  mergeRuleOverrides,
  rulesWithOverrides,
  type RuleOverrides,
} from "@/lib/pricing/rules-config";

export const dynamic = "force-dynamic";

// Preview Prices Graph (PriceLabs): quote one unit's forward curve under
//   current   — the saved rules (what the engine applies today),
//   candidate — the edited-but-UNSAVED settings patch, merged exactly like Save
//               would merge it, and
//   defaults  — the code-default customizations only,
// plus booked-night markers, so the operator can see the effect of a settings
// change before saving anything. Nothing here persists.

const DAY_MS = 86_400_000;
const HORIZONS = new Set([30, 60, 90, 183, 365]);

// GET — the unit list for the preview picker.
export async function GET() {
  return NextResponse.json({
    units: listUnits().map((u) => ({ id: u.id, name: u.name, neighborhood: u.neighborhood })),
  });
}

export async function POST(req: Request) {
  let body: { unitId?: string; candidate?: RuleOverrides; horizonDays?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const unit = listUnits().find((u) => u.id === body.unitId);
  if (!unit) return NextResponse.json({ error: "unit not found" }, { status: 404 });
  const horizon = HORIZONS.has(Number(body.horizonDays)) ? Number(body.horizonDays) : 90;

  const market = marketProviders();
  const asOf = new Date();
  const saved = effectiveRules();
  const candidate = rulesWithOverrides(
    mergeRuleOverrides(getRuleOverrides(), body.candidate ?? {}),
  );
  const defaults = PRICING_RULES;
  const booked = bookedDatesForUnit(unit.id, asOf.toISOString().slice(0, 10), horizon + 1);

  const step = horizon <= 90 ? 1 : horizon <= 183 ? 2 : 7;
  const points: Array<{
    date: string;
    current: number;
    candidate: number;
    defaults: number;
    booked: boolean;
  }> = [];
  for (let d = 0; d <= horizon; d += step) {
    const day = new Date(asOf.getTime() + d * DAY_MS);
    const iso = day.toISOString().slice(0, 10);
    points.push({
      date: iso,
      current: quoteNight(unit, day, market, asOf, saved).rate,
      candidate: quoteNight(unit, day, market, asOf, candidate).rate,
      defaults: quoteNight(unit, day, market, asOf, defaults).rate,
      booked: booked.has(iso),
    });
  }

  return NextResponse.json({
    unit: { id: unit.id, name: unit.name, neighborhood: unit.neighborhood, baseRate: unit.baseRate },
    horizonDays: horizon,
    points,
  });
}
