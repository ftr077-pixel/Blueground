import { Building2, GitBranch, ShieldCheck, Users } from "lucide-react";
import { ActivityFeed } from "@/components/activity-feed";
import { DepartmentCard } from "@/components/department-card";
import { StatTile } from "@/components/stat-tile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DEPARTMENTS, PORTFOLIO_SUMMARY } from "@/lib/mock-data";
import { listActivity } from "@/lib/repos/activity";
import { listPending } from "@/lib/repos/action-center";

export const dynamic = "force-dynamic";

export default function MissionControlPage() {
  const events = listActivity(50);
  const pendingApprovals = listPending().length;
  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-dot" />
              Live · Tel Aviv portfolio
            </span>
            <Badge variant="info">Autonomous</Badge>
          </div>
          <h1 className="mt-2 text-2xl md:text-3xl font-semibold tracking-tight">
            Global Mission Control
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Four Digital Middle Manager departments are running the Mid-Term Rental portfolio.
            Monitor health, surface anomalies, and inspect what each autonomous worker is doing
            right now.
          </p>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={Building2}
          label="Units live"
          value={PORTFOLIO_SUMMARY.unitsLive}
          hint={`${PORTFOLIO_SUMMARY.unitsOnboarding} onboarding this week`}
        />
        <StatTile
          icon={Users}
          label="Agents online"
          value={PORTFOLIO_SUMMARY.agentsOnline}
          hint="Across 4 departments"
          accent="text-[hsl(var(--success))]"
        />
        <StatTile
          icon={ShieldCheck}
          label="Avg. dept health"
          value={`${PORTFOLIO_SUMMARY.avgHealth}`}
          hint="Composite of KPIs + QC"
          accent="text-[hsl(var(--success))]"
        />
        <StatTile
          icon={GitBranch}
          label="Awaiting human"
          value={pendingApprovals}
          hint="Items in Action Center"
          accent="text-[hsl(var(--warning))]"
        />
      </section>

      <section className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight uppercase text-muted-foreground">
              Departments
            </h2>
            <span className="text-[11px] text-muted-foreground">
              4 directors · {DEPARTMENTS.reduce((s, d) => s + d.workers.length, 0)} active workers
            </span>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {DEPARTMENTS.map((d) => (
              <DepartmentCard key={d.id} dept={d} />
            ))}
          </div>
        </div>

        <Card className="xl:sticky xl:top-4 self-start">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle>Middle Manager Activity</CardTitle>
              <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-dot" />
                Live feed
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Stream of decisions, dispatches, and exceptions across all departments.
            </p>
          </CardHeader>
          <CardContent className="max-h-[640px] overflow-y-auto pr-2">
            <ActivityFeed events={events} />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
