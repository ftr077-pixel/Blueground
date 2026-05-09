"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Banknote,
  Boxes,
  ConciergeBell,
  CornerDownLeft,
  GitBranch,
  LayoutDashboard,
  Search,
  ShieldAlert,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DEPARTMENTS } from "@/lib/mock-data";

interface PaletteItem {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  href: string;
  hint?: string;
}

const STATIC_ITEMS: PaletteItem[] = [
  {
    id: "nav-mc",
    label: "Mission Control",
    group: "Pages",
    icon: LayoutDashboard,
    href: "/",
    hint: "Global overview",
  },
  {
    id: "nav-syn",
    label: "Synthesis View",
    group: "Pages",
    icon: GitBranch,
    href: "/synthesis",
    hint: "Player ↔ Coach loop",
  },
  {
    id: "nav-ac",
    label: "Action Center",
    group: "Pages",
    icon: ShieldAlert,
    href: "/action-center",
    hint: "Human approvals",
  },
];

const DEPT_ICONS: Record<string, LucideIcon> = {
  revenue: Banknote,
  logistics: Boxes,
  guest: ConciergeBell,
  growth: TrendingUp,
};

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const deptItems: PaletteItem[] = DEPARTMENTS.map((d) => ({
      id: `dept-${d.id}`,
      label: d.name,
      group: "Departments",
      icon: DEPT_ICONS[d.id] ?? LayoutDashboard,
      href: `/departments/${d.id}`,
      hint: d.director,
    }));
    const workerItems: PaletteItem[] = DEPARTMENTS.flatMap((d) =>
      d.workers.map((w) => ({
        id: `worker-${w.id}`,
        label: w.name,
        group: "Workers",
        icon: Users,
        href: `/departments/${d.id}`,
        hint: `${d.name} · ${w.role}`,
      })),
    );
    return [...STATIC_ITEMS, ...deptItems, ...workerItems];
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        i.group.toLowerCase().includes(q) ||
        (i.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [items, query]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("rohub:open-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("rohub:open-palette", onOpen);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 10);
      return () => window.clearTimeout(t);
    }
    setQuery("");
  }, [open]);

  if (!open) return null;

  const grouped: Record<string, PaletteItem[]> = {};
  filtered.forEach((i) => {
    (grouped[i.group] ||= []).push(i);
  });
  const flatOrder: PaletteItem[] = filtered;

  const onArrow = (delta: number) => {
    setActive((a) => {
      if (flatOrder.length === 0) return 0;
      return (a + delta + flatOrder.length) % flatOrder.length;
    });
  };

  const choose = (item: PaletteItem) => {
    setOpen(false);
    router.push(item.href);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
    >
      <div
        className="absolute inset-0 bg-background/70 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />
      <div className="relative w-full max-w-xl rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                onArrow(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                onArrow(-1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                const item = flatOrder[active];
                if (item) choose(item);
              }
            }}
            placeholder="Jump to a page, department, or worker…"
            className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground/70 focus:outline-none"
          />
          <kbd className="rounded border border-border bg-muted px-1.5 text-[10px] text-muted-foreground">
            ESC
          </kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-2">
          {flatOrder.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              No results for &quot;{query}&quot;.
            </div>
          ) : (
            Object.entries(grouped).map(([group, list]) => (
              <div key={group} className="px-2 pb-2">
                <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {group}
                </div>
                <ul>
                  {list.map((i) => {
                    const idx = flatOrder.indexOf(i);
                    const isActive = idx === active;
                    const Icon = i.icon;
                    return (
                      <li key={i.id}>
                        <button
                          type="button"
                          onMouseEnter={() => setActive(idx)}
                          onClick={() => choose(i)}
                          className={cn(
                            "group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm",
                            isActive
                              ? "bg-primary/10 text-foreground"
                              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                          )}
                        >
                          <Icon
                            className={cn(
                              "h-4 w-4 shrink-0",
                              isActive
                                ? "text-primary"
                                : "text-muted-foreground group-hover:text-foreground",
                            )}
                          />
                          <span className="truncate">{i.label}</span>
                          {i.hint && (
                            <span className="ml-auto truncate text-[11px] text-muted-foreground">
                              {i.hint}
                            </span>
                          )}
                          {isActive && (
                            <CornerDownLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
          <span>
            <kbd className="rounded border border-border bg-muted px-1">↑</kbd>{" "}
            <kbd className="rounded border border-border bg-muted px-1">↓</kbd> to navigate
          </span>
          <span>
            <kbd className="rounded border border-border bg-muted px-1">↵</kbd> to open
          </span>
        </div>
      </div>
    </div>
  );
}
