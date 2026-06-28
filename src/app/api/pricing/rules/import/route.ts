import { NextResponse } from "next/server";
import { PRICING_RULES, PRICING_AGENT } from "@/lib/config/pricing";
import {
  effectiveHumanGatePct,
  getRuleOverrides,
  saveRuleOverrides,
  mergeRuleOverrides,
  rulesWithOverrides,
  scopeStoreKey,
  type RuleOverrides,
  type RuleScope,
} from "@/lib/pricing/rules-config";
import { listUnits } from "@/lib/repos/units";
import { listGroupNames } from "@/lib/repos/groups";

export const dynamic = "force-dynamic";

// Import side of the AI-in-the-loop tuning workflow (see ../export). Accepts an
// override file an AI produced from the export bundle and, by default, DRY-RUNS
// it: it merges the file's overrides over the scope's current ones and returns
// the config that WOULD result — without saving — so the UI can load it into the
// editor and the operator can Preview the price impact, then Save. Pass
// `apply: true` to commit immediately (same merge semantics as PUT
// /api/pricing/rules). Either way the change only takes effect on the next
// pricing pass, and moves over the human gate still escalate to the Action
// Center (spec §5) — the AI never prices autonomously.

interface ImportBody {
  scope?: string;
  apply?: boolean;
  /** The override file. Either a raw RuleOverrides patch, or a wrapper
   *  { scope?, overrides } / a full export bundle { config: { overrides } }. */
  overrides?: RuleOverrides;
  config?: { scope?: string; overrides?: RuleOverrides };
}

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

// Pull the override patch + a hinted scope out of whatever the AI handed back:
// a bare patch, a { scope, overrides } wrapper, or the full export bundle.
function extract(body: ImportBody): { patch: RuleOverrides; scopeHint: string | null } {
  if (body.overrides && typeof body.overrides === "object") {
    return { patch: body.overrides, scopeHint: body.scope ?? null };
  }
  if (body.config?.overrides && typeof body.config.overrides === "object") {
    return { patch: body.config.overrides, scopeHint: body.scope ?? body.config.scope ?? null };
  }
  // Treat the body itself as a bare patch (minus the control keys).
  const { scope: _s, apply: _a, overrides: _o, config: _c, ...rest } = body;
  return { patch: rest as RuleOverrides, scopeHint: body.scope ?? null };
}

export async function POST(req: Request) {
  let body: ImportBody | null;
  try {
    body = (await req.json()) as ImportBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "expected an override file object" }, { status: 400 });
  }

  const { patch, scopeHint } = extract(body);
  if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "no overrides found — expected { scope?, overrides } or a bare override patch" },
      { status: 400 },
    );
  }

  const scope = validScope(body.scope ?? scopeHint);
  if (typeof scope !== "string") return NextResponse.json(scope, { status: 400 });
  scopeStoreKey(scope); // guard: scope maps to a settings key

  const merged = mergeRuleOverrides(getRuleOverrides(scope), patch);
  // rulesWithOverrides sanitizes/clamps every field, so a malformed AI value
  // can't push the engine out of its safe ranges.
  const effective = { ...rulesWithOverrides(merged), humanGatePct: effectiveHumanGatePct() };

  if (body.apply === true) {
    saveRuleOverrides(patch, scope);
    return NextResponse.json({ ok: true, applied: true, scope, overrides: merged, effective });
  }

  // Dry-run: nothing persisted. The UI loads `effective` into the editor and
  // previews the price diff before the operator hits Save.
  return NextResponse.json({
    ok: true,
    applied: false,
    scope,
    overrides: merged,
    effective,
    defaults: { ...PRICING_RULES, humanGatePct: PRICING_AGENT.humanGatePct },
  });
}
