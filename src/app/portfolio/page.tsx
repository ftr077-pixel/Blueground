import { Building2 } from "lucide-react";
import { ImportPanel } from "@/components/units/import-panel";

export const dynamic = "force-dynamic";

export default function PortfolioPage() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-xl border border-border bg-card/60 grid place-items-center">
          <Building2 className="h-5 w-5" />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Revenue &amp; Yield
          </div>
          <h1 className="mt-1 text-2xl md:text-3xl font-semibold tracking-tight">Portfolio</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The properties under management. Import your existing list from a spreadsheet, then the
            autonomous departments price, monitor, and source against it.
          </p>
        </div>
      </header>

      <ImportPanel />
    </div>
  );
}
