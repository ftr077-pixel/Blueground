import { Bot, ClipboardCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn, formatRelative } from "@/lib/utils";
import type { SynthesisTurn } from "@/lib/synthesis-data";

const ARTIFACT_LABEL: Record<NonNullable<SynthesisTurn["artifacts"]>[number]["kind"], string> = {
  bash: "terminal",
  code: "diff",
  checklist: "checklist",
  verdict: "verdict",
};

export function TurnFeed({ turns }: { turns: SynthesisTurn[] }) {
  return (
    <ol className="space-y-4">
      {turns.map((t) => {
        const isCoach = t.role === "coach";
        const Icon = isCoach ? ClipboardCheck : Bot;
        return (
          <li
            key={t.id}
            className={cn(
              "rounded-xl border bg-card/60 p-4",
              isCoach ? "border-primary/25" : "border-border",
            )}
          >
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  "h-8 w-8 shrink-0 rounded-lg grid place-items-center border",
                  isCoach
                    ? "bg-primary/15 border-primary/30 text-primary"
                    : "bg-muted/40 border-border",
                )}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-xs font-semibold tracking-tight">
                    {isCoach ? "Coach" : "Player"} · Turn {t.turn}
                  </span>
                  <Badge variant={isCoach ? "info" : "muted"}>
                    {isCoach ? "Validation" : "Execution"}
                  </Badge>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {formatRelative(t.ts)}
                  </span>
                </div>
                <div className="mt-1 text-sm">{t.title}</div>
                <p className="mt-1 text-[12px] text-muted-foreground leading-snug">
                  {t.summary}
                </p>
                {t.artifacts && t.artifacts.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {t.artifacts.map((a, idx) => (
                      <div
                        key={idx}
                        className={cn(
                          "rounded-lg border bg-background/60 text-[11px]",
                          a.kind === "verdict"
                            ? a.body.startsWith("FINAL STATUS")
                              ? "border-success/30"
                              : "border-warning/30"
                            : "border-border",
                        )}
                      >
                        <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            {ARTIFACT_LABEL[a.kind]}
                          </span>
                        </div>
                        <pre className="whitespace-pre-wrap break-words font-mono px-3 py-2 leading-relaxed">
                          {a.body}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
