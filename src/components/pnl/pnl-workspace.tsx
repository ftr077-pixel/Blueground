"use client";

import { useState } from "react";
import { BridgePanel } from "@/components/bridge/bridge-panel";
import { OccupancyPanel } from "@/components/pnl/occupancy-panel";
import { OpsForecastPanel } from "@/components/pnl/ops-forecast-panel";

// Two P&L views of the same business, side by side:
//   Bridge 11 m       — the plan of record from the business-plan workbook,
//                       driver-based and deliberately untouched (its own table
//                       already switches Plan / Forecast / Actual / Δ).
//   Operating forecast — built bottom-up from the book we actually hold
//                       (sold + expected pickup) and the operator's real unit
//                       economics, with "vs Plan" rows against the Bridge.
type Tab = "bridge" | "ops";

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "bridge", label: "Bridge 11 m plan", hint: "the uploaded plan of record" },
  { id: "ops", label: "Operating forecast", hint: "from real bookings + your costs" },
];

export function PnlWorkspace() {
  const [tab, setTab] = useState<Tab>("bridge");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-border p-0.5 text-xs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded px-3 py-1.5 ${
              tab === t.id
                ? "bg-primary/15 font-medium text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            <span className="ml-1.5 hidden text-[10px] font-normal opacity-70 sm:inline">
              · {t.hint}
            </span>
          </button>
        ))}
      </div>

      {tab === "bridge" ? (
        <>
          <BridgePanel />
          <OccupancyPanel />
        </>
      ) : (
        <OpsForecastPanel />
      )}
    </div>
  );
}
