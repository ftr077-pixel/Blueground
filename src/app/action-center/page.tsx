import { ShieldAlert } from "lucide-react";
import { ActionCenterQueue } from "@/components/action-center/queue";

export default function ActionCenterPage() {
  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          <ShieldAlert className="h-3.5 w-3.5" />
          Human-in-the-loop
        </div>
        <h1 className="mt-2 text-2xl md:text-3xl font-semibold tracking-tight">
          Action Center
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Anomalies and high-blast-radius decisions agents have flagged for human approval, per
          <span className="ml-1 font-mono text-foreground">spec.md §5</span>.
        </p>
      </header>
      <ActionCenterQueue />
    </div>
  );
}
