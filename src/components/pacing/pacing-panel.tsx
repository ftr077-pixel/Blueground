"use client";

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Loader2, RefreshCw, Settings2 } from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// ----------------------------------------------------------- response mirror
type Aggregation = "daily" | "weekly" | "monthly";

interface PacingBucket {
  key: string;
  label: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  listed: number | null;
  mktOcc: number | null;
  mktOccLy: number | null;
  yourOcc: number | null;
  yourOccLy: number | null;
  unavailable: number | null;
  mktAdr: number | null;
  mktAdrLy: number | null;
  yourAdr: number | null;
  yourAdrLy: number | null;
  mktRevpar: number | null;
  mktRevparLy: number | null;
  yourRevpar: number | null;
  yourRevparLy: number | null;
}

interface CurvePoint {
  dtc: number;
  revenue: number;
  occ: number;
  adr: number | null;
  revpar: number;
}

interface BookingCurve {
  month: string;
  label: string;
  final: boolean;
  points: CurvePoint[];
}

interface PacingReport {
  from: string;
  to: string;
  agg: Aggregation;
  today: string;
  currency: string;
  rooms: number;
  dashboard: string | null;
  dashboards: { key: string; label: string; fetchedAt: string; filterLabel: string | null }[];
  compset: string;
  compsets: { id: string; label: string }[];
  buckets: PacingBucket[];
  thisBucket: string | null;
  curves: BookingCurve[];
  curveDefaults: string[];
  curveSource: "bookings" | "reservations" | null;
  sources: { market: boolean; compPrices: boolean; yours: "reservations" | "calendar" | null };
}

// ----------------------------------------------------------------- controls
interface Controls {
  agg: Aggregation;
  preset: string;
  from: string;
  to: string;
  dashboard: string; // "" = server default
  compset: string; // "" = server default, "none" = no compset
}

const LS_KEY = "pacing:controls:v1";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;

const isoAddDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const monthEnd = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};
const fullLabel = (key: string, agg: Aggregation) => {
  const [y, m, d] = key.split("-").map(Number);
  return agg === "monthly" ? `${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${d}, ${y}`;
};
const fmtRel = (iso: string) => {
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const AGG_OPTS: { v: Aggregation; l: string }[] = [
  { v: "daily", l: "Daily" },
  { v: "weekly", l: "Weekly" },
  { v: "monthly", l: "Monthly" },
];

const PRESETS = [
  { v: "p6f6", l: "Past 6 + next 6 months" },
  { v: "p12f6", l: "Past 12 + next 6 months" },
  { v: "next90", l: "Next 90 days" },
  { v: "next180", l: "Next 180 days" },
  { v: "next365", l: "Next 12 months" },
  { v: "custom", l: "Custom" },
];

function presetRange(v: string, today: string): { from: string; to: string } {
  const ym = today.slice(0, 7);
  switch (v) {
    case "p12f6":
      return { from: `${addMonths(ym, -12)}-01`, to: monthEnd(addMonths(ym, 6)) };
    case "next90":
      return { from: today, to: isoAddDays(today, 89) };
    case "next180":
      return { from: today, to: isoAddDays(today, 179) };
    case "next365":
      return { from: today, to: isoAddDays(today, 364) };
    default:
      return { from: `${addMonths(ym, -6)}-01`, to: monthEnd(addMonths(ym, 6)) };
  }
}

// ------------------------------------------------------------------- visuals
const GRID = "hsl(214 32% 91%)";
const AXIS = "hsl(215 16% 47%)";
const C = {
  mkt: "#ef4444",
  you: "#1e293b",
  youLy: "#94a3b8",
  listed: "#52525b",
  unavailable: "#94a3b8",
  band2550: "#cbd5e1",
  band5075: "#f87171",
  band7590: "#fda4af",
};
const LY_DASH = "7 3 2 3"; // dash-dot, like the PriceLabs last-year lines
const CURVE_COLORS = [
  "#0ea5e9",
  "#4338ca",
  "#16a34a",
  "#f97316",
  "#64748b",
  "#c084fc",
  "#14b8a6",
  "#d946ef",
  "#84cc16",
  "#f43f5e",
];

interface SeriesDef {
  k: string;
  label: string;
  color: string;
  dash?: string;
  kind?: "line" | "band";
}

const PRICE_SERIES: SeriesDef[] = [
  { k: "band2550", label: "Market 25th–50th percentile price", color: C.band2550, kind: "band" },
  { k: "band5075", label: "Market 50th–75th percentile price", color: C.band5075, kind: "band" },
  { k: "band7590", label: "Market 75th–90th percentile price", color: C.band7590, kind: "band" },
  { k: "listed", label: "Your Listed Price", color: C.listed, dash: "5 4" },
];
const OCC_SERIES: SeriesDef[] = [
  { k: "mktOcc", label: "Market Occupancy", color: C.mkt },
  { k: "mktOccLy", label: "Market Occupancy (last year)", color: C.mkt, dash: LY_DASH },
  { k: "yourOcc", label: "Your Occupancy", color: C.you },
  { k: "yourOccLy", label: "Your Occupancy (last year)", color: C.youLy, dash: LY_DASH },
  { k: "unavailable", label: "Calendar Unavailable", color: C.unavailable, dash: "3 3" },
];
const ADR_SERIES: SeriesDef[] = [
  { k: "mktAdr", label: "Market ADR", color: C.mkt },
  { k: "mktAdrLy", label: "Market ADR (last year)", color: C.mkt, dash: LY_DASH },
  { k: "yourAdr", label: "Your ADR", color: C.you },
  { k: "yourAdrLy", label: "Your ADR (last year)", color: C.youLy, dash: LY_DASH },
];
const REVPAR_SERIES: SeriesDef[] = [
  { k: "mktRevpar", label: "Market RevPAR", color: C.mkt },
  { k: "mktRevparLy", label: "Market RevPAR (last year)", color: C.mkt, dash: LY_DASH },
  { k: "yourRevpar", label: "Your RevPAR", color: C.you },
  { k: "yourRevparLy", label: "Your RevPAR (last year)", color: C.youLy, dash: LY_DASH },
];

function Swatch({ color, dash, band }: { color: string; dash?: string; band?: boolean }) {
  if (band) return <span className="inline-block h-2.5 w-4 rounded-[2px]" style={{ background: color }} />;
  return (
    <svg width="18" height="8" className="inline-block">
      <line x1="0" y1="4" x2="18" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dash} />
    </svg>
  );
}

function ToggleLegend({
  items,
  hidden,
  onToggle,
}: {
  items: SeriesDef[];
  hidden: Set<string>;
  onToggle: (k: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
      {items.map((s) => {
        const off = hidden.has(s.k);
        return (
          <button
            key={s.k}
            type="button"
            onClick={() => onToggle(s.k)}
            title={off ? "Show series" : "Hide series"}
            className={
              "inline-flex items-center gap-1.5 text-[11px] transition-colors " +
              (off ? "text-muted-foreground/60 line-through" : "text-muted-foreground hover:text-foreground")
            }
          >
            <Swatch color={s.color} dash={s.dash} band={s.kind === "band"} />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const selectCls =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs disabled:opacity-50";

function ChartBlock({
  yLabel,
  height = 240,
  empty,
  emptyHint,
  children,
}: {
  yLabel: string;
  height?: number;
  empty: boolean;
  emptyHint: string;
  children: ReactElement;
}) {
  if (empty) {
    return (
      <div className="grid h-32 place-items-center rounded-lg border border-dashed border-border">
        <p className="px-4 text-center text-[11px] text-muted-foreground">
          <span className="font-medium">{yLabel}:</span> {emptyHint}
        </p>
      </div>
    );
  }
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>{children}</ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------- main panel
export function PacingPanel() {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const defaultRange = presetRange("p6f6", today);
  const [controls, setControls] = useState<Controls>({
    agg: "monthly",
    preset: "p6f6",
    from: defaultRange.from,
    to: defaultRange.to,
    dashboard: "",
    compset: "",
  });
  const [remember, setRemember] = useState(false);
  const [report, setReport] = useState<PacingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Booking-curve month selection (the gear). null = not yet initialized.
  const [monthsSel, setMonthsSel] = useState<Set<string> | null>(null);
  const [gearOpen, setGearOpen] = useState(false);

  // Per-chart hidden series (legend toggling). Calendar Unavailable starts off,
  // like the struck-through legend entry in PriceLabs.
  const [hidden, setHidden] = useState<Set<string>>(new Set(["unavailable"]));
  const toggle = useCallback((k: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const fetchReport = useCallback(async (c: Controls) => {
    setLoading(true);
    setError(null);
    try {
      const range = c.preset === "custom" ? { from: c.from, to: c.to } : presetRange(c.preset, new Date().toISOString().slice(0, 10));
      const p = new URLSearchParams({ agg: c.agg, from: range.from, to: range.to });
      if (c.dashboard) p.set("dashboard", c.dashboard);
      if (c.compset) p.set("compset", c.compset);
      const res = await fetch(`/api/pacing?${p}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      const r = (await res.json()) as PacingReport;
      setReport(r);
      // Reflect the server-resolved defaults back into the selects.
      setControls((cur) => ({
        ...cur,
        from: r.from,
        to: r.to,
        dashboard: r.dashboard ?? "",
        compset: r.compset,
      }));
      setMonthsSel((cur) => cur ?? new Set(r.curveDefaults));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let init = controls;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { remember?: boolean; controls?: Partial<Controls> };
        if (saved?.remember && saved.controls) {
          init = { ...controls, ...saved.controls };
          setControls(init);
          setRemember(true);
        }
      }
    } catch {
      /* corrupted local state — fall through to defaults */
    }
    fetchReport(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update() {
    try {
      if (remember) localStorage.setItem(LS_KEY, JSON.stringify({ remember: true, controls }));
      else localStorage.removeItem(LS_KEY);
    } catch {
      /* storage unavailable — selection just won't persist */
    }
    fetchReport(controls);
  }

  const sym = report?.currency === "ILS" ? "₪" : report?.currency === "USD" ? "$" : "";
  const money = useCallback(
    (v: number) => `${sym}${Math.round(v).toLocaleString()}`,
    [sym],
  );
  const tip = useCallback(
    (kind: "money" | "pct") => (value: unknown) => {
      const f = (x: number) => (kind === "money" ? money(x) : `${x}%`);
      if (Array.isArray(value)) return `${f(Number(value[0]))} – ${f(Number(value[1]))}`;
      return typeof value === "number" ? f(value) : String(value ?? "—");
    },
    [money],
  );

  const agg = report?.agg ?? controls.agg;
  const data = useMemo(
    () =>
      (report?.buckets ?? []).map((b) => ({
        ...b,
        band2550: b.p25 != null && b.p50 != null ? ([b.p25, b.p50] as [number, number]) : null,
        band5075: b.p50 != null && b.p75 != null ? ([b.p50, b.p75] as [number, number]) : null,
        band7590: b.p75 != null && b.p90 != null ? ([b.p75, b.p90] as [number, number]) : null,
      })),
    [report],
  );
  const labelOf = useMemo(() => {
    const m = new Map((report?.buckets ?? []).map((b) => [b.key, b.label]));
    return (k: string) => m.get(k) ?? k;
  }, [report]);
  const hasAny = useCallback(
    (keys: string[]) =>
      (report?.buckets ?? []).some((b) =>
        keys.some((k) => (b as unknown as Record<string, unknown>)[k] != null),
      ),
    [report],
  );

  const curves = report?.curves ?? [];
  const selectedCurves = curves.filter((c) => monthsSel?.has(c.month) && c.points.length > 0);
  const curveColor = useMemo(() => {
    const m = new Map(curves.map((c, i) => [c.month, CURVE_COLORS[i % CURVE_COLORS.length]]));
    return (month: string) => m.get(month) ?? CURVE_COLORS[0];
  }, [curves]);

  const xAxisStay = (
    <XAxis
      dataKey="key"
      tick={{ fontSize: 10 }}
      stroke={AXIS}
      tickFormatter={labelOf}
      label={{ value: "Stay Date", position: "insideBottom", offset: -4, fontSize: 10, fill: AXIS }}
    />
  );
  const thisMonthLine = report?.thisBucket ? (
    <ReferenceLine
      x={report.thisBucket}
      stroke={AXIS}
      strokeOpacity={0.5}
      label={{ value: "This Month", angle: 90, position: "insideTopRight", fontSize: 9, fill: AXIS }}
    />
  ) : null;
  const stayTooltip = (kind: "money" | "pct") => (
    <Tooltip
      contentStyle={{ fontSize: 12 }}
      formatter={tip(kind)}
      labelFormatter={(k) => fullLabel(String(k), agg)}
    />
  );

  function lineChart(series: SeriesDef[], kind: "money" | "pct") {
    return (
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 12, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
        {xAxisStay}
        <YAxis
          tick={{ fontSize: 10 }}
          stroke={AXIS}
          domain={kind === "pct" ? [0, 100] : [0, "auto"]}
          unit={kind === "pct" ? "%" : undefined}
        />
        {stayTooltip(kind)}
        {thisMonthLine}
        {series.map((s) => (
          <Line
            key={s.k}
            dataKey={s.k}
            name={s.label}
            stroke={s.color}
            strokeWidth={s.k.startsWith("your") ? 2 : 1.8}
            strokeDasharray={s.dash}
            dot={false}
            connectNulls
            hide={hidden.has(s.k)}
          />
        ))}
      </ComposedChart>
    );
  }

  const dashboards = report?.dashboards ?? [];
  const compsets = report?.compsets ?? [];
  const activeDash = dashboards.find((d) => d.key === (report?.dashboard ?? ""));

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------- controls */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <Field label="Aggregation">
            <select
              className={selectCls}
              value={controls.agg}
              onChange={(e) => setControls({ ...controls, agg: e.target.value as Aggregation })}
            >
              {AGG_OPTS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date Selection">
            <select
              className={selectCls}
              value={controls.preset}
              onChange={(e) => {
                const preset = e.target.value;
                const r = preset === "custom" ? { from: controls.from, to: controls.to } : presetRange(preset, today);
                setControls({ ...controls, preset, ...r });
              }}
            >
              {PRESETS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.l}
                </option>
              ))}
            </select>
          </Field>
          {controls.preset === "custom" && (
            <>
              <Field label="From">
                <input
                  type="date"
                  className={selectCls}
                  value={controls.from}
                  onChange={(e) => setControls({ ...controls, from: e.target.value })}
                />
              </Field>
              <Field label="To">
                <input
                  type="date"
                  className={selectCls}
                  value={controls.to}
                  onChange={(e) => setControls({ ...controls, to: e.target.value })}
                />
              </Field>
            </>
          )}
          <Field label="Market Dashboard">
            <select
              className={selectCls}
              value={controls.dashboard}
              onChange={(e) => setControls({ ...controls, dashboard: e.target.value })}
              disabled={dashboards.length === 0}
            >
              {dashboards.length === 0 && <option value="">No market synced</option>}
              {dashboards.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                  {d.filterLabel ? ` · ${d.filterLabel}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Compset">
            <select
              className={selectCls}
              value={controls.compset}
              onChange={(e) => setControls({ ...controls, compset: e.target.value })}
            >
              {compsets.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
              <option value="none">No compset</option>
            </select>
          </Field>
          <button
            type="button"
            onClick={update}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {loading ? "Updating…" : "Update Charts"}
          </button>
          <label className="flex items-center gap-1.5 pb-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
            />
            Remember Selection
          </label>
        </div>
        {report && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Market:{" "}
            {report.sources.market && activeDash ? (
              <>
                <span className="text-foreground">{activeDash.label}</span> · AirROI, updated{" "}
                {fmtRel(activeDash.fetchedAt)}
              </>
            ) : (
              "not synced (run a sync from Market Analytics)"
            )}
            {" — "}Compset prices:{" "}
            {report.sources.compPrices
              ? "scraped Airbnb ladder"
              : "none yet (run a Visibility scan)"}
            {" — "}Your data:{" "}
            {report.sources.yours === "reservations"
              ? "MiniHotel reservations"
              : report.sources.yours === "calendar"
                ? "Rates Calendar"
                : "none yet"}
            {" · "}
            {report.rooms} units
          </p>
        )}
        {error && <p className="mt-2 text-[11px] text-[hsl(var(--danger))]">{error}</p>}
      </Card>

      {/* --------------------------------------------- stay-date pacing card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Listed Price, Occupancy, ADR &amp; RevPAR</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Pacing by stay date — your portfolio against the market compset, this year against last
            year. All prices {report?.currency ?? "ILS"}, per night.
          </p>
        </CardHeader>
        <CardContent className="space-y-8">
          <div>
            <ChartBlock
              yLabel="Listed Price"
              empty={!hasAny(["p25", "p50", "p75", "p90", "listed"])}
              emptyHint="no compset price data yet — run a Visibility scan to capture the comp ladder, or pick a different compset."
            >
              <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 12, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
                {xAxisStay}
                <YAxis tick={{ fontSize: 10 }} stroke={AXIS} domain={[0, "auto"]} />
                {stayTooltip("money")}
                {thisMonthLine}
                {PRICE_SERIES.filter((s) => s.kind === "band").map((s) => (
                  <Area
                    key={s.k}
                    dataKey={s.k}
                    name={s.label}
                    stroke="none"
                    fill={s.color}
                    fillOpacity={s.k === "band5075" ? 0.6 : s.k === "band7590" ? 0.4 : 0.8}
                    activeDot={false}
                    hide={hidden.has(s.k)}
                  />
                ))}
                <Line
                  dataKey="listed"
                  name="Your Listed Price"
                  stroke={C.listed}
                  strokeWidth={1.8}
                  strokeDasharray="5 4"
                  dot={false}
                  connectNulls
                  hide={hidden.has("listed")}
                />
              </ComposedChart>
            </ChartBlock>
            <ToggleLegend items={PRICE_SERIES} hidden={hidden} onToggle={toggle} />
          </div>

          <div>
            <ChartBlock
              yLabel="Occupancy (%)"
              empty={!hasAny(["mktOcc", "yourOcc", "mktOccLy", "yourOccLy"])}
              emptyHint="no occupancy data yet — sync the market (Market Analytics) and reservations (Settings → MiniHotel)."
            >
              {lineChart(OCC_SERIES, "pct")}
            </ChartBlock>
            <ToggleLegend items={OCC_SERIES} hidden={hidden} onToggle={toggle} />
          </div>

          <div>
            <ChartBlock
              yLabel="ADR"
              empty={!hasAny(["mktAdr", "yourAdr", "mktAdrLy", "yourAdrLy"])}
              emptyHint="no ADR data yet — sync the market and reservations to populate booked rates."
            >
              {lineChart(ADR_SERIES, "money")}
            </ChartBlock>
            <ToggleLegend items={ADR_SERIES} hidden={hidden} onToggle={toggle} />
          </div>

          <div>
            <ChartBlock
              yLabel="RevPAR"
              empty={!hasAny(["mktRevpar", "yourRevpar", "mktRevparLy", "yourRevparLy"])}
              emptyHint="no RevPAR data yet — RevPAR derives from occupancy × ADR once both sides are synced."
            >
              {lineChart(REVPAR_SERIES, "money")}
            </ChartBlock>
            <ToggleLegend items={REVPAR_SERIES} hidden={hidden} onToggle={toggle} />
          </div>
        </CardContent>
      </Card>

      {/* -------------------------------------------------- booking curves */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Booking Curves — Revenue, Occupancy, ADR &amp; RevPAR</CardTitle>
              <p className="mt-1 max-w-2xl text-[11px] text-muted-foreground">
                How each stay month has been filling as bookings arrived: the running total of each
                metric by days till the month completes. Helps spot months booking unusually early
                or falling behind in time to fix them.
              </p>
              {report?.curveSource === "reservations" && (
                <p className="mt-1 text-[11px] text-[hsl(var(--warning))]">
                  Booking dates approximated from when each reservation first synced (the
                  reservation feed carries no created-at) — sync MiniHotel bookings for exact curves.
                </p>
              )}
            </div>
            <div className="relative shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-right text-[10px] leading-tight text-muted-foreground">
                  Current Selection
                  <br />
                  <span className="text-foreground">
                    {monthsSel && report && monthsSel.size === report.curveDefaults.length &&
                    report.curveDefaults.every((m) => monthsSel.has(m))
                      ? "Current Months"
                      : `${monthsSel?.size ?? 0} months`}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setGearOpen((o) => !o)}
                  className="grid h-8 w-8 place-items-center rounded-md border border-primary/30 bg-primary/15 text-primary hover:bg-primary/25"
                  title="Choose stay months"
                >
                  <Settings2 className="h-4 w-4" />
                </button>
              </div>
              {gearOpen && report && (
                <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-xl border border-border bg-card p-3 shadow-lg">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-medium">Stay months</span>
                    <button
                      type="button"
                      className="text-[11px] text-primary hover:underline"
                      onClick={() => setMonthsSel(new Set(report.curveDefaults))}
                    >
                      Current months
                    </button>
                  </div>
                  <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                    {curves.map((c) => (
                      <label key={c.month} className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                          checked={monthsSel?.has(c.month) ?? false}
                          onChange={() =>
                            setMonthsSel((cur) => {
                              const next = new Set(cur ?? []);
                              if (next.has(c.month)) next.delete(c.month);
                              else next.add(c.month);
                              return next;
                            })
                          }
                        />
                        <Swatch color={curveColor(c.month)} />
                        {c.label}
                        {c.points.length === 0 && (
                          <span className="text-[10px] text-muted-foreground">(no bookings)</span>
                        )}
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setGearOpen(false)}
                    className="mt-2 w-full rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted/50"
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-8">
          {report?.curveSource == null ? (
            <div className="grid h-32 place-items-center rounded-lg border border-dashed border-border">
              <p className="px-4 text-center text-[11px] text-muted-foreground">
                No booking history yet — sync MiniHotel bookings to build the curves.
              </p>
            </div>
          ) : (
            <>
              <CurveChart
                title="Revenue"
                metric="revenue"
                curves={selectedCurves}
                colorOf={curveColor}
                fmt={(v) => money(v)}
                tickFmt={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
              />
              <CurveChart
                title="Occupancy (%)"
                metric="occ"
                curves={selectedCurves}
                colorOf={curveColor}
                fmt={(v) => `${v}%`}
                domain={[0, 100]}
              />
              <CurveChart
                title="ADR"
                metric="adr"
                curves={selectedCurves}
                colorOf={curveColor}
                fmt={(v) => money(v)}
              />
              <CurveChart
                title="RevPAR"
                metric="revpar"
                curves={selectedCurves}
                colorOf={curveColor}
                fmt={(v) => money(v)}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CurveChart({
  title,
  metric,
  curves,
  colorOf,
  fmt,
  tickFmt,
  domain,
}: {
  title: string;
  metric: keyof CurvePoint;
  curves: BookingCurve[];
  colorOf: (month: string) => string;
  fmt: (v: number) => string;
  tickFmt?: (v: number) => string;
  domain?: [number, number];
}) {
  if (curves.length === 0) {
    return (
      <div className="grid h-28 place-items-center rounded-lg border border-dashed border-border">
        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium">{title}:</span> no stay months selected (use the gear above).
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <div style={{ width: "100%", height: 240 }}>
        <ResponsiveContainer>
          <LineChart margin={{ top: 8, right: 12, bottom: 12, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
            <XAxis
              type="number"
              dataKey="dtc"
              reversed
              domain={[0, 365]}
              ticks={[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360]}
              tickFormatter={(v: number) => (v >= 360 ? "360+" : String(v))}
              tick={{ fontSize: 10 }}
              stroke={AXIS}
              label={{
                value: "Days till completion",
                position: "insideBottom",
                offset: -4,
                fontSize: 10,
                fill: AXIS,
              }}
            />
            <YAxis
              tick={{ fontSize: 10 }}
              stroke={AXIS}
              domain={domain ?? [0, "auto"]}
              tickFormatter={tickFmt}
            />
            <Tooltip
              contentStyle={{ fontSize: 12 }}
              formatter={(v: unknown) => (typeof v === "number" ? fmt(v) : String(v ?? "—"))}
              labelFormatter={(v) => `${Number(v) >= 360 ? "360+" : v} days till completion`}
            />
            {curves.map((c) => (
              <Line
                key={c.month}
                data={c.points}
                dataKey={metric}
                name={c.label}
                stroke={colorOf(c.month)}
                strokeWidth={1.8}
                dot={false}
                type="stepAfter"
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        {curves.map((c) => (
          <span key={c.month} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Swatch color={colorOf(c.month)} />
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}
