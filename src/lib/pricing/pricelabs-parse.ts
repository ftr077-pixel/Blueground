// Parse PriceLabs Market Dashboard CSV exports (server-side) into a market
// snapshot. Mirrors scraper/pricelabs_csv.py so the in-app upload and the CLI
// produce identical data. Only the CSVs that map to the snapshot schema are used;
// the rest (PDF, LOS, Booking_Curves) are reported as skipped.

import type {
  MarketSnapshotInput,
  MarketSummary,
  MetricsPoint,
  PacingPoint,
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

  const byKind = new Map<string, Record<string, string>[]>();
  for (const f of files) {
    const kind = classify(f.name);
    if (kind === "market_history" || kind === "supply_demand" || kind === "occupancy" || kind === "prices") {
      const rows = parseCsv(f.text);
      byKind.set(kind, rows);
      used.push({ file: f.name, kind, rows: rows.length });
    } else if (kind === "pdf") {
      skipped.push({ file: f.name, reason: "PDF — dashboard runs on the CSVs (not charted yet)" });
    } else if (kind === "los" || kind === "booking_curves") {
      skipped.push({ file: f.name, reason: `${kind} — no chart slot yet` });
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

  const area: MarketSnapshotInput | null =
    summary || pacing.length || metrics.length
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
