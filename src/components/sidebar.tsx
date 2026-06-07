"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Banknote,
  BarChart3,
  Boxes,
  ConciergeBell,
  GitBranch,
  LayoutDashboard,
  Radar,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_PRIMARY = [
  { href: "/", label: "Mission Control", icon: LayoutDashboard },
  { href: "/synthesis", label: "Synthesis View", icon: GitBranch },
  { href: "/visibility", label: "Search Visibility", icon: Radar },
  { href: "/visibility/analytics", label: "Visibility Analytics", icon: BarChart3 },
  { href: "/action-center", label: "Action Center", icon: ShieldAlert },
];

const NAV_DEPARTMENTS = [
  { href: "/departments/revenue", label: "Revenue & Yield", icon: Banknote },
  { href: "/departments/logistics", label: "Logistics & QC", icon: Boxes },
  { href: "/departments/guest", label: "Guest Relations", icon: ConciergeBell },
  { href: "/departments/growth", label: "Growth & Sourcing", icon: TrendingUp },
];

export function Sidebar() {
  const pathname = usePathname();
  // Highlight the single best (longest) matching route, so a parent like
  // /visibility doesn't stay lit when you're on /visibility/analytics.
  const allItems = [...NAV_PRIMARY, ...NAV_DEPARTMENTS];
  const activeHref =
    allItems
      .filter((i) => pathname === i.href || (i.href !== "/" && pathname.startsWith(i.href)))
      .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? "";
  return (
    <aside className="hidden md:flex md:w-64 lg:w-72 shrink-0 flex-col border-r border-border bg-card/40">
      <div className="flex items-center gap-2 px-5 py-5 border-b border-border">
        <div className="relative h-9 w-9 rounded-lg bg-primary/15 flex items-center justify-center">
          <Activity className="h-5 w-5 text-primary" />
          <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-success animate-pulse-dot ring-2 ring-card" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-tight">Rental Orchestrator</span>
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Hub · Tel Aviv
          </span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6 text-sm">
        <NavSection label="Operations" items={NAV_PRIMARY} activeHref={activeHref} />
        <NavSection
          label="Digital Middle Managers"
          items={NAV_DEPARTMENTS}
          activeHref={activeHref}
        />
      </nav>

      <div className="border-t border-border px-4 py-4">
        <div className="rounded-lg bg-muted/40 px-3 py-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Orchestrator
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-dot" />
              ONLINE
            </span>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
            Dialectical loop · Player + Coach synthesis engaged.
          </p>
        </div>
      </div>
    </aside>
  );
}

function NavSection({
  label,
  items,
  activeHref,
}: {
  label: string;
  items: { href: string; label: string; icon: typeof Activity }[];
  activeHref: string;
}) {
  return (
    <div>
      <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <ul className="space-y-1">
        {items.map((item) => {
          const active = item.href === activeHref;
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  "group flex items-center gap-3 rounded-md px-2.5 py-2 transition-colors",
                  active
                    ? "bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                )}
              >
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
                  )}
                />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
