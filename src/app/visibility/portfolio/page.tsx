import { Boxes } from "lucide-react";
import { PortfolioPanel } from "@/components/visibility/portfolio-panel";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="grid h-12 w-12 place-items-center rounded-xl border border-border bg-card">
          <Boxes className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Portfolio</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Rollups by profile — availability coverage, search presence and yield.
          </p>
        </div>
      </header>
      <PortfolioPanel />
    </div>
  );
}
