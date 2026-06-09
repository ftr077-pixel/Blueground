import { getDb } from "@/lib/db";
import {
  getMiniHotelMapping,
  getVatRate,
  getExcludedRoomCodes,
  isLocalVatCountry,
} from "@/lib/repos/integrations";

/**
 * Reservations repo — the source of *real* revenue actuals.
 *
 * MiniHotel's GetReservationKey gives us the actual bookings, but only as a
 * tax-INCLUSIVE total (`AmountAfterTaxes`) plus the guest's country. We store each
 * booking, recognize its revenue per night across the stay, and report NET of VAT:
 * Israeli guests pay 18% VAT, tourists are zero-rated, so we strip VAT only from
 * local guests (by country) and keep gross/vat for audit. Cancelled / no-show
 * reservations and configured test apartments are kept but never counted.
 *
 * There are no costs in MiniHotel — only revenue — so this feeds rental-revenue
 * actuals only; cost lines keep coming from the workbook.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// MiniHotel status codes: OK confirmed, WL pending, IN checked-in, OUT checked-out,
// CL cancelled, BL blacklist. We only drop cancellations / no-shows from revenue.
const CANCELLED_RE = /^(cl|cxl|ns)$|cancel|no.?show|void|declin|reject/i;

export interface ReservationInput {
  id: string;
  roomType?: string | null;
  roomNumber?: string | null;
  unitId?: string | null;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD, exclusive (the morning the guest leaves)
  // Money — provide whichever the source has (precedence: net > vat > country/flag):
  net?: number; // ex-VAT room revenue (preferred, if already computed)
  gross?: number; // VAT-inclusive (MiniHotel AmountAfterTaxes)
  vat?: number; // VAT amount, if known
  vatLiable?: boolean; // override: true = local (18%), false = tourist (0%)
  vatFlag?: string | null; // MiniHotel's own Vat flag ("Yes" incl / "Not" excl) — authoritative
  revenue?: number; // legacy alias for gross
  country?: string | null; // guest country (iso2/iso3/name) — drives VAT when liable unknown
  currency?: string | null;
  status?: string | null;
}

interface ReservationSql {
  room_type: string | null;
  room_number: string | null;
  check_in: string;
  check_out: string;
  nights: number;
  revenue: number;
  status: string | null;
}

/** Whole nights between check-in and check-out (>= 1 even for a same-day quirk). */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(checkIn + "T00:00:00Z");
  const b = Date.parse(checkOut + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(1, Math.round((b - a) / 86400000));
}

const isoAddDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

/** RoomTypeCode (upper-cased) -> first mapped Hub unit id. */
function roomTypeToUnit(): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of getMiniHotelMapping()) {
    if (r.roomType && !m.has(r.roomType.trim().toUpperCase())) {
      m.set(r.roomType.trim().toUpperCase(), r.unitId);
    }
  }
  return m;
}

/** Is this booking a test apartment (room type OR room number on the excluded list)? */
function isExcludedRoom(roomType: string | null, roomNumber: string | null, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false;
  if (roomType && excluded.has(roomType.trim().toUpperCase())) return true;
  if (roomNumber && excluded.has(roomNumber.trim().toUpperCase())) return true;
  return false;
}

// How each reservation's VAT was resolved — surfaced in the report so the operator
// can audit it (18% is too big to take on trust). "assumed-none" = we had no signal
// (no MiniHotel flag, no country) and treated it as a zero-rated tourist.
export type VatBasis = "explicit-net" | "explicit-vat" | "flag" | "country" | "assumed-none";

interface NetParts {
  gross: number | null;
  vat: number | null;
  net: number; // NaN => no usable amount, caller skips
  basis: VatBasis;
}

/** Parse MiniHotel's Vat flag ("Yes" = incl VAT / "Not"/"No" = excl) to liability. */
function flagToLiable(flag: string | null | undefined): boolean | null {
  if (flag == null || flag.trim() === "") return null;
  if (/^y/i.test(flag.trim())) return true; // "Yes" => price includes VAT
  if (/^n/i.test(flag.trim())) return false; // "Not"/"No" => no VAT in the price
  return null;
}

/** Resolve net (ex-VAT) revenue + how we got there, from whatever the source provided. */
function computeNet(input: ReservationInput): NetParts {
  if (input.net != null && Number.isFinite(input.net)) {
    const net = input.net;
    const gross = input.gross ?? (input.vat != null ? net + input.vat : null);
    const vat = input.vat ?? (gross != null ? gross - net : null);
    return { gross, vat, net, basis: "explicit-net" };
  }
  const gross = input.gross ?? input.revenue ?? null; // legacy `revenue` == gross
  if (gross == null || !Number.isFinite(gross)) return { gross: null, vat: null, net: NaN, basis: "assumed-none" };
  if (input.vat != null && Number.isFinite(input.vat)) {
    return { gross, vat: input.vat, net: gross - input.vat, basis: "explicit-vat" };
  }
  // Liability: MiniHotel's own Vat flag (or an explicit override) wins; else country.
  const flagLiable = flagToLiable(input.vatFlag);
  let liable: boolean;
  let basis: VatBasis;
  if (flagLiable != null) {
    liable = flagLiable;
    basis = "flag";
  } else if (typeof input.vatLiable === "boolean") {
    liable = input.vatLiable;
    basis = "flag";
  } else if (input.country != null && String(input.country).trim() !== "") {
    liable = isLocalVatCountry(input.country);
    basis = "country";
  } else {
    liable = false; // no signal at all — treat as zero-rated, but flag it for review
    basis = "assumed-none";
  }
  if (liable) {
    const net = gross / (1 + getVatRate());
    return { gross, vat: gross - net, net, basis };
  }
  return { gross, vat: 0, net: gross, basis }; // zero-rated, gross == net
}

/**
 * Upsert reservations from a pull (idempotent by id — a re-pull of an overlapping
 * window just refreshes existing rows, and cancellations arrive as status updates).
 * Computes net-of-VAT revenue and resolves each RoomTypeCode to a Hub unit.
 */
export function upsertReservations(rows: ReservationInput[]): { recorded: number; skipped: number } {
  const db = getDb();
  const byRoom = roomTypeToUnit();
  const now = new Date().toISOString();

  const upsert = db.prepare(
    `INSERT INTO reservation
       (id, unit_id, room_type, room_number, check_in, check_out, nights, revenue, gross, vat, vat_basis, currency, country, status, source, updated_at)
     VALUES
       (@id, @unit_id, @room_type, @room_number, @check_in, @check_out, @nights, @revenue, @gross, @vat, @vat_basis, @currency, @country, @status, 'minihotel', @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       unit_id = @unit_id, room_type = @room_type, room_number = @room_number,
       check_in = @check_in, check_out = @check_out, nights = @nights, revenue = @revenue,
       gross = @gross, vat = @vat, vat_basis = @vat_basis, currency = @currency, country = @country,
       status = @status, updated_at = @updated_at`,
  );

  let recorded = 0;
  let skipped = 0;
  const tx = db.transaction((list: ReservationInput[]) => {
    for (const r of list) {
      const checkIn = (r.checkIn ?? "").slice(0, 10);
      const checkOut = (r.checkOut ?? "").slice(0, 10);
      const { gross, vat, net, basis } = computeNet(r);
      if (!r.id || !DATE_RE.test(checkIn) || !DATE_RE.test(checkOut) || !Number.isFinite(net)) {
        skipped++;
        continue;
      }
      const room = (r.roomType ?? "").trim();
      const unitId = r.unitId ?? (room ? (byRoom.get(room.toUpperCase()) ?? null) : null);
      upsert.run({
        id: String(r.id),
        unit_id: unitId,
        room_type: room || null,
        room_number: (r.roomNumber ?? "").trim() || null,
        check_in: checkIn,
        check_out: checkOut,
        nights: nightsBetween(checkIn, checkOut),
        revenue: Math.round(net),
        gross: gross != null ? Math.round(gross) : null,
        vat: vat != null ? Math.round(vat) : null,
        vat_basis: basis,
        currency: r.currency ?? null,
        country: r.country ?? null,
        status: r.status ?? null,
        updated_at: now,
      });
      recorded++;
    }
  });
  tx(rows);
  return { recorded, skipped };
}

/**
 * Actual NET room revenue per calendar month (YYYY-MM), recognized per night across
 * each stay. Cancelled / no-show reservations and test apartments are excluded.
 */
export function monthlyReservationRevenue(): Record<string, number> {
  const excluded = getExcludedRoomCodes();
  const rows = getDb()
    .prepare("SELECT room_type, room_number, check_in, check_out, nights, revenue, status FROM reservation")
    .all() as ReservationSql[];

  const acc: Record<string, number> = {};
  for (const r of rows) {
    if (r.status && CANCELLED_RE.test(r.status)) continue;
    if (isExcludedRoom(r.room_type, r.room_number, excluded)) continue;
    const nights = r.nights > 0 ? r.nights : nightsBetween(r.check_in, r.check_out);
    if (nights <= 0 || !DATE_RE.test(r.check_in)) continue;
    const perNight = r.revenue / nights;
    for (let i = 0; i < nights; i++) {
      const ym = isoAddDays(r.check_in, i).slice(0, 7);
      acc[ym] = (acc[ym] ?? 0) + perNight;
    }
  }
  for (const k of Object.keys(acc)) acc[k] = Math.round(acc[k]);
  return acc;
}

export interface ReservationStats {
  count: number; // counted (non-cancelled, non-test) reservations
  cancelled: number;
  test: number; // excluded as test apartments
  testRevenue: number; // gross revenue parked in test apartments (for sanity)
  months: number; // distinct months with revenue
  revenue: number; // total counted NET revenue
  vat: number; // total VAT stripped out
}

export function reservationStats(): ReservationStats {
  const excluded = getExcludedRoomCodes();
  const rows = getDb()
    .prepare("SELECT revenue, gross, vat, room_type, room_number, status FROM reservation")
    .all() as Array<{
    revenue: number;
    gross: number | null;
    vat: number | null;
    room_type: string | null;
    room_number: string | null;
    status: string | null;
  }>;
  let count = 0;
  let cancelled = 0;
  let test = 0;
  let testRevenue = 0;
  let revenue = 0;
  let vat = 0;
  for (const r of rows) {
    if (r.status && CANCELLED_RE.test(r.status)) {
      cancelled++;
      continue;
    }
    if (isExcludedRoom(r.room_type, r.room_number, excluded)) {
      test++;
      testRevenue += r.gross ?? r.revenue;
      continue;
    }
    count++;
    revenue += r.revenue;
    vat += r.vat ?? 0;
  }
  return {
    count,
    cancelled,
    test,
    testRevenue,
    months: Object.keys(monthlyReservationRevenue()).length,
    revenue,
    vat,
  };
}

// ----------------------------------------------------------------- audit report
export interface ReservationReportRow {
  id: string;
  status: string | null;
  roomType: string | null;
  roomNumber: string | null;
  country: string | null;
  checkIn: string;
  checkOut: string;
  nights: number;
  gross: number | null;
  vat: number | null;
  net: number; // counted revenue (net of VAT)
  currency: string | null;
  vatBasis: string | null; // flag | country | explicit-* | assumed-none
  counted: boolean;
  excludedReason: "cancelled" | "test" | null;
}

export interface MonthBucket {
  net: number;
  gross: number;
  vat: number;
  count: number;
}

export interface ReservationReport {
  thisMonth: string; // YYYY-MM
  current: MonthBucket; // this-month counted totals (per-night accrual)
  byMonth: Record<string, MonthBucket>;
  vatBasis: Record<string, number>; // how many counted reservations used each basis
  totals: { counted: number; cancelled: number; test: number; net: number; gross: number; vat: number };
  rows: ReservationReportRow[];
}

interface ReportSql {
  id: string;
  status: string | null;
  room_type: string | null;
  room_number: string | null;
  country: string | null;
  check_in: string;
  check_out: string;
  nights: number;
  gross: number | null;
  vat: number | null;
  revenue: number;
  currency: string | null;
  vat_basis: string | null;
}

/**
 * Full reservation audit: every booking with its VAT basis + counted/excluded
 * reason, monthly NET totals (per-night accrual, matching the P&L), and this
 * month's figure. This is the surface for verifying the 18% VAT split by eye.
 */
export function reservationReport(thisMonth?: string): ReservationReport {
  const excluded = getExcludedRoomCodes();
  const ym = thisMonth && /^\d{4}-\d{2}$/.test(thisMonth) ? thisMonth : new Date().toISOString().slice(0, 7);
  const rows = getDb()
    .prepare(
      "SELECT id, status, room_type, room_number, country, check_in, check_out, nights, gross, vat, revenue, currency, vat_basis FROM reservation ORDER BY check_in",
    )
    .all() as ReportSql[];

  const byMonth: Record<string, MonthBucket> = {};
  const vatBasis: Record<string, number> = {};
  const totals = { counted: 0, cancelled: 0, test: 0, net: 0, gross: 0, vat: 0 };
  const out: ReservationReportRow[] = [];

  for (const r of rows) {
    const cancelled = !!(r.status && CANCELLED_RE.test(r.status));
    const isTest = isExcludedRoom(r.room_type, r.room_number, excluded);
    const reason: "cancelled" | "test" | null = cancelled ? "cancelled" : isTest ? "test" : null;
    const counted = reason === null;

    out.push({
      id: r.id,
      status: r.status,
      roomType: r.room_type,
      roomNumber: r.room_number,
      country: r.country,
      checkIn: r.check_in,
      checkOut: r.check_out,
      nights: r.nights,
      gross: r.gross,
      vat: r.vat,
      net: r.revenue,
      currency: r.currency,
      vatBasis: r.vat_basis,
      counted,
      excludedReason: reason,
    });

    if (cancelled) totals.cancelled++;
    if (isTest) totals.test++;
    if (!counted) continue;

    totals.counted++;
    totals.net += r.revenue;
    totals.gross += r.gross ?? r.revenue;
    totals.vat += r.vat ?? 0;
    if (r.vat_basis) vatBasis[r.vat_basis] = (vatBasis[r.vat_basis] ?? 0) + 1;

    // Spread net/gross/vat across the nights so months match the P&L.
    const nights = r.nights > 0 ? r.nights : nightsBetween(r.check_in, r.check_out);
    if (nights <= 0 || !DATE_RE.test(r.check_in)) continue;
    const pn = { net: r.revenue / nights, gross: (r.gross ?? r.revenue) / nights, vat: (r.vat ?? 0) / nights };
    for (let i = 0; i < nights; i++) {
      const mk = isoAddDays(r.check_in, i).slice(0, 7);
      const b = (byMonth[mk] ??= { net: 0, gross: 0, vat: 0, count: 0 });
      b.net += pn.net;
      b.gross += pn.gross;
      b.vat += pn.vat;
    }
  }

  // Round monthly buckets and attach per-month reservation counts (by check-in month).
  for (const r of out) {
    if (!r.counted || !DATE_RE.test(r.checkIn)) continue;
    const mk = r.checkIn.slice(0, 7);
    if (byMonth[mk]) byMonth[mk].count++;
  }
  for (const k of Object.keys(byMonth)) {
    byMonth[k].net = Math.round(byMonth[k].net);
    byMonth[k].gross = Math.round(byMonth[k].gross);
    byMonth[k].vat = Math.round(byMonth[k].vat);
  }
  totals.net = Math.round(totals.net);
  totals.gross = Math.round(totals.gross);
  totals.vat = Math.round(totals.vat);

  const current = byMonth[ym] ?? { net: 0, gross: 0, vat: 0, count: 0 };
  return { thisMonth: ym, current, byMonth, vatBasis, totals, rows: out };
}
