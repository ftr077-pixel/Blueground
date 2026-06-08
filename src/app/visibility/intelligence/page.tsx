import { Brain } from "lucide-react";
import { IntelligencePanel } from "@/components/visibility/intelligence-panel";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="grid h-12 w-12 place-items-center rounded-xl border border-border bg-card">
          <Brain className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Pricing Intelligence</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Learned from the competitor price ladder: how much to move price to reach a target search
            position, given your lead time — and what each ₪ buys.
          </p>
        </div>
      </header>
      <IntelligencePanel />
    </div>
  );
}
