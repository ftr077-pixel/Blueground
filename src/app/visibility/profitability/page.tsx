import { Banknote } from "lucide-react";
import { ProfitabilityPanel } from "@/components/visibility/profitability-panel";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="grid h-12 w-12 place-items-center rounded-xl border border-border bg-card">
          <Banknote className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Profitability</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Monthly profit and margin per listing — price minus rent, utilities and cleaning.
          </p>
        </div>
      </header>
      <ProfitabilityPanel />
    </div>
  );
}
