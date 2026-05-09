import Link from "next/link";
import { ArrowUpRight, CircleDot } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Department, WorkerStatus } from "@/lib/mock-data";

const STATUS_VARIANT: Record<WorkerStatus, "success" | "muted" | "warning"> = {
  active: "success",
  idle: "muted",
  attention: "warning",
};

const STATUS_LABEL: Record<WorkerStatus, string> = {
  active: "Active",
  idle: "Idle",
  attention: "Needs review",
};

export function DepartmentCard({ dept }: { dept: Department }) {
  const Icon = dept.icon;
  const healthVariant =
    dept.health >= 92 ? "success" : dept.health >= 85 ? "info" : "warning";
  return (
    <Card className="relative overflow-hidden">
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b",
          dept.accent,
        )}
      />
      <CardHeader className="relative">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-background/60 border border-border grid place-items-center">
              <Icon className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">{dept.name}</div>
              <div className="text-[11px] text-muted-foreground">{dept.director}</div>
            </div>
          </div>
          <Badge variant={healthVariant}>Health {dept.health}</Badge>
        </div>
        <p className="mt-3 text-xs text-muted-foreground leading-relaxed">{dept.tagline}</p>
      </CardHeader>

      <CardContent className="relative space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {dept.kpis.map((k) => (
            <div
              key={k.label}
              className="rounded-lg border border-border bg-background/40 px-3 py-2"
            >
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {k.label}
              </div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-sm font-semibold">{k.value}</span>
                {k.delta && (
                  <span
                    className={cn(
                      "text-[10px] font-medium",
                      k.delta.startsWith("-")
                        ? "text-[hsl(var(--danger))]"
                        : "text-[hsl(var(--success))]",
                    )}
                  >
                    {k.delta}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <ul className="space-y-2">
          {dept.workers.map((w) => (
            <li
              key={w.id}
              className="flex items-start gap-3 rounded-lg border border-border/70 bg-background/30 px-3 py-2.5"
            >
              <CircleDot
                className={cn(
                  "mt-0.5 h-3.5 w-3.5 shrink-0",
                  w.status === "active" && "text-[hsl(var(--success))] animate-pulse-dot",
                  w.status === "idle" && "text-muted-foreground",
                  w.status === "attention" && "text-[hsl(var(--warning))]",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium truncate">{w.name}</span>
                  <Badge variant={STATUS_VARIANT[w.status]}>{STATUS_LABEL[w.status]}</Badge>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
                  {w.lastAction}
                </p>
                <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground/80">
                  {w.metric.label}: <span className="text-foreground/90">{w.metric.value}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>

        <Link
          href={`/departments/${dept.id}`}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          Open department <ArrowUpRight className="h-3 w-3" />
        </Link>
      </CardContent>
    </Card>
  );
}
