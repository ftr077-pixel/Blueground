import { Settings as SettingsIcon } from "lucide-react";
import { ManagePanel } from "@/components/visibility/manage-panel";
import { UpdateCard } from "@/components/admin/update-card";
import { CostDefaultsCard } from "@/components/admin/cost-defaults-card";
import { PricingRulesCard } from "@/components/admin/pricing-rules-card";
import { MiniHotelCard } from "@/components/admin/minihotel-card";
import { MiniHotelMappingCard } from "@/components/admin/minihotel-mapping-card";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="grid h-12 w-12 place-items-center rounded-xl border border-border bg-card">
          <SettingsIcon className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Settings</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Profiles, listings, costs, pricing rules and app maintenance — all configuration in one
            place.
          </p>
        </div>
      </header>
      <ManagePanel />
      <CostDefaultsCard />
      <PricingRulesCard />
      <MiniHotelCard />
      <MiniHotelMappingCard />
      <UpdateCard />
    </div>
  );
}
