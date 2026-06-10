import { LineChart } from "lucide-react";
import { MarketAnalyticsPanel } from "@/components/market/market-analytics-panel";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="grid h-12 w-12 place-items-center rounded-xl border border-border bg-card">
          <LineChart className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Market Analytics</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Live Tel Aviv market dynamics from AirROI — occupancy, rates, and forward booking
            pace — the signals driving the pricing engine.
          </p>
        </div>
      </header>
      <MarketAnalyticsPanel />
    </div>
  );
}
