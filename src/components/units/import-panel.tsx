"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Trash2, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface UnitDto {
  id: string;
  name: string;
  neighborhood: string;
  bedrooms: number;
  baseRate: number;
  currentRate: number;
  occupancy30d: number;
  platform: string;
}

type FieldKey =
  | "id"
  | "name"
  | "neighborhood"
  | "bedrooms"
  | "baseRate"
  | "currentRate"
  | "occupancy30d"
  | "platform";

interface ParsedUnit {
  id: string | null;
  name: string;
  neighborhood: string;
  bedrooms: number;
  baseRate: number;
  currentRate: number;
  occupancy30d: number;
  platform: string;
}

interface ImportRow {
  line: number;
  status: "create" | "update" | "error";
  id?: string;
  name?: string;
  error?: string;
  unit?: ParsedUnit;
}

interface ImportResult {
  committed: boolean;
  delimiter: string;
  headers: string[];
  mapping: Record<string, string | null>;
  present: FieldKey[];
  unmapped: string[];
  total: number;
  valid: number;
  errors: number;
  created: number;
  updated: number;
  rows: ImportRow[];
}

const FIELD_LABEL: Record<FieldKey, string> = {
  id: "id",
  name: "name",
  neighborhood: "neighborhood",
  bedrooms: "bedrooms",
  baseRate: "base rate",
  currentRate: "current rate",
  occupancy30d: "occupancy",
  platform: "platform",
};

const input =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";

const STATUS_VARIANT: Record<ImportRow["status"], "success" | "warning" | "danger"> = {
  create: "success",
  update: "warning",
  error: "danger",
};

const PLACEHOLDER = `Paste here — e.g. copy the rows straight out of Google Sheets:

Name\tNeighborhood\tBedrooms\tNightly\tOccupancy\tPlatform
Rothschild 14 · Studio\tLev HaIr\tStudio\t720\t91%\tBlueground
Shabazi 41 · 2BR\tNeve Tzedek\t2\t1180\t94%\tBlueground`;

export function ImportPanel() {
  const [units, setUnits] = useState<UnitDto[]>([]);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/units", { cache: "no-store" });
    const body = (await res.json()) as { units: UnitDto[] };
    setUnits(body.units);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live (debounced) dry-run preview as the operator pastes/edits.
  useEffect(() => {
    if (!text.trim()) {
      setPreview(null);
      setError(null);
      return;
    }
    const t = setTimeout(async () => {
      setPreviewing(true);
      setError(null);
      try {
        const res = await fetch("/api/units/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, commit: false }),
        });
        if (!res.ok) throw new Error(`preview failed (${res.status})`);
        setPreview((await res.json()) as ImportResult);
      } catch (e) {
        setError(e instanceof Error ? e.message : "preview failed");
        setPreview(null);
      } finally {
        setPreviewing(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [text]);

  async function runImport() {
    if (!preview || preview.valid === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await fetch("/api/units/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, commit: true }),
      });
      if (!res.ok) throw new Error(`import failed (${res.status})`);
      const body = (await res.json()) as ImportResult;
      setDone(
        `Imported ${body.created + body.updated} propert${
          body.created + body.updated === 1 ? "y" : "ies"
        } · ${body.created} created · ${body.updated} updated` +
          (body.errors ? ` · ${body.errors} skipped` : ""),
      );
      setText("");
      setPreview(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "import failed");
    } finally {
      setImporting(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setDone(null);
    setText(await file.text());
  }

  async function remove(u: UnitDto) {
    if (!confirm(`Remove "${u.name}" (${u.id}) and its pricing history?`)) return;
    setBusyId(u.id);
    setError(null);
    try {
      const res = await fetch(`/api/units/${encodeURIComponent(u.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`delete failed (${res.status})`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    } finally {
      setBusyId(null);
    }
  }

  const nameMissing = preview != null && preview.mapping.name == null && preview.total > 0;

  return (
    <div className="space-y-6">
      {error && <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>}
      {done && (
        <p className="inline-flex items-center gap-1.5 text-[11px] text-[hsl(var(--success))]">
          <CheckCircle2 className="h-3.5 w-3.5" /> {done}
        </p>
      )}

      {/* ------------------------------------------------------------ import */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Import from a spreadsheet</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Paste rows from Google Sheets (or upload a CSV). The first row is read as headers and
            mapped to the portfolio fields automatically — a Name column is the only requirement.
            Re-importing the same sheet updates rows in place (matched by id, else by name).
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btn} onClick={() => fileRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" /> Upload CSV
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <span className="text-[10px] text-muted-foreground">or paste below</span>
            {previewing && (
              <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> reading…
              </span>
            )}
          </div>

          <textarea
            className={`${input} w-full font-mono leading-relaxed`}
            rows={7}
            placeholder={PLACEHOLDER}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDone(null);
            }}
          />

          {preview && (
            <div className="space-y-3 rounded-lg border border-border bg-background/40 p-3">
              {/* column mapping */}
              <div>
                <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Detected columns · {preview.delimiter === "tab" ? "tab-separated" : "comma-separated"}
                </div>
                {nameMissing ? (
                  <p className="text-[11px] text-[hsl(var(--danger))]">
                    Couldn&apos;t find a <strong>Name</strong> column. Headers seen:{" "}
                    {preview.headers.join(", ") || "(none)"}.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {preview.present.map((f) => (
                      <Badge key={f} variant="info" className="normal-case">
                        {FIELD_LABEL[f]} ← {preview.mapping[f]}
                      </Badge>
                    ))}
                    {preview.unmapped.length > 0 && (
                      <Badge variant="muted" className="normal-case">
                        ignored: {preview.unmapped.join(", ")}
                      </Badge>
                    )}
                  </div>
                )}
              </div>

              {/* row plan */}
              {preview.total > 0 && (
                <>
                  <div className="text-[11px] text-muted-foreground">
                    <span className="text-[hsl(var(--success))]">{preview.created} to create</span>
                    {" · "}
                    <span className="text-[hsl(var(--warning))]">{preview.updated} to update</span>
                    {preview.errors > 0 && (
                      <>
                        {" · "}
                        <span className="text-[hsl(var(--danger))]">{preview.errors} skipped</span>
                      </>
                    )}
                  </div>
                  <div className="max-h-64 overflow-auto rounded-md border border-border/70">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 bg-muted/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1.5 text-left">#</th>
                          <th className="px-2 py-1.5 text-left"></th>
                          <th className="px-2 py-1.5 text-left">Name</th>
                          <th className="px-2 py-1.5 text-left">Hood</th>
                          <th className="px-2 py-1.5 text-right">BR</th>
                          <th className="px-2 py-1.5 text-right">Base</th>
                          <th className="px-2 py-1.5 text-right">Current</th>
                          <th className="px-2 py-1.5 text-right">Occ</th>
                          <th className="px-2 py-1.5 text-left">Platform</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.slice(0, 200).map((r) => (
                          <tr key={r.line} className="border-t border-border/50">
                            <td className="px-2 py-1 text-muted-foreground">{r.line}</td>
                            <td className="px-2 py-1">
                              <Badge variant={STATUS_VARIANT[r.status]}>
                                {r.status === "create"
                                  ? "new"
                                  : r.status === "update"
                                    ? "update"
                                    : "skip"}
                              </Badge>
                            </td>
                            {r.unit ? (
                              <>
                                <td className="px-2 py-1 font-medium">{r.unit.name}</td>
                                <td className="px-2 py-1 text-muted-foreground">
                                  {r.unit.neighborhood || "—"}
                                </td>
                                <td className="px-2 py-1 text-right font-mono">{r.unit.bedrooms}</td>
                                <td className="px-2 py-1 text-right font-mono">
                                  ₪{r.unit.baseRate}
                                </td>
                                <td className="px-2 py-1 text-right font-mono">
                                  ₪{r.unit.currentRate}
                                </td>
                                <td className="px-2 py-1 text-right font-mono">
                                  {(r.unit.occupancy30d * 100).toFixed(0)}%
                                </td>
                                <td className="px-2 py-1 text-muted-foreground">
                                  {r.unit.platform}
                                </td>
                              </>
                            ) : (
                              <td
                                className="px-2 py-1 text-[hsl(var(--danger))]"
                                colSpan={7}
                              >
                                {r.error}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {preview.rows.length > 200 && (
                      <div className="border-t border-border/50 px-2 py-1 text-[10px] text-muted-foreground">
                        + {preview.rows.length - 200} more rows
                      </div>
                    )}
                  </div>
                </>
              )}

              <button
                type="button"
                className={btn}
                disabled={importing || previewing || preview.valid === 0}
                onClick={runImport}
              >
                {importing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                Import {preview.valid} propert{preview.valid === 1 ? "y" : "ies"}
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------- current */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Portfolio · {units.length} propert{units.length === 1 ? "y" : "ies"}</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            What the Pricing Specialist and the rest of the Revenue &amp; Yield department operate on.
          </p>
        </CardHeader>
        <CardContent>
          {units.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No properties yet — import your sheet above.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Property</th>
                    <th className="px-3 py-2 text-left">Hood</th>
                    <th className="px-3 py-2 text-right">BR</th>
                    <th className="px-3 py-2 text-right">Base</th>
                    <th className="px-3 py-2 text-right">Current</th>
                    <th className="px-3 py-2 text-right">Occ 30d</th>
                    <th className="px-3 py-2 text-left">Platform</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {units.map((u) => (
                    <tr key={u.id} className="border-t border-border/60">
                      <td className="px-3 py-2">
                        <div className="font-medium">{u.name}</div>
                        <div className="text-[10px] text-muted-foreground">{u.id}</div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{u.neighborhood || "—"}</td>
                      <td className="px-3 py-2 text-right font-mono">{u.bedrooms}</td>
                      <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                        ₪{u.baseRate}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">
                        ₪{u.currentRate}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {(u.occupancy30d * 100).toFixed(0)}%
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{u.platform}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          disabled={busyId === u.id}
                          onClick={() => remove(u)}
                          className={cn(
                            "text-muted-foreground hover:text-[hsl(var(--danger))] disabled:opacity-40",
                          )}
                          title="Remove property"
                        >
                          {busyId === u.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
