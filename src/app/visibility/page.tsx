import { Radar } from "lucide-react";
import { VisibilityPanel } from "@/components/visibility/visibility-panel";

export const dynamic = "force-dynamic";

export default function VisibilityPage() {
  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl border border-border bg-card/60 grid place-items-center">
            <Radar className="h-5 w-5" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Growth &amp; Sourcing
            </div>
            <h1 className="mt-1 text-2xl md:text-3xl font-semibold tracking-tight">
              Search Visibility
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Where each listing lands in Airbnb search, by stay length and check-in date.
              Scanned from a residential box; eligibility separates min-stay filtering from how you rank.
            </p>
          </div>
        </div>
      </header>

      <VisibilityPanel />
    </div>
  );
}
