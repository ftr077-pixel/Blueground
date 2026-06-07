"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Banknote,
  BarChart3,
  Boxes,
  ChevronDown,
  ConciergeBell,
  LayoutDashboard,
  Radar,
  ShieldAlert,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Item = { href: string; label: string; icon: typeof Activity };

const OPS_TOP: Item[] = [{ href: "/", label: "Mission Control", icon: LayoutDashboard }];

const REVENUE_HUB = {
  label: "Revenue & Yield",
  icon: Banknote,
  base: "/visibility",
  children: [
    { href: "/visibility/overview", label: "Overview", icon: LayoutDashboard },
    { href: "/visibility", label: "Search Visibility", icon: Radar },
    { href: "/visibility/profitability", label: "Profitability", icon: Banknote },
    { href: "/visibility/analytics", label: "Position Trends", icon: TrendingUp },
    { href: "/visibility/pricing", label: "Pricing vs Rank", icon: BarChart3 },
    { href: "/visibility/portfolio", label: "Portfolio", icon: Boxes },
  ] as Item[],
};

const OPS_BOTTOM: Item[] = [
  { href: "/pnl", label: "P&L Forecast", icon: Wallet },
  { href: "/action-center", label: "Action Center", icon: ShieldAlert },
];

const NAV_DEPARTMENTS: Item[] = [
  { href: "/departments/logistics", label: "Logistics & QC", icon: Boxes },
  { href: "/departments/guest", label: "Guest Relations", icon: ConciergeBell },
  { href: "/departments/growth", label: "Growth & Sourcing", icon: TrendingUp },
];

const ALL_HREFS = [...OPS_TOP, ...REVENUE_HUB.children, ...OPS_BOTTOM, ...NAV_DEPARTMENTS].map(
  (i) => i.href,
);

export function Sidebar() {
  const pathname = usePathname();
  // Highlight the single best (longest) matching route so a parent never stays
  // lit when you're on a more specific child.
  const activeHref =
    ALL_HREFS.filter((h) => pathname === h || (h !== "/" && pathname.startsWith(h))).sort(
      (a, b) => b.length - a.length,
    )[0] ?? "";

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
        <div>
          <SectionLabel>Operations</SectionLabel>
          <ul className="space-y-1">
            {OPS_TOP.map((i) => (
              <NavItem key={i.href} item={i} activeHref={activeHref} />
            ))}
            <NavHub hub={REVENUE_HUB} pathname={pathname} activeHref={activeHref} />
            {OPS_BOTTOM.map((i) => (
              <NavItem key={i.href} item={i} activeHref={activeHref} />
            ))}
          </ul>
        </div>
        <div>
          <SectionLabel>Digital Middle Managers</SectionLabel>
          <ul className="space-y-1">
            {NAV_DEPARTMENTS.map((i) => (
              <NavItem key={i.href} item={i} activeHref={activeHref} />
            ))}
          </ul>
        </div>
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
            Autonomous departments · agents monitoring live.
          </p>
        </div>
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </div>
  );
}

function NavItem({ item, activeHref }: { item: Item; activeHref: string }) {
  const active = item.href === activeHref;
  const Icon = item.icon;
  return (
    <li>
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
}

function NavHub({
  hub,
  pathname,
  activeHref,
}: {
  hub: typeof REVENUE_HUB;
  pathname: string;
  activeHref: string;
}) {
  const within = pathname === hub.base || pathname.startsWith(hub.base);
  const [open, setOpen] = useState(within);
  useEffect(() => {
    if (within) setOpen(true);
  }, [within]);
  const Icon = hub.icon;

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "group flex w-full items-center gap-3 rounded-md px-2.5 py-2 transition-colors",
          within
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
        )}
      >
        <Icon
          className={cn(
            "h-4 w-4 shrink-0",
            within ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
          )}
        />
        <span className="truncate">{hub.label}</span>
        <ChevronDown
          className={cn("ml-auto h-3.5 w-3.5 shrink-0 transition-transform", open ? "" : "-rotate-90")}
        />
      </button>
      {open && (
        <ul className="ml-3 mt-1 space-y-1 border-l border-border/60 pl-3">
          {hub.children.map((c) => {
            const active = c.href === activeHref;
            return (
              <li key={c.href}>
                <Link
                  href={c.href}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                    active
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      active ? "bg-primary" : "bg-muted-foreground/40",
                    )}
                  />
                  <span className="truncate">{c.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
