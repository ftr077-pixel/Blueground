import { FileText } from "lucide-react";

export function SpecViewer({ markdown }: { markdown: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/60 overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/80 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <FileText className="h-3.5 w-3.5 text-primary" />
          <span className="text-xs font-semibold tracking-tight">spec.md</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            requirements contract
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {markdown.split("\n").length} lines · ground truth
        </span>
      </div>
      <pre className="px-4 py-3 text-[11px] leading-relaxed font-mono max-h-[640px] overflow-y-auto whitespace-pre-wrap">
        {markdown}
      </pre>
    </div>
  );
}
