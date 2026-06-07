import { Wallet } from "lucide-react";
import { PnlPanel } from "@/components/pnl/pnl-panel";

export const dynamic = "force-dynamic";

export default function PnlPage() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-xl border border-border bg-card grid place-items-center">
          <Wallet className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">P&amp;L Forecast</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            A live profit &amp; loss for the portfolio. Revenue is derived from unit rates and
            occupancy; costs come from your per-apartment inputs and operating lines. Adjust the
            assumptions and project the next months — no spreadsheet required.
          </p>
        </div>
      </header>
      <PnlPanel />
    </div>
  );
}
