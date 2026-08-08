import { getDb } from "@/lib/db";
import { getSetting, setSetting, listListings } from "@/lib/repos/visibility";
import { getExcludedRoomCodes } from "@/lib/repos/integrations";
import { listUnits } from "@/lib/repos/units";
import { computeBridge } from "@/lib/bridge/engine";

/**
 * Operating forecast — "what the book we already hold, plus how we actually
 * operate, says this year will look like".
 *
 * The Bridge 11 m model is the PLAN OF RECORD: drivers lifted from the
 * business-plan workbook, deliberately untouched. This is the other half of
 * the picture, built bottom-up from data the app already owns:
 *
 *   Revenue = what is already SOLD (MiniHotel reservations, VAT-net, accrued
 *             per night) + expected PICKUP on the nights still open, priced at
 *             the ADR we actually realize.
 *   Costs   = the operator's real unit economics: cleaning / laundry /
 *             consumables per CHECKOUT (and we know how many checkouts each
 *             month has, from the reservations themselves), expected repairs
 *             per apartment, salaries, rent, utilities, and revenue shares.
 *
 * Nothing here is invented: months already elapsed report actuals with no
 * pickup, the current month picks up only over its remaining days, and every
 * assumption is an operator-visible setting (0 = "derive it from my own data").
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Same exclusion the revenue/pacing surfaces use.
const CANCELLED_RE = /^(cl|cxl|ns)$|cancel|no.?show|void|declin|reject/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;

const isoAddDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const daysInMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} '${String(y).slice(2)}`;
};
/** Hotel-local (Asia/Jerusalem) today — the same "now" every money surface uses. */
const hotelToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

function isExcludedRoom(
  roomType: string | null,
  roomNumber: string | null,
  excluded: Set<string>,
): boolean {
  if (excluded.size === 0) return false;
  if (roomType && excluded.has(roomType.trim().toUpperCase())) return true;
  if (roomNumber && excluded.has(roomNumber.trim().toUpperCase())) return true;
  return false;
}

// ------------------------------------------------------------------ settings
export interface OpsAssumptions {
  /** Months shown forward from the current one. */
  horizonMonths: number;
  /** Elapsed months shown before it, for actual-vs-plan context. */
  historyMonths: number;
  /** Occupancy we expect to close a month at, on the nights still open (%). */
  targetOccupancyPct: number;
  /** Nightly NET rate for pickup nights. 0 = use the ADR we actually realize. */
  expectedAdr: number;
  /** Average stay length, to turn pickup nights into checkouts. 0 = derive. */
  avgStayNights: number;
  /** Sellable apartments. 0 = derive from the PMS room inventory. */
  sellableUnits: number;

  // -- variable, per checkout (turnover-driven)
  cleaningPerCheckout: number;
  laundryPerCheckout: number;
  suppliesPerCheckout: number;

  // -- maintenance: expected repairs per apartment per month × cost per repair
  repairsPerUnitMonth: number;
  avgRepairCost: number;

  // -- per apartment per month (0 = use what's set per listing in Manage)
  rentPerUnitMonth: number;
  utilitiesPerUnitMonth: number;

  // -- fixed monthly
  salariesMonthly: number;
  otherFixedMonthly: number;

  // -- shares of revenue (%)
  ownerSharePct: number;
  mgmtFeePct: number;
}

const DEFAULTS: OpsAssumptions = {
  horizonMonths: 12,
  historyMonths: 3,
  targetOccupancyPct: 85,
  expectedAdr: 0,
  avgStayNights: 0,
  sellableUnits: 0,
  cleaningPerCheckout: 0,
  laundryPerCheckout: 0,
  suppliesPerCheckout: 0,
  repairsPerUnitMonth: 0,
  avgRepairCost: 0,
  rentPerUnitMonth: 0,
  utilitiesPerUnitMonth: 0,
  salariesMonthly: 0,
  otherFixedMonthly: 0,
  ownerSharePct: 0,
  mgmtFeePct: 0,
};

const KEY: Record<keyof OpsAssumptions, string> = {
  horizonMonths: "ops_horizon_months",
  historyMonths: "ops_history_months",
  targetOccupancyPct: "ops_target_occupancy_pct",
  expectedAdr: "ops_expected_adr",
  avgStayNights: "ops_avg_stay_nights",
  sellableUnits: "ops_sellable_units",
  cleaningPerCheckout: "ops_cleaning_per_checkout",
  laundryPerCheckout: "ops_laundry_per_checkout",
  suppliesPerCheckout: "ops_supplies_per_checkout",
  repairsPerUnitMonth: "ops_repairs_per_unit_month",
  avgRepairCost: "ops_avg_repair_cost",
  rentPerUnitMonth: "ops_rent_per_unit_month",
  utilitiesPerUnitMonth: "ops_utilities_per_unit_month",
  salariesMonthly: "ops_salaries_monthly",
  otherFixedMonthly: "ops_other_fixed_monthly",
  ownerSharePct: "ops_owner_share_pct",
  mgmtFeePct: "ops_mgmt_fee_pct",
};

function num(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (raw == null || raw.trim() === "") return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getOpsAssumptions(): OpsAssumptions {
  const a = { ...DEFAULTS };
  for (const k of Object.keys(KEY) as Array<keyof OpsAssumptions>) {
    a[k] = num(KEY[k], DEFAULTS[k]);
  }
  a.horizonMonths = Math.max(1, Math.min(36, Math.round(a.horizonMonths)));
  a.historyMonths = Math.max(0, Math.min(24, Math.round(a.historyMonths)));
  a.targetOccupancyPct = Math.max(0, Math.min(100, a.targetOccupancyPct));
  return a;
}

export function setOpsAssumptions(patch: Partial<OpsAssumptions>): OpsAssumptions {
  for (const k of Object.keys(KEY) as Array<keyof OpsAssumptions>) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v === null || !Number.isFinite(v as number)) continue;
    setSetting(KEY[k], String(Math.max(0, v as number)));
  }
  return getOpsAssumptions();
}

// -------------------------------------------------------- booked-side facts
interface MonthFacts {
  soldNights: number; // room-nights already sold in the month
  revenue: number; // VAT-net revenue accrued in the month
  checkouts: number; // stays ending in the month (each = one turnover)
  openSoldNights: number; // sold nights falling on dates >= today
}

interface BookFacts {
  byMonth: Map<string, MonthFacts>;
  /** Realized net ADR over the trailing months that have data (0 when none). */
  trailingAdr: number;
  /** Average nights per counted reservation (0 when none). */
  avgStay: number;
  reservations: number;
}

/**
 * Everything the reservation book knows, per stay month: sold room-nights,
 * VAT-net revenue accrued per night, and the number of stays that END in the
 * month — the turnovers that drive cleaning, laundry and consumables.
 */
function readBook(today: string): BookFacts {
  const excluded = getExcludedRoomCodes();
  const rows = getDb()
    .prepare(
      "SELECT room_type, room_number, check_in, check_out, nights, revenue, status FROM reservation",
    )
    .all() as Array<{
    room_type: string | null;
    room_number: string | null;
    check_in: string;
    check_out: string;
    nights: number;
    revenue: number;
    status: string | null;
  }>;

  const byMonth = new Map<string, MonthFacts>();
  const get = (ym: string): MonthFacts => {
    let m = byMonth.get(ym);
    if (!m) {
      m = { soldNights: 0, revenue: 0, checkouts: 0, openSoldNights: 0 };
      byMonth.set(ym, m);
    }
    return m;
  };
  // A room-night counts once even when two stored rows cover the same room that
  // night (double-entry / modified reservations) — same rule as occupancy. The
  // same applies to the turnover: two rows for one physical stay are still ONE
  // checkout, and counting both would overstate cleaning and laundry.
  const seen = new Set<string>();
  const seenCheckout = new Set<string>();
  let nightsTotal = 0;
  let stays = 0;

  for (const r of rows) {
    if (r.status && CANCELLED_RE.test(r.status)) continue;
    if (isExcludedRoom(r.room_type, r.room_number, excluded)) continue;
    if (!DATE_RE.test(r.check_in) || !DATE_RE.test(r.check_out)) continue;
    const nights =
      r.nights > 0
        ? r.nights
        : Math.round((Date.parse(r.check_out) - Date.parse(r.check_in)) / DAY);
    if (nights <= 0) continue;
    stays++;
    nightsTotal += nights;
    const perNight = r.revenue > 0 ? r.revenue / nights : 0;

    for (let i = 0; i < nights; i++) {
      const d = isoAddDays(r.check_in, i);
      if (r.room_number) {
        const k = r.room_number + "|" + d;
        if (seen.has(k)) continue;
        seen.add(k);
      }
      const m = get(d.slice(0, 7));
      m.soldNights++;
      m.revenue += perNight;
      if (d >= today) m.openSoldNights++;
    }
    // The checkout (turnover) lands on the departure date. Rows with no room
    // number can't be de-duplicated, so they each count.
    const coKey = r.room_number ? r.room_number + "|" + r.check_out : null;
    if (coKey === null || !seenCheckout.has(coKey)) {
      if (coKey) seenCheckout.add(coKey);
      get(r.check_out.slice(0, 7)).checkouts++;
    }
  }

  return {
    byMonth,
    trailingAdr: nightsTotal > 0 ? sum([...byMonth.values()].map((m) => m.revenue)) / nightsTotal : 0,
    avgStay: stays > 0 ? nightsTotal / stays : 0,
    reservations: stays,
  };
}

/** Sellable apartments: the PMS room inventory, else the Hub portfolio. */
function sellableUnits(): number {
  const excluded = getExcludedRoomCodes();
  try {
    const rooms = getDb()
      .prepare("SELECT room_number, room_type FROM ari_room")
      .all() as Array<{ room_number: string; room_type: string | null }>;
    const live = rooms.filter((r) => !isExcludedRoom(r.room_type, r.room_number, excluded));
    if (live.length > 0) return live.length;
  } catch {
    /* older DBs may not have the ARI snapshot — fall through */
  }
  return listUnits().length;
}

// ------------------------------------------------------------------ forecast
export interface OpsMonth {
  key: string; // YYYY-MM
  label: string; // "Jul '26"
  /** past = fully elapsed (actuals only), current = partially open, future. */
  phase: "past" | "current" | "future";
  /** Days in the month still open to pick up bookings (0 once elapsed). */
  openDays: number;
}

export interface OpsRow {
  id: string;
  label: string;
  section: string;
  kind: "line" | "subtotal" | "total" | "ratio" | "count";
  monthly: number[];
  total: number;
  note?: string;
}

export interface OpsForecast {
  today: string;
  currency: string;
  months: OpsMonth[];
  rows: OpsRow[];
  revenueByMonth: number[];
  costByMonth: number[];
  netByMonth: number[];
  summary: {
    units: number;
    horizonMonths: number;
    /** Totals across the FORWARD months only (current + future). */
    forwardRevenue: number;
    forwardCost: number;
    forwardNet: number;
    forwardMargin: number;
    onTheBooks: number; // sold revenue inside the forward window
    expectedPickup: number;
    /** Same window, from the locked Bridge plan (rental revenue). */
    planRevenue: number;
    planDelta: number;
  };
  assumptions: OpsAssumptions;
  /** What the model derived for itself, so "0 = auto" is never a black box. */
  derived: {
    units: number;
    unitsSource: "pms" | "portfolio";
    adr: number;
    adrSource: "setting" | "realized";
    avgStay: number;
    avgStaySource: "setting" | "realized";
    rentMonthly: number;
    rentSource: "setting" | "listings";
    utilitiesMonthly: number;
    utilitiesSource: "setting" | "listings";
    reservations: number;
  };
}

export function computeOpsForecast(): OpsForecast {
  const a = getOpsAssumptions();
  const today = hotelToday();
  const curYm = today.slice(0, 7);
  const book = readBook(today);

  // ---- resolve the "0 = auto" knobs against our own data --------------------
  const unitsAuto = sellableUnits();
  const units = a.sellableUnits > 0 ? a.sellableUnits : unitsAuto;
  const adr = a.expectedAdr > 0 ? a.expectedAdr : book.trailingAdr;
  const avgStay = a.avgStayNights > 0 ? a.avgStayNights : book.avgStay > 0 ? book.avgStay : 30;

  const listings = listListings().filter((l) => l.active);
  const listingRent = sum(listings.map((l) => l.monthlyRent ?? 0));
  const listingUtils = sum(listings.map((l) => l.utilities ?? 0));
  const rentMonthly = a.rentPerUnitMonth > 0 ? a.rentPerUnitMonth * units : listingRent;
  const utilitiesMonthly =
    a.utilitiesPerUnitMonth > 0 ? a.utilitiesPerUnitMonth * units : listingUtils;

  // ---- month spine ----------------------------------------------------------
  const months: OpsMonth[] = [];
  for (let off = -a.historyMonths; off < a.horizonMonths; off++) {
    const key = addMonths(curYm, off);
    const dim = daysInMonth(key);
    const phase: OpsMonth["phase"] = off < 0 ? "past" : off === 0 ? "current" : "future";
    // Days still open to sell: none once the month is elapsed, the remainder of
    // the current month (today counts — tonight is still sellable), all of a
    // future month.
    const openDays =
      phase === "past" ? 0 : phase === "future" ? dim : dim - Number(today.slice(8, 10)) + 1;
    months.push({ key, label: monthLabel(key), phase, openDays: Math.max(0, openDays) });
  }
  const n = months.length;
  const zeros = () => new Array<number>(n).fill(0);

  // ---- per-month projection -------------------------------------------------
  const soldNights = zeros();
  const pickupNights = zeros();
  const otbRevenue = zeros();
  const pickupRevenue = zeros();
  const checkouts = zeros();
  const capacityNights = zeros();

  months.forEach((m, i) => {
    const f = book.byMonth.get(m.key);
    soldNights[i] = f?.soldNights ?? 0;
    otbRevenue[i] = f?.revenue ?? 0;
    capacityNights[i] = units * daysInMonth(m.key);

    // Pickup is only possible on the nights still open. Anything already sold
    // in that open window counts toward the target, so a month that is already
    // ahead of target picks up nothing.
    const openCapacity = units * m.openDays;
    const targetNights = (openCapacity * a.targetOccupancyPct) / 100;
    const alreadySoldOpen = f?.openSoldNights ?? 0;
    pickupNights[i] = Math.max(0, targetNights - alreadySoldOpen);
    pickupRevenue[i] = pickupNights[i] * adr;

    // Turnovers: the stays we know end this month, plus the ones the pickup
    // implies (a picked-up night belongs to a stay of avgStay nights).
    checkouts[i] = (f?.checkouts ?? 0) + (avgStay > 0 ? pickupNights[i] / avgStay : 0);
  });

  const revenue = months.map((_, i) => otbRevenue[i] + pickupRevenue[i]);
  const projectedNights = months.map((_, i) => soldNights[i] + pickupNights[i]);
  const occupancy = months.map((_, i) =>
    capacityNights[i] > 0 ? (projectedNights[i] / capacityNights[i]) * 100 : 0,
  );

  // ---- costs ----------------------------------------------------------------
  const perCheckout = a.cleaningPerCheckout + a.laundryPerCheckout + a.suppliesPerCheckout;
  const cleaning = checkouts.map((c) => c * a.cleaningPerCheckout);
  const laundry = checkouts.map((c) => c * a.laundryPerCheckout);
  const supplies = checkouts.map((c) => c * a.suppliesPerCheckout);
  const repairCount = months.map(() => units * a.repairsPerUnitMonth);
  const repairs = repairCount.map((c) => c * a.avgRepairCost);
  const rent = months.map(() => rentMonthly);
  const utilities = months.map(() => utilitiesMonthly);
  const salaries = months.map(() => a.salariesMonthly);
  const otherFixed = months.map(() => a.otherFixedMonthly);
  const ownerShare = revenue.map((r) => (r * a.ownerSharePct) / 100);
  const mgmtFee = revenue.map((r) => (r * a.mgmtFeePct) / 100);

  const costParts = [cleaning, laundry, supplies, repairs, rent, utilities, salaries, otherFixed, ownerShare, mgmtFee];
  const cost = months.map((_, i) => sum(costParts.map((p) => p[i])));
  const net = months.map((_, i) => revenue[i] - cost[i]);

  // ---- the locked plan, for the same months --------------------------------
  const plan = computeBridge({});
  const planIdx = new Map(plan.months.map((m, i) => [m, i]));
  const planLine = (id: string): number[] =>
    months.map((m) => {
      const i = planIdx.get(m.key);
      if (i == null) return 0;
      return plan.lines.find((l) => l.id === id)?.monthly[i] ?? 0;
    });
  const planRental = planLine("rentalRevenue");
  const planNet = months.map((m) => {
    const i = planIdx.get(m.key);
    return i == null ? 0 : plan.series.netIncome[i];
  });

  // ---- rows -----------------------------------------------------------------
  const rows: OpsRow[] = [];
  const push = (
    id: string,
    label: string,
    section: string,
    kind: OpsRow["kind"],
    monthly: number[],
    note?: string,
  ) => rows.push({ id, label, section, kind, monthly, total: sum(monthly), note });

  push("rev-otb", "On the books (sold)", "Revenue", "line", otbRevenue,
    "VAT-net reservation revenue, accrued per night");
  push("rev-pickup", "Expected pickup", "Revenue", "line", pickupRevenue,
    `open nights to ${a.targetOccupancyPct}% occupancy × ₪${Math.round(adr)} ADR`);
  push("rev-total", "Projected revenue", "Revenue", "subtotal", revenue);

  push("cost-cleaning", "Cleaning", "Costs", "line", cleaning, `₪${a.cleaningPerCheckout} per checkout`);
  push("cost-laundry", "Laundry", "Costs", "line", laundry, `₪${a.laundryPerCheckout} per checkout`);
  push("cost-supplies", "Consumables", "Costs", "line", supplies, `₪${a.suppliesPerCheckout} per checkout`);
  push("cost-repairs", "Repairs & maintenance", "Costs", "line", repairs,
    `${a.repairsPerUnitMonth}/apartment/month × ₪${a.avgRepairCost}`);
  push("cost-rent", "Apartment rent", "Costs", "line", rent,
    a.rentPerUnitMonth > 0 ? `₪${a.rentPerUnitMonth} × ${units} apartments` : "from Manage → per listing");
  push("cost-utilities", "Utilities", "Costs", "line", utilities,
    a.utilitiesPerUnitMonth > 0 ? `₪${a.utilitiesPerUnitMonth} × ${units} apartments` : "from Manage → per listing");
  push("cost-salaries", "Salaries", "Costs", "line", salaries);
  push("cost-other", "Other fixed", "Costs", "line", otherFixed);
  if (a.ownerSharePct > 0)
    push("cost-owner", `Owner share (${a.ownerSharePct}% of revenue)`, "Costs", "line", ownerShare);
  if (a.mgmtFeePct > 0)
    push("cost-mgmt", `Management fee (${a.mgmtFeePct}% of revenue)`, "Costs", "line", mgmtFee);
  push("cost-total", "Total costs", "Costs", "subtotal", cost);

  push("net", "Net result", "Result", "total", net);
  push("margin", "Margin %", "Result", "ratio",
    months.map((_, i) => (revenue[i] > 0 ? (net[i] / revenue[i]) * 100 : 0)));

  push("plan-rental", "Plan — rental revenue", "vs Plan", "line", planRental,
    "Bridge 11 m, untouched");
  push("plan-delta", "Δ revenue vs plan", "vs Plan", "line",
    months.map((_, i) => revenue[i] - planRental[i]));
  push("plan-net", "Plan — net income", "vs Plan", "line", planNet);
  push("plan-net-delta", "Δ net vs plan", "vs Plan", "line",
    months.map((_, i) => net[i] - planNet[i]));

  push("drv-units", "Apartments", "Drivers", "count", months.map(() => units));
  push("drv-occ", "Projected occupancy %", "Drivers", "ratio", occupancy);
  push("drv-sold", "Sold nights", "Drivers", "count", soldNights);
  push("drv-pickup-nights", "Pickup nights", "Drivers", "count", pickupNights);
  push("drv-checkouts", "Checkouts", "Drivers", "count", checkouts,
    perCheckout > 0 ? `₪${perCheckout} of variable cost each` : undefined);
  push("drv-repairs", "Repairs", "Drivers", "count", repairCount);

  // ---- forward-window summary ----------------------------------------------
  const fwd = months.map((m) => m.phase !== "past");
  const pick = (xs: number[]) => sum(xs.filter((_, i) => fwd[i]));
  const forwardRevenue = pick(revenue);
  const forwardCost = pick(cost);
  const forwardNet = forwardRevenue - forwardCost;
  const planRevenueFwd = pick(planRental);

  return {
    today,
    currency: "ILS",
    months,
    rows,
    revenueByMonth: revenue,
    costByMonth: cost,
    netByMonth: net,
    summary: {
      units,
      horizonMonths: a.horizonMonths,
      forwardRevenue,
      forwardCost,
      forwardNet,
      forwardMargin: forwardRevenue > 0 ? forwardNet / forwardRevenue : 0,
      onTheBooks: pick(otbRevenue),
      expectedPickup: pick(pickupRevenue),
      planRevenue: planRevenueFwd,
      planDelta: forwardRevenue - planRevenueFwd,
    },
    assumptions: a,
    derived: {
      units,
      unitsSource: a.sellableUnits > 0 ? "portfolio" : unitsAuto > 0 ? "pms" : "portfolio",
      adr,
      adrSource: a.expectedAdr > 0 ? "setting" : "realized",
      avgStay,
      avgStaySource: a.avgStayNights > 0 ? "setting" : "realized",
      rentMonthly,
      rentSource: a.rentPerUnitMonth > 0 ? "setting" : "listings",
      utilitiesMonthly,
      utilitiesSource: a.utilitiesPerUnitMonth > 0 ? "setting" : "listings",
      reservations: book.reservations,
    },
  };
}
