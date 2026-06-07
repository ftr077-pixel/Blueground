"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const input =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";

interface Row {
  unitId: string;
  name: string;
  neighborhood: string;
  platform: string;
  roomType: string | null;
}

export function MiniHotelMappingCard() {
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    fetch("/api/integrations/minihotel/mapping", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { rows: Row[] }) => {
        setRows(d.rows);
        const next: Record<string, string> = {};
        for (const r of d.rows) next[r.unitId] = r.roomType ?? "";
        setDraft(next);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => load(), [load]);

  async function save() {
    setBusy(true);
    try {
      const mappings = Object.entries(draft).map(([unitId, roomType]) => ({ unitId, roomType }));
      await fetch("/api/integrations/minihotel/mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      load();
    } finally {
      setBusy(false);
    }
  }

  const mapped = Object.values(draft).filter((v) => v.trim()).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4" /> Apartment mapping
          </CardTitle>
          <Badge variant={mapped === rows.length && rows.length > 0 ? "success" : "muted"}>
            {mapped}/{rows.length} mapped
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Connect each apartment in this app to its MiniHotel room-type code. The two systems use
          different names, so this link is how MiniHotel knows which listing is which when we read rates
          or push prices.
        </p>
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Apartment (this app)</th>
                  <th className="py-2 pr-3 font-medium">Neighborhood</th>
                  <th className="py-2 pr-3 font-medium">MiniHotel room-type code</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.unitId} className="border-b border-border/40">
                    <td className="py-1.5 pr-3">
                      <div className="font-medium text-foreground">{r.name}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {r.unitId} · {r.platform}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{r.neighborhood}</td>
                    <td className="py-1.5 pr-3">
                      <input
                        className={`${input} w-44`}
                        value={draft[r.unitId] ?? ""}
                        placeholder="e.g. DBL, 2BEDAPT"
                        onChange={(e) => setDraft((d) => ({ ...d, [r.unitId]: e.target.value }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button type="button" disabled={busy || !loaded} onClick={save} className={btn}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saved ? "Saved ✓" : "Save mapping"}
          </button>
          <span className="text-[10px] text-muted-foreground">
            Codes come from MiniHotel (Rates &amp; Availability / room-type setup).
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
