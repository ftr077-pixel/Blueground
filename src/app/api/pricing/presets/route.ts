import { NextResponse } from "next/server";
import {
  SMART_PRESETS,
  PROPERTY_TYPES,
  adjustForExperience,
  type PropertyType,
} from "@/lib/config/presets";
import { saveRuleOverrides, type RuleScope } from "@/lib/pricing/rules-config";
import { listGroupNames } from "@/lib/repos/groups";
import { listUnits } from "@/lib/repos/units";
import { getSetting, setSetting } from "@/lib/repos/visibility";
import { logActivity } from "@/lib/repos/activity";

export const dynamic = "force-dynamic";

const CHOICE_KEY = "smart_presets_choice";

interface Choice {
  experienced: boolean;
  propertyType: PropertyType;
}

function getChoice(): Choice | null {
  const raw = getSetting(CHOICE_KEY);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Choice;
    return PROPERTY_TYPES.includes(c.propertyType) ? c : null;
  } catch {
    return null;
  }
}

// Smart Presets: property type + dynamic-pricing experience → a recommended
// customization bundle (built entirely from sections the engine already has).
// GET returns the saved choice and every preset (label, blurb, light-bulb
// items, the patch it would save); POST saves the choice and/or applies the
// chosen preset's patch to a scope. The setup prompt shows until a choice is
// saved — and stays editable after, like PriceLabs's Advanced Settings.
export async function GET() {
  const choice = getChoice();
  return NextResponse.json({
    choice,
    presets: Object.values(SMART_PRESETS).map((p) => ({
      key: p.key,
      label: p.label,
      blurb: p.blurb,
      items: p.items,
    })),
  });
}

export async function POST(req: Request) {
  let body: {
    choice?: { experienced?: boolean; propertyType?: string };
    apply?: { scope?: string };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (body.choice) {
    const propertyType = String(body.choice.propertyType ?? "");
    if (!PROPERTY_TYPES.includes(propertyType as PropertyType)) {
      return NextResponse.json({ error: "unknown property type" }, { status: 400 });
    }
    const choice: Choice = {
      experienced: !!body.choice.experienced,
      propertyType: propertyType as PropertyType,
    };
    setSetting(CHOICE_KEY, JSON.stringify(choice));
    if (!body.apply) return NextResponse.json({ ok: true, choice });
  }

  if (body.apply) {
    const choice = getChoice();
    if (!choice) return NextResponse.json({ error: "save a property-type choice first" }, { status: 400 });
    const scope: RuleScope = (body.apply.scope || "account").trim();
    if (scope !== "account") {
      if (scope.startsWith("group:")) {
        if (!listGroupNames().includes(scope.slice(6))) {
          return NextResponse.json({ error: "unknown group" }, { status: 400 });
        }
      } else if (scope.startsWith("unit:")) {
        if (!listUnits().some((u) => u.id === scope.slice(5))) {
          return NextResponse.json({ error: "unknown unit" }, { status: 400 });
        }
      } else {
        return NextResponse.json({ error: "bad scope" }, { status: 400 });
      }
    }
    const preset = SMART_PRESETS[choice.propertyType];
    const patch = adjustForExperience(preset.patch, choice.experienced);
    // The human gate is an account-level control (spec §5) — a preset applied
    // to a group/listing scope must not smuggle a gate change in.
    if (scope !== "account") delete patch.humanGatePct;
    saveRuleOverrides(patch, scope);
    logActivity({
      department: "revenue",
      worker: "Pricing Specialist",
      message: `Smart Preset "${preset.label}"${choice.experienced ? "" : " (new-to-dynamic-pricing softening)"} applied to ${scope}.`,
      level: "success",
    });
    return NextResponse.json({ ok: true, applied: preset.key, scope });
  }

  return NextResponse.json({ error: "nothing to do" }, { status: 400 });
}
