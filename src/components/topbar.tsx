import { Bell, Search } from "lucide-react";

export function Topbar() {
  return (
    <header className="flex h-14 items-center gap-3 border-b border-border bg-background/80 backdrop-blur px-4 md:px-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="hidden sm:inline">Mission Control</span>
        <span className="hidden sm:inline">/</span>
        <span className="text-foreground">Global Overview</span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div className="hidden md:flex items-center gap-2 rounded-md border border-border bg-card/60 px-2.5 py-1.5 text-xs text-muted-foreground w-72">
          <Search className="h-3.5 w-3.5" />
          <input
            placeholder="Search units, agents, tickets…"
            className="flex-1 bg-transparent placeholder:text-muted-foreground/70 focus:outline-none"
          />
          <kbd className="rounded border border-border px-1 text-[10px]">⌘K</kbd>
        </div>
        <button
          aria-label="Notifications"
          className="relative h-9 w-9 grid place-items-center rounded-md border border-border bg-card/40 hover:bg-muted/40"
        >
          <Bell className="h-4 w-4" />
          <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-warning" />
        </button>
        <div className="flex items-center gap-2 pl-2 border-l border-border">
          <div className="h-8 w-8 rounded-full bg-primary/20 grid place-items-center text-xs font-semibold text-primary">
            BG
          </div>
          <div className="hidden sm:flex flex-col leading-tight">
            <span className="text-xs font-medium">Operator</span>
            <span className="text-[10px] text-muted-foreground">Blueground · TLV</span>
          </div>
        </div>
      </div>
    </header>
  );
}
