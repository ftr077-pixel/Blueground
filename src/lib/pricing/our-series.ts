// Our own portfolio series, shaped to overlay on the market (PriceLabs) charts in
// Market Analytics. Sourced from the same repos the Pacing tab uses — MiniHotel
// reservations + ARI occupancy + the rates calendar + units — so the dashboard can
// show "ours vs. market" directly. Empty where that data isn't present yet.

import { getDb } from "@/lib/db";
import { occupancyByMonth } from "@/lib/repos/occupancy";
import { monthlyReservationRevenue } from "@/lib/repos/reservations";
import { listUnits } from "@/lib/repos/units";
import { unavailableDatesForUnit } from "@/lib/repos/rates";
import { buildPacingReport } from "@/lib/pacing";

export interface OurMonthly {
  month: string; // YYYY-MM
  occupancy: number; // 0..1
  adr: number;
  revpar: number;
}
export interface OurForward {
  date: string;
  occupancy: number; // 0..1
}
export interface OurLos {
  bucket: string;
  share: number; // %
}
export interface OurByBedroom {
  label: string;
  count: number;
  adr: number;
  occupancy: number; // %
}
export interface OurForwardRate {
  date: string;
  rate: number; // our booked nightly for that check-in date
}
export interface OurPickup {
  month: string; // YYYY-MM
  points: { w: number; occ: number }[]; // w = days out (≈ booking window), occ %
}
export interface OurSeries {
  monthly: OurMonthly[];
  forwardOcc: OurForward[];
  forwardRate: OurForwardRate[];
  los: OurLos[];
  byBedroom: OurByBedroom[];
  pickup: OurPickup[];
  hasData: boolean; // true when there's real reservation/occupancy history (not just units)
}

const LOS_BUCKETS = ["1 Day", "2 Days", "3-4 Days", "5-6 Days", "7-14 Days", "15-28 Days", "29+ Days"];
const CANCELLED_RE = /^(cl|cxl|ns)$|cancel|no.?show|void|declin|reject/i;
const isoAdd = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const losBucket = (n: number) =>
  n <= 1 ? "1 Day" : n === 2 ? "2 Days" : n <= 4 ? "3-4 Days" : n <= 6 ? "5-6 Days" : n <= 14 ? "7-14 Days" : n <= 28 ? "15-28 Days" : "29+ Days";

export function ourMarketSeries(): OurSeries {
  // Monthly occupancy (ARI) joined with monthly net revenue → our ADR / RevPAR.
  const occ = occupancyByMonth();
  const rev = monthlyReservationRevenue();
  const monthly: OurMonthly[] = occ.byMonth.map((m) => {
    const r = rev[m.month] ?? 0;
    return {
      month: m.month,
      occupancy: Math.round(m.occupancy * 1000) / 1000,
      adr: m.bookedNights > 0 ? Math.round(r / m.bookedNights) : 0,
      revpar: m.availableNights > 0 ? Math.round(r / m.availableNights) : 0,
    };
  });

  const units = listUnits();
  const rooms = occ.rooms || units.length;

  // Forward occupancy from the rates calendar (booked/blocked nights ÷ rooms).
  const today = new Date().toISOString().slice(0, 10);
  const HORIZON = 365;
  const sets = units.map((u) => unavailableDatesForUnit(u.id, today, HORIZON));
  const forwardOcc: OurForward[] = [];
  if (rooms > 0) {
    for (let i = 0; i < HORIZON; i++) {
      const d = isoAdd(today, i);
      let booked = 0;
      for (const s of sets) if (s.has(d)) booked++;
      forwardOcc.push({ date: d, occupancy: booked / rooms });
    }
  }
  const fwdHasData = forwardOcc.some((p) => p.occupancy > 0);

  // Reservations drive both LOS and realized per-bedroom ADR (revenue ÷ nights —
  // unit base rates are often unset, so realized rate is the honest comparison).
  const resRows = getDb()
    .prepare("SELECT unit_id, check_in, check_out, nights, revenue, status FROM reservation")
    .all() as {
    unit_id: string | null;
    check_in: string;
    check_out: string;
    nights: number;
    revenue: number;
    status: string | null;
  }[];
  const unitBed = new Map(units.map((u) => [u.id, u.bedrooms]));

  const losCount: Record<string, number> = {};
  for (const b of LOS_BUCKETS) losCount[b] = 0;
  let losTotal = 0;
  const bedAgg = new Map<number, { count: number; rev: number; nights: number }>();
  for (const u of units) {
    const e = bedAgg.get(u.bedrooms) ?? { count: 0, rev: 0, nights: 0 };
    e.count++;
    bedAgg.set(u.bedrooms, e);
  }
  for (const r of resRows) {
    if (r.status && CANCELLED_RE.test(r.status)) continue;
    if (!(r.nights > 0)) continue;
    losCount[losBucket(r.nights)]++;
    losTotal++;
    const bed = r.unit_id != null ? unitBed.get(r.unit_id) : undefined;
    const e = bed != null ? bedAgg.get(bed) : undefined;
    if (e) {
      e.rev += r.revenue;
      e.nights += r.nights;
    }
  }
  const los: OurLos[] = LOS_BUCKETS.map((b) => ({
    bucket: b,
    share: losTotal ? Math.round((losCount[b] / losTotal) * 1000) / 10 : 0,
  }));

  // Per bedroom: unit count from the portfolio + realized ADR from reservations.
  const byBedroom: OurByBedroom[] = [...bedAgg.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bed, v]) => ({
      label: bed === 0 ? "Studio" : `${bed} BR`,
      count: v.count,
      adr: v.nights > 0 ? Math.round(v.rev / v.nights) : 0,
      occupancy: 0, // not split by bedroom — the market column carries occupancy
    }));

  // Forward booked nightly rate: our reservations covering each future date.
  const horizonEnd = isoAdd(today, HORIZON);
  const fwdRate = new Map<string, { sum: number; n: number }>();
  for (const r of resRows) {
    if (r.status && CANCELLED_RE.test(r.status)) continue;
    if (!(r.nights > 0) || !r.check_in) continue;
    const nightly = r.revenue / r.nights;
    for (let i = 0; i < r.nights; i++) {
      const d = isoAdd(r.check_in, i);
      if (d < today || d > horizonEnd) continue;
      const e = fwdRate.get(d) ?? { sum: 0, n: 0 };
      e.sum += nightly;
      e.n++;
      fwdRate.set(d, e);
    }
  }
  const forwardRate: OurForwardRate[] = [...fwdRate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, v]) => ({ date, rate: Math.round(v.sum / v.n) }));

  // Our booking-pickup curves — reuse the Pacing report (occupancy build-up per
  // stay-month). x = days-out (dtc), close enough to overlay on the market's
  // booking-window curve.
  let pickup: OurPickup[] = [];
  try {
    const rep = buildPacingReport({});
    pickup = (rep.curves ?? []).map((c) => ({
      month: c.month,
      points: c.points
        .map((p) => ({ w: p.dtc, occ: Math.round(p.occ) }))
        .sort((a, b) => a.w - b.w),
    }));
  } catch {
    pickup = [];
  }

  return {
    monthly,
    forwardOcc: fwdHasData ? forwardOcc : [],
    forwardRate,
    los,
    byBedroom,
    pickup,
    hasData: monthly.length > 0 || losTotal > 0,
  };
}
