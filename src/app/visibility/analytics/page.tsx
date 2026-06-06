import Link from "next/link";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { AnalyticsPanel } from "@/components/visibility/analytics-panel";

export const dynamic = "force-dynamic";

export default function AnalyticsPage() {
  return (
    <div className="space-y-6">
      <Link
        href="/visibility"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Search Visibility
      </Link>
      <header className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-xl border border-border bg-card grid place-items-center">
          <BarChart3 className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Analytics</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Visibility trends over time, biggest movers, and price-vs-position per listing.
          </p>
        </div>
      </header>
      <AnalyticsPanel />
    </div>
  );
}
