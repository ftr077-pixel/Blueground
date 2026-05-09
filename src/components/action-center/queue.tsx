"use client";

import { useState } from "react";
import { Check, History, ShieldAlert, ShieldCheck, X } from "lucide-react";
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

interface Decision {
  itemId: string;
  outcome: "approved" | "rejected";
  decidedAt: string;
}

const deptName = (id: ApprovalItem["department"]) =>
  DEPARTMENTS.find((d) => d.id === id)?.name ?? id;
const deptIcon = (id: ApprovalItem["department"]) =>
  DEPARTMENTS.find((d) => d.id === id)?.icon ?? ShieldAlert;

export function ActionCenterQueue() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const decided = new Map(decisions.map((d) => [d.itemId, d]));
  const pending = APPROVAL_QUEUE.filter((i) => !decided.has(i.id));

  const decide = (item: ApprovalItem, outcome: Decision["outcome"]) => {
    setDecisions((prev) => [
      ...prev,
      { itemId: item.id, outcome, decidedAt: new Date().toISOString() },
    ]);
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <div className="flex items-center gap-2 text-xs">
            <ShieldAlert className="h-3.5 w-3.5 text-[hsl(var(--warning))]" />
            <span className="text-muted-foreground">Pending</span>
            <span className="ml-auto font-semibold">{pending.length}</span>
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="flex items-center gap-2 text-xs">
            <ShieldCheck className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
            <span className="text-muted-foreground">Approved this session</span>
            <span className="ml-auto font-semibold">
              {decisions.filter((d) => d.outcome === "approved").length}
            </span>
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="flex items-center gap-2 text-xs">
            <X className="h-3.5 w-3.5 text-[hsl(var(--danger))]" />
            <span className="text-muted-foreground">Rejected this session</span>
            <span className="ml-auto font-semibold">
              {decisions.filter((d) => d.outcome === "rejected").length}
            </span>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>Approval queue</CardTitle>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {pending.length} awaiting decision
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Items are blocked from autonomous execution until an operator decides.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {pending.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-background/30 p-8 text-center">
              <ShieldCheck className="mx-auto h-6 w-6 text-[hsl(var(--success))]" />
              <p className="mt-2 text-sm font-medium">Queue clear</p>
              <p className="text-[11px] text-muted-foreground">
                Every flagged item has a decision logged below.
              </p>
            </div>
          ) : (
            pending.map((item) => {
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
                        Triggered by ·{" "}
                        <span className="font-mono normal-case">{item.rule}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => decide(item, "approved")}
                        className="inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success/15 px-3 py-1.5 text-xs font-medium text-[hsl(var(--success))] hover:bg-success/25"
                      >
                        <Check className="h-3.5 w-3.5" /> Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(item, "rejected")}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60"
                      >
                        <X className="h-3.5 w-3.5" /> Reject
                      </button>
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>
              <span className="inline-flex items-center gap-2">
                <History className="h-3.5 w-3.5 text-muted-foreground" />
                Decisions log
              </span>
            </CardTitle>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {decisions.length} this session
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Operator decisions, in order. Re-issuing a decision is not supported (mocked).
          </p>
        </CardHeader>
        <CardContent>
          {decisions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No decisions yet.</p>
          ) : (
            <ul className="space-y-2">
              {decisions
                .slice()
                .reverse()
                .map((d) => {
                  const item = APPROVAL_QUEUE.find((i) => i.id === d.itemId)!;
                  const approved = d.outcome === "approved";
                  return (
                    <li
                      key={d.itemId}
                      className={cn(
                        "flex items-start gap-3 rounded-lg border bg-background/30 p-3",
                        approved ? "border-success/25" : "border-danger/25",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 grid h-6 w-6 place-items-center rounded-full",
                          approved
                            ? "bg-success/15 text-[hsl(var(--success))]"
                            : "bg-danger/15 text-[hsl(var(--danger))]",
                        )}
                      >
                        {approved ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-xs font-medium">{item.proposedAction}</span>
                          <Badge variant={approved ? "success" : "danger"}>{d.outcome}</Badge>
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            {formatRelative(d.decidedAt)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {item.worker} · {deptName(item.department)} · {item.rule}
                        </p>
                      </div>
                    </li>
                  );
                })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
