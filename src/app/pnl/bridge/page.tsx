import { FileSpreadsheet } from "lucide-react";
import { BridgePanel } from "@/components/bridge/bridge-panel";

export const dynamic = "force-dynamic";

export default function BridgePage() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-xl border border-border bg-card grid place-items-center">
          <FileSpreadsheet className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
            Business Plan — Bridge 11 m
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Your <span className="font-medium">Bridge 11 m Investment</span> P&amp;L, rebuilt as a live
            driver model. Every line recomputes from the property, utilization, and rate drivers —
            verified to reproduce the source workbook. Override a driver to run a what-if.
          </p>
        </div>
      </header>
      <BridgePanel />
    </div>
  );
}
