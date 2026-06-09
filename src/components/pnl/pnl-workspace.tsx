"use client";

import { useState } from "react";
import { BridgePanel } from "@/components/bridge/bridge-panel";
import { OccupancyPanel } from "@/components/pnl/occupancy-panel";

// One P&L surface, two sub-tabs over the same Bridge 11 m model:
//   • Forecast — driver controls (what-if) + real-data/variance slot.
//   • Plan     — the same structure locked as the plan of record.
export function PnlWorkspace() {
  const [tab, setTab] = useState<"forecast" | "plan">("forecast");
  return (
    <div className="space-y-6">
      <div className="flex w-fit items-center gap-1 rounded-lg border border-border p-0.5 text-sm">
        {(["forecast", "plan"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-3.5 py-1.5 capitalize transition-colors ${
              tab === t
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <BridgePanel mode={tab} />
      <OccupancyPanel />
    </div>
  );
}
