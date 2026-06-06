import Link from "next/link";
import { ArrowLeft, Settings } from "lucide-react";
import { ManagePanel } from "@/components/visibility/manage-panel";

export const dynamic = "force-dynamic";

export default function ManageVisibilityPage() {
  return (
    <div className="space-y-6">
      <Link
        href="/visibility"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Search Visibility
      </Link>

      <header className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-xl border border-border bg-card/60 grid place-items-center">
          <Settings className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Manage tracking</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Define search profiles (area + dates + guests) and the listings to track. The scanner
            box reads this on each run — many listings share one profile, so a handful of searches
            covers them all.
          </p>
        </div>
      </header>

      <ManagePanel />
    </div>
  );
}
