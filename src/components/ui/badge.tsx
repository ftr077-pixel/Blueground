import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "success" | "warning" | "danger" | "info" | "muted";

const VARIANTS: Record<Variant, string> = {
  default: "bg-muted text-foreground",
  success: "bg-success/15 text-[hsl(var(--success))] border border-success/20",
  warning: "bg-warning/15 text-[hsl(var(--warning))] border border-warning/20",
  danger: "bg-danger/15 text-[hsl(var(--danger))] border border-danger/20",
  info: "bg-primary/15 text-primary border border-primary/20",
  muted: "bg-muted/60 text-muted-foreground border border-border",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
