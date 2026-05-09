import {
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { ACTIVITY_FEED, DEPARTMENTS, type ActivityEvent } from "@/lib/mock-data";
import { cn, formatRelative } from "@/lib/utils";

const LEVEL_META: Record<
  ActivityEvent["level"],
  { icon: LucideIcon; color: string; bg: string }
> = {
  info: { icon: Info, color: "text-primary", bg: "bg-primary/10 border-primary/20" },
  success: {
    icon: CheckCircle2,
    color: "text-[hsl(var(--success))]",
    bg: "bg-success/10 border-success/20",
  },
  warning: {
    icon: AlertTriangle,
    color: "text-[hsl(var(--warning))]",
    bg: "bg-warning/10 border-warning/20",
  },
  danger: {
    icon: XCircle,
    color: "text-[hsl(var(--danger))]",
    bg: "bg-danger/10 border-danger/20",
  },
};

export function ActivityFeed() {
  const deptName = (id: ActivityEvent["department"]) =>
    DEPARTMENTS.find((d) => d.id === id)?.name ?? id;
  return (
    <ol className="relative space-y-3">
      <span className="absolute left-[15px] top-1 bottom-1 w-px bg-border/70" aria-hidden />
      {ACTIVITY_FEED.map((evt) => {
        const meta = LEVEL_META[evt.level];
        const Icon = meta.icon;
        return (
          <li key={evt.id} className="relative flex gap-3 pl-1">
            <span
              className={cn(
                "z-10 mt-0.5 grid h-7 w-7 place-items-center rounded-full border",
                meta.bg,
              )}
            >
              <Icon className={cn("h-3.5 w-3.5", meta.color)} />
            </span>
            <div className="flex-1 min-w-0 pb-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-xs font-medium">{evt.worker}</span>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {deptName(evt.department)}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {formatRelative(evt.ts)}
                </span>
              </div>
              <p className="mt-0.5 text-[12px] text-muted-foreground leading-snug">
                {evt.message}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
