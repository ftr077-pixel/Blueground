import { SlidersHorizontal } from "lucide-react";
import { EngineRulesCard } from "@/components/admin/engine-rules-card";
import { PricingRulesCard } from "@/components/admin/pricing-rules-card";

export const dynamic = "force-dynamic";

export default function PricingConfigurationPage() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="grid h-12 w-12 place-items-center rounded-xl border border-border bg-card">
          <SlidersHorizontal className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Pricing Configuration
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The full PriceLabs-style customization surface: Smart Presets, the rule engine per
            scope (account → group → sub-group → listing), profiles, the customizations table
            view, and the preview-prices graph. Changes apply on the next pricing pass — no
            redeploy.
          </p>
        </div>
      </header>
      <EngineRulesCard />
      <PricingRulesCard />
    </div>
  );
}
