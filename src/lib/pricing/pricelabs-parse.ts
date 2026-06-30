// Parse PriceLabs Market Dashboard CSV exports (server-side) into a market
// snapshot. Mirrors scraper/pricelabs_csv.py so the in-app upload and the CLI
// produce identical data. Only the CSVs that map to the snapshot schema are used;
// the rest (PDF, LOS, Booking_Curves) are reported as skipped.

import type {
  BookingCurveMonth,
  LosBucket,
  MarketExtras,
  MarketSnapshotInput,
  MarketSummary,
  MetricsPoint,
  PacingPoint,
  SummaryTableRow,
} from "@/lib/repos/market";

export interface UploadFile {
  name: string;
  text: string;
}

export interface ParseResult {
  area: MarketSnapshotInput | null;
  used: { file: string; kind: string; rows: number }[];
  skipped: { file: string; reason: string }[];
  stats: { metrics: number; pacing: number; pacingFrom: string | null; pacingTo: string | null };
}

const OCC_CEILING = 0.98;
const DEFAULT_MIN_NIGHTS = 4; // PriceLabs market exports use a "min N nights" comp filter; CSVs don't carry it.

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else if (c === '"') {
      q = true;
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
}

function num(x: string | undefined): number | null {
  if (x == null) return null;
  const s = x.trim();
  if (s === "" || s.toUpperCase() === "NA") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

const monthToIso = (m: string): string => {
  const s = (m || "").trim();
  return s.length > 7 ? s : `${s}-01`;
};

function marketName(files: UploadFile[]): string {
  for (const f of files) {
    const base = f.name.split("/").pop() || f.name;
    if (base.includes("__")) {
      const prefix = base.split("__")[0];
      const tail = prefix.split("-").pop();
      if (tail) return tail;
    }
  }
  return "Tel Aviv";
}

function parseMarketHistory(rows: Record<string, string>[]): MetricsPoint[] {
  return rows
    .filter((r) => (r["month"] || "").trim())
    .map((r) => {
      const occ = num(r["Occ. Aggregate"]);
      return {
        date: monthToIso(r["month"]),
        occupancy: occ != null ? occ / 100 : 0,
        average_daily_rate: num(r["ADR Aggregate"]) ?? 0,
        revpar: num(r["RevPAR Aggregate"]) ?? 0,
        revenue: num(r["Rev. Aggregate"]) ?? 0,
        booking_lead_time: num(r["BW Aggregate"]) ?? 0,
        length_of_stay: num(r["LOS Aggregate"]) ?? 0,
        min_nights: 0,
        active_listings_count: 0,
      };
    });
}

function parseSupplyDemand(rows: Record<string, string>[]): Map<string, number> {
  const active = new Map<string, number>();
  for (const r of rows) {
    const m = (r["Month"] || "").trim().slice(0, 7);
    if (m) active.set(m, num(r["Active listings"]) ?? 0);
  }
  return active;
}

function parseOccupancy(rows: Record<string, string>[]): Map<string, number> {
  const occ = new Map<string, number>();
  for (const r of rows) {
    const d = (r["Date"] || "").trim();
    const v = num(r["Occupancy"]);
    if (d && v != null) occ.set(d, v);
  }
  return occ;
}

interface PricePoint {
  p50: number | null;
  booked: number | null;
  nbook: number;
}
function parsePrices(rows: Record<string, string>[]): Map<string, PricePoint> {
  const out = new Map<string, PricePoint>();
  for (const r of rows) {
    const d = (r["Dates"] || "").trim();
    if (!d) continue;
    out.set(d, {
      p50: num(r["50th Percentile"]),
      booked: num(r["Median Booked Price"]),
      nbook: num(r["No. Of Bookings"]) ?? 0,
    });
  }
  return out;
}

function buildPacing(
  occ: Map<string, number>,
  prices: Map<string, PricePoint>,
  cutoff: string,
): PacingPoint[] {
  const out: PacingPoint[] = [];
  for (const d of [...occ.keys()].sort()) {
    if (d < cutoff) continue;
    const fill = Math.round((occ.get(d)! / 100) * 10000) / 10000;
    const pr = prices.get(d);
    const p50 = pr?.p50 ?? 0;
    const booked = pr?.booked ?? p50;
    out.push({
      date: d,
      booked_count: Math.round(pr?.nbook ?? 0),
      available_count: 0,
      booked_rate_avg: Math.round(booked * 100) / 100,
      available_rate_avg: Math.round(p50 * 100) / 100,
      fill_rate: Math.min(OCC_CEILING, fill),
    });
  }
  return out;
}

const LOS_BUCKETS = ["1 Day", "2 Days", "3-4 Days", "5-6 Days", "7-14 Days", "15-28 Days", "29+ Days"];

// Booking_Curves.csv → per stay-month pickup curve (occupancy by booking window,
// this year vs last year). Downsampled: full detail near arrival, coarse far out.
function parseBookingCurves(rows: Record<string, string>[]): BookingCurveMonth[] {
  const byMonth = new Map<string, { w: number; o: number; ly: number }[]>();
  for (const r of rows) {
    const month = (r["Date Range"] || "").trim();
    if (!month) continue;
    const w = parseInt((r["Booking Window"] || "").replace("+", ""), 10);
    if (!Number.isFinite(w)) continue;
    const o = num(r["Occupancy"]) ?? 0;
    const ly = num(r["Occupancy (Last Year)"]) ?? 0;
    if (o === 0 && ly === 0) continue; // trim the flat far-out head
    if (w > 30 && w % 5 !== 0) continue; // keep payload small
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month)!.push({ w, o, ly });
  }
  return [...byMonth.entries()].map(([month, points]) => ({
    month,
    points: points.sort((a, b) => a.w - b.w),
  }));
}

// LOS.csv → length-of-stay distribution (share of bookings per LOS bucket), using
// the win_max (overall) columns aggregated across all dates.
function parseLos(rows: Record<string, string>[]): LosBucket[] {
  const count: Record<string, number> = {};
  const bnpWeighted: Record<string, number> = {};
  for (const b of LOS_BUCKETS) {
    count[b] = 0;
    bnpWeighted[b] = 0;
  }
  for (const r of rows) {
    for (const b of LOS_BUCKETS) {
      const c = num(r[`win_max_${b}`]) ?? 0;
      const p = num(r[`win_max_${b}_BNP`]) ?? 0;
      count[b] += c;
      bnpWeighted[b] += c * p;
    }
  }
  const total = LOS_BUCKETS.reduce((s, b) => s + count[b], 0) || 1;
  return LOS_BUCKETS.map((b) => ({
    bucket: b,
    count: Math.round(count[b]),
    share: Math.round((count[b] / total) * 1000) / 10,
    bnp: count[b] ? Math.round(bnpWeighted[b] / count[b]) : 0,
  }));
}

// Per-bedroom comparison from the latest month of market_history (Aggregate/1BR/2BR).
function buildSummaryTable(
  rows: Record<string, string>[],
): { kind: string; rows: SummaryTableRow[] } | undefined {
  if (!rows.length) return undefined;
  const last = rows[rows.length - 1];
  const cats: [string, string][] = [
    ["1 & 2 BR", "Aggregate"],
    ["1 BR", "1 BR"],
    ["2 BR", "2 BR"],
  ];
  return {
    kind: "history",
    rows: cats.map(([category, suf]) => ({
      category,
      occupancy: num(last[`Occ. ${suf}`]) ?? 0,
      adr: num(last[`ADR ${suf}`]) ?? 0,
      revpar: num(last[`RevPAR ${suf}`]) ?? 0,
      los: num(last[`LOS ${suf}`]) ?? 0,
      bookingWindow: num(last[`BW ${suf}`]) ?? 0,
    })),
  };
}

// Classify an uploaded file by name (any prefix; case-insensitive).
function classify(name: string): string | null {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return "pdf";
  if (!n.endsWith(".csv")) return null;
  if (n.includes("market_history")) return "market_history";
  if (n.includes("supply_demand")) return "supply_demand";
  if (n.includes("occupancy")) return "occupancy";
  if (n.includes("prices")) return "prices";
  if (n.includes("booking_curves")) return "booking_curves";
  if (n.includes("los")) return "los";
  return "csv";
}

export function parsePriceLabsUploads(
  files: UploadFile[],
  opts?: { neighborhood?: string; today?: string },
): ParseResult {
  const neighborhood = opts?.neighborhood?.trim() || "Tel Aviv";
  const today = opts?.today || new Date().toISOString().slice(0, 10);
  const used: ParseResult["used"] = [];
  const skipped: ParseResult["skipped"] = [];

  const KNOWN = ["market_history", "supply_demand", "occupancy", "prices", "booking_curves", "los"];
  const byKind = new Map<string, Record<string, string>[]>();
  for (const f of files) {
    const kind = classify(f.name);
    if (kind && KNOWN.includes(kind)) {
      const rows = parseCsv(f.text);
      byKind.set(kind, rows);
      used.push({ file: f.name, kind, rows: rows.length });
    } else if (kind === "pdf") {
      skipped.push({ file: f.name, reason: "PDF — per-bedroom table is shown from the CSVs" });
    } else {
      skipped.push({ file: f.name, reason: "unrecognized file" });
    }
  }

  const metrics = byKind.has("market_history") ? parseMarketHistory(byKind.get("market_history")!) : [];
  if (byKind.has("supply_demand")) {
    const active = parseSupplyDemand(byKind.get("supply_demand")!);
    for (const m of metrics) m.active_listings_count = active.get(m.date.slice(0, 7)) ?? 0;
  }
  const occ = byKind.has("occupancy") ? parseOccupancy(byKind.get("occupancy")!) : new Map<string, number>();
  const prices = byKind.has("prices") ? parsePrices(byKind.get("prices")!) : new Map<string, PricePoint>();
  const pacing = occ.size ? buildPacing(occ, prices, today) : [];

  const last = metrics[metrics.length - 1];
  let summary: MarketSummary | null = null;
  if (last) {
    summary = {
      occupancy: last.occupancy,
      average_daily_rate: last.average_daily_rate,
      rev_par: last.revpar,
      revenue: last.revenue,
      booking_lead_time: last.booking_lead_time,
      length_of_stay: last.length_of_stay,
      min_nights: DEFAULT_MIN_NIGHTS,
      active_listings_count: last.active_listings_count,
    };
  }

  const extras: MarketExtras = {};
  if (byKind.has("booking_curves")) extras.bookingCurves = parseBookingCurves(byKind.get("booking_curves")!);
  if (byKind.has("los")) extras.los = parseLos(byKind.get("los")!);
  if (byKind.has("market_history")) {
    const st = buildSummaryTable(byKind.get("market_history")!);
    if (st) extras.summaryTable = st;
  }
  const hasExtras = !!(extras.bookingCurves?.length || extras.los?.length || extras.summaryTable);

  const area: MarketSnapshotInput | null =
    summary || pacing.length || metrics.length || hasExtras
      ? {
          neighborhood,
          marketName: `${marketName(files)} (PriceLabs)`,
          currency: "ILS",
          summary,
          pacing,
          minNights: [],
          metrics,
          filterLabel: null,
          source: "pricelabs",
          extras: hasExtras ? extras : null,
        }
      : null;

  return {
    area,
    used,
    skipped,
    stats: {
      metrics: metrics.length,
      pacing: pacing.length,
      pacingFrom: pacing[0]?.date ?? null,
      pacingTo: pacing[pacing.length - 1]?.date ?? null,
    },
  };
}
