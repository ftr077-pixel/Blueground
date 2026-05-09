import { Check, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DEPARTMENTS } from "@/lib/mock-data";
import { APPROVAL_QUEUE, type ApprovalItem } from "@/lib/synthesis-data";
import { cn, formatRelative } from "@/lib/utils";

const BLAST_VARIANT: Record<ApprovalItem["blastRadius"], "info" | "warning" | "danger"> = {
  low: "info",
  medium: "warning",
  high: "danger",
};

export default function ActionCenterPage() {
  const deptName = (id: ApprovalItem["department"]) =>
    DEPARTMENTS.find((d) => d.id === id)?.name ?? id;
  const deptIcon = (id: ApprovalItem["department"]) =>
    DEPARTMENTS.find((d) => d.id === id)?.icon ?? ShieldAlert;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
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
        </div>
        <div className="flex items-center gap-3 text-xs">
          <Card className="px-3 py-2">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-3.5 w-3.5 text-[hsl(var(--warning))]" />
              <span className="text-muted-foreground">Pending</span>
              <span className="font-semibold">{APPROVAL_QUEUE.length}</span>
            </div>
          </Card>
          <Card className="px-3 py-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5 text-success" />
              <span className="text-muted-foreground">Today auto-approved</span>
              <span className="font-semibold">142</span>
            </div>
          </Card>
        </div>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Approval queue</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Items are blocked from autonomous execution until an operator decides.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {APPROVAL_QUEUE.map((item) => {
            const Icon = deptIcon(item.department);
            return (
              <article
                key={item.id}
                className={cn(
                  "rounded-xl border bg-background/40 p-4",
                  item.blastRadius === "high"
                    ? "border-danger/30"
                    : item.blastRadius === "medium"
                      ? "border-warning/30"
                      : "border-border",
                )}
              >
                <div className="flex flex-wrap items-start gap-3">
                  <div className="h-10 w-10 shrink-0 rounded-lg border border-border bg-card/60 grid place-items-center">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold tracking-tight">
                        {item.proposedAction}
                      </span>
                      <Badge variant={BLAST_VARIANT[item.blastRadius]}>
                        {item.blastRadius} blast
                      </Badge>
                      {item.amount && <Badge variant="muted">{item.amount}</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span className="text-foreground/90">{item.worker}</span>
                      <span>·</span>
                      <span>{deptName(item.department)}</span>
                      <span>·</span>
                      <span>raised {formatRelative(item.raisedAt)}</span>
                    </div>
                    <p className="mt-2 text-[12px] text-muted-foreground leading-relaxed">
                      {item.rationale}
                    </p>
                    <div className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      Triggered by · <span className="font-mono normal-case">{item.rule}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success/15 px-3 py-1.5 text-xs font-medium text-[hsl(var(--success))] hover:bg-success/25"
                    >
                      <Check className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60"
                    >
                      <X className="h-3.5 w-3.5" /> Reject
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
