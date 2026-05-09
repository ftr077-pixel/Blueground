"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TerminalLine } from "@/lib/synthesis-data";

const TICK_MS = 320;
const INITIAL_LINES = 6;

export function Terminal({ lines }: { lines: TerminalLine[] }) {
  const [visible, setVisible] = useState(() => Math.min(INITIAL_LINES, lines.length));
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (visible >= lines.length) return;
    const t = window.setTimeout(() => setVisible((v) => v + 1), TICK_MS);
    return () => window.clearTimeout(t);
  }, [visible, lines.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible]);

  const shown = lines.slice(0, visible);
  const streaming = visible < lines.length;

  return (
    <div className="rounded-xl border border-border bg-[#06090f] overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/80 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
          </span>
          <span className="ml-2 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <TerminalIcon className="h-3 w-3" />
            sandbox · /workspace/rental-orchestrator-hub
          </span>
        </div>
        <span
          className={cn(
            "flex items-center gap-1.5 text-[10px] uppercase tracking-wider",
            streaming ? "text-success" : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              streaming ? "bg-success animate-pulse-dot" : "bg-muted-foreground/60",
            )}
          />
          {streaming ? "streaming" : "idle"}
        </span>
      </div>
      <pre
        ref={scrollRef}
        className="px-3 py-3 text-[11px] leading-relaxed font-mono max-h-[480px] overflow-y-auto"
      >
        {shown.map((l) => (
          <div key={l.id} className="grid grid-cols-[60px_1fr] gap-3">
            <span className="text-muted-foreground/70">{l.ts}</span>
            <span
              className={cn(
                l.stream === "stderr" && "text-[hsl(var(--warning))]",
                l.stream === "system" && "text-primary",
                l.stream === "stdout" && "text-foreground/90",
              )}
            >
              {l.text}
            </span>
          </div>
        ))}
        <div className="mt-1 grid grid-cols-[60px_1fr] gap-3">
          <span className="text-muted-foreground/70">--:--.---</span>
          <span className="text-foreground/80">
            $ <span className="inline-block h-3 w-1.5 align-baseline bg-foreground/80 animate-pulse-dot" />
          </span>
        </div>
      </pre>
    </div>
  );
}
