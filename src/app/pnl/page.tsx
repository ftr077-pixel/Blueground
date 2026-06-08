import { Wallet } from "lucide-react";
import { PnlWorkspace } from "@/components/pnl/pnl-workspace";

export const dynamic = "force-dynamic";

export default function PnlPage() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-xl border border-border bg-card grid place-items-center">
          <Wallet className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">P&amp;L</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            One P&amp;L over the <span className="font-medium">Bridge 11 m</span> model.{" "}
            <span className="font-medium">Plan</span> is the locked plan of record;{" "}
            <span className="font-medium">Forecast</span> adds the driver controls and — once
            production is connected — real data and variance, in the same structure.
          </p>
        </div>
      </header>
      <PnlWorkspace />
    </div>
  );
}
