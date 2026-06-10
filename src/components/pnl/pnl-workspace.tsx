"use client";

import { BridgePanel } from "@/components/bridge/bridge-panel";
import { OccupancyPanel } from "@/components/pnl/occupancy-panel";

// One P&L surface over the Bridge 11 m model. The old Forecast/Plan sub-tabs
// rendered identical numbers unless drivers were edited, so they're merged:
// the table itself switches between Plan (locked plan of record), Forecast
// (plan + editable driver what-ifs), Actual (real data), and Δ vs plan.
export function PnlWorkspace() {
  return (
    <div className="space-y-6">
      <BridgePanel />
      <OccupancyPanel />
    </div>
  );
}
