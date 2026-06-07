import { BarChart3 } from "lucide-react";
import { PricingRankPanel } from "@/components/visibility/pricing-rank-panel";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="grid h-12 w-12 place-items-center rounded-xl border border-border bg-card">
          <BarChart3 className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Pricing vs Rank</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            How your price relates to your search position — find the over- and under-priced.
          </p>
        </div>
      </header>
      <PricingRankPanel />
    </div>
  );
}
