import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CircleDot } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PricingPanel } from "@/components/agents/pricing-panel";
import {
  DEPARTMENTS,
  type Department,
  type Worker,
  type WorkerStatus,
} from "@/lib/mock-data";
import { listActivity } from "@/lib/repos/activity";
import { getCalendar } from "@/lib/repos/rates";
import { cn, formatRelative } from "@/lib/utils";

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

export const dynamic = "force-dynamic";

const ROLE_BY_WORKER: Record<string, string> = {
  "Pricing Specialist": "Dynamic rates & restrictions → MiniHotel (Reverse ARI)",
};

export default function DepartmentPage({ params }: { params: { id: string } }) {
  const dept = DEPARTMENTS.find((d) => d.id === params.id) as Department | undefined;
  if (!dept) notFound();

  const Icon = dept.icon;
  const events = listActivity(200).filter((e) => e.department === dept.id);

  // Revenue & Yield shows REAL numbers only: KPIs from the synced Rates
  // Calendar (next 30 nights) and worker cards rolled up from actual logged
  // agent activity. No invented health scores, metrics, or narratives —
  // unknowns render as "—" until real data exists. Other departments are
  // placeholder demos for now and keep their static copy.
  const isRevenue = dept.id === "revenue";
  let kpis = dept.kpis;
  let health: number | null = dept.health;
  let workers: Worker[] = dept.workers;
  if (isRevenue) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
      new Date(),
    );
    const s = getCalendar(today, 30).summary;
    const known = s.sold + s.open > 0;
    const ils = (n: number) => "₪" + Math.round(n).toLocaleString("en-US");
    kpis = [
      { label: "Occupancy · synced 30d", value: known ? `${Math.round(s.occupancy * 100)}%` : "—" },
      { label: "ADR · booked nights", value: s.adr > 0 ? ils(s.adr) : "—" },
      { label: "On-the-books · 30d", value: s.bookedRevenue > 0 ? ils(s.bookedRevenue) : "—" },
    ];
    health = null;

    const byWorker = new Map<string, { latest: (typeof events)[number]; today: number }>();
    for (const e of events) {
      // events arrive newest-first, so the first hit per worker is its latest
      const w = byWorker.get(e.worker);
      if (!w) byWorker.set(e.worker, { latest: e, today: e.ts.startsWith(today) ? 1 : 0 });
      else if (e.ts.startsWith(today)) w.today++;
    }
    workers = [...byWorker.entries()].map(([name, v]) => ({
      id: name,
      name,
      role: ROLE_BY_WORKER[name] ?? "Autonomous agent",
      status: (Date.now() - Date.parse(v.latest.ts) < 86_400_000 ? "active" : "idle") as WorkerStatus,
      lastAction: v.latest.message,
      metric: { label: "Actions today", value: String(v.today) },
    }));
  }

  return (
    <div className="space-y-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Mission Control
      </Link>

      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl border border-border bg-card/60 grid place-items-center">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              {dept.director}
            </div>
            <h1 className="mt-1 text-2xl md:text-3xl font-semibold tracking-tight">{dept.name}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{dept.tagline}</p>
          </div>
        </div>
        {health != null && (
          <Badge variant={health >= 92 ? "success" : health >= 85 ? "info" : "warning"}>
            Health {health}
          </Badge>
        )}
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        {kpis.map((k) => (
          <Card key={k.label} className="p-4">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {k.label}
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tracking-tight">{k.value}</span>
              {k.delta && (
                <span
                  className={cn(
                    "text-[11px] font-medium",
                    k.delta.startsWith("-")
                      ? "text-[hsl(var(--danger))]"
                      : "text-[hsl(var(--success))]",
                  )}
                >
                  {k.delta}
                </span>
              )}
            </div>
          </Card>
        ))}
      </section>

      {dept.id === "revenue" && <PricingPanel />}

      <section className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle>Active workers</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Each worker reports status, last meaningful action, and a headline metric.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {workers.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No agent actions logged yet — workers appear here as they act (e.g. the Pricing
                Specialist pushing rates to MiniHotel).
              </p>
            )}
            {workers.map((w) => (
              <div
                key={w.id}
                className="rounded-lg border border-border/70 bg-background/40 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex items-start gap-3 min-w-0">
                    <CircleDot
                      className={cn(
                        "mt-0.5 h-3.5 w-3.5 shrink-0",
                        w.status === "active" && "text-[hsl(var(--success))] animate-pulse-dot",
                        w.status === "idle" && "text-muted-foreground",
                        w.status === "attention" && "text-[hsl(var(--warning))]",
                      )}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold tracking-tight">{w.name}</div>
                      <div className="text-[11px] text-muted-foreground">{w.role}</div>
                    </div>
                  </div>
                  <Badge variant={STATUS_VARIANT[w.status]}>{STATUS_LABEL[w.status]}</Badge>
                </div>
                <p className="mt-3 text-[12px] text-muted-foreground leading-relaxed">
                  {w.lastAction}
                </p>
                <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {w.metric.label}
                  <span className="font-mono normal-case text-foreground/90">
                    {w.metric.value}
                  </span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="self-start">
          <CardHeader className="pb-3">
            <CardTitle>Department feed</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              {events.length} recent events scoped to {dept.name}.
            </p>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-xs text-muted-foreground">No recent events.</p>
            ) : (
              <ul className="space-y-3">
                {events.map((e) => (
                  <li key={e.id} className="rounded-lg border border-border/70 bg-background/30 p-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium">{e.worker}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {formatRelative(e.ts)}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
                      {e.message}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
