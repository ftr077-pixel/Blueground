import { CalendarClock } from "lucide-react";
import { PacingPanel } from "@/components/pacing/pacing-panel";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="grid h-12 w-12 place-items-center rounded-xl border border-border bg-card">
          <CalendarClock className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Pacing</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Listed price, occupancy, ADR and RevPAR by stay date — your portfolio against the
            market and against last year — plus booking curves showing how each month is filling.
          </p>
        </div>
      </header>
      <PacingPanel />
    </div>
  );
}
