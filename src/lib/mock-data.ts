import {
  Banknote,
  Boxes,
  ConciergeBell,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

export type WorkerStatus = "active" | "idle" | "attention";

export interface Worker {
  id: string;
  name: string;
  role: string;
  status: WorkerStatus;
  lastAction: string;
  metric: { label: string; value: string };
}

export interface Department {
  id: "revenue" | "logistics" | "guest" | "growth";
  name: string;
  director: string;
  tagline: string;
  icon: LucideIcon;
  accent: string;
  health: number;
  kpis: { label: string; value: string; delta?: string }[];
  workers: Worker[];
}

export const DEPARTMENTS: Department[] = [
  {
    id: "revenue",
    name: "Revenue & Yield",
    director: "Director: Yield Strategist",
    tagline: "Monitors occupancy calendars and market volatility.",
    icon: Banknote,
    accent: "from-emerald-500/20 to-emerald-500/5",
    health: 96,
    kpis: [
      { label: "Portfolio ADR", value: "₪812", delta: "+4.2%" },
      { label: "Occupancy (30d)", value: "91.4%", delta: "+1.8%" },
      { label: "RevPAR", value: "₪742", delta: "+6.1%" },
    ],
    workers: [
      {
        id: "rev-pricing",
        name: "Pricing Specialist",
        role: "Dynamic rate adjustment (Tel Aviv events, seasonality)",
        status: "active",
        lastAction: "Raised nightly rate +8% on 3 Neve Tzedek units (DLD Festival demand spike).",
        metric: { label: "Rate moves today", value: "27" },
      },
      {
        id: "rev-finance",
        name: "Financial Analyst",
        role: "ROI tracking incl. Mei Avivim, IEC, municipal taxes",
        status: "active",
        lastAction: "Reconciled Q2 utility variance — 4 units flagged for sub-meter audit.",
        metric: { label: "Avg unit ROI", value: "18.7%" },
      },
      {
        id: "rev-listing",
        name: "Listing Optimizer",
        role: "Blueground, Airbnb, and booking platform presence",
        status: "attention",
        lastAction: "Listing #BG-2231 ranking dropped on Airbnb — drafting refreshed copy + photos.",
        metric: { label: "Active listings", value: "84" },
      },
    ],
  },
  {
    id: "logistics",
    name: "Operational Logistics & QC",
    director: "Director: Operations Orchestrator",
    tagline: "Orchestrates check-in/out workflows.",
    icon: Boxes,
    accent: "from-sky-500/20 to-sky-500/5",
    health: 88,
    kpis: [
      { label: "Turnovers today", value: "11", delta: "+2" },
      { label: "QC pass rate", value: "98.2%" },
      { label: "Open tickets", value: "5" },
    ],
    workers: [
      {
        id: "log-qc",
        name: "Field QC Agent",
        role: "Visual confirmation of cleaning & setup standards",
        status: "active",
        lastAction: "Approved 9 turnovers via photo set; rejected 1 (linen creasing) on Rothschild 14.",
        metric: { label: "Turnovers verified", value: "9 / 10" },
      },
      {
        id: "log-maint",
        name: "Maintenance Dispatcher",
        role: "Triages guest issues and dispatches local technicians",
        status: "attention",
        lastAction: "Dispatched plumber to Kerem HaTeimanim 7 — water heater fault, ETA 45m.",
        metric: { label: "Open tickets", value: "5" },
      },
      {
        id: "log-supply",
        name: "Supply Manager",
        role: "Restocks toiletries, coffee, linens",
        status: "idle",
        lastAction: "Auto-ordered consumables for 14 units; next sweep at 18:00.",
        metric: { label: "PO this week", value: "₪6,340" },
      },
    ],
  },
  {
    id: "guest",
    name: "Guest Relations & Concierge",
    director: "Director: Guest Lifecycle Owner",
    tagline: "Owns the guest lifecycle from inquiry to 5-star review.",
    icon: ConciergeBell,
    accent: "from-violet-500/20 to-violet-500/5",
    health: 94,
    kpis: [
      { label: "Review score", value: "4.92★" },
      { label: "Inquiry → booking", value: "34%" },
      { label: "Avg LOS", value: "47 nights" },
    ],
    workers: [
      {
        id: "gst-inquiry",
        name: "Inquiry Specialist",
        role: "Converts leads into 30–90+ day bookings",
        status: "active",
        lastAction: "Closed 62-night booking (relocation, Florentin) — held rate, waived 1 cleaning.",
        metric: { label: "Pipeline", value: "23 leads" },
      },
      {
        id: "gst-concierge",
        name: "Digital Concierge",
        role: "Neighborhood guides + DigiTel service instructions",
        status: "active",
        lastAction: "Sent Kerem HaTeimanim food guide + DigiTel residency steps to guest #4412.",
        metric: { label: "Convos / day", value: "138" },
      },
      {
        id: "gst-review",
        name: "Review Strategist",
        role: "Feedback loops + sentiment analysis",
        status: "active",
        lastAction: "Detected 'noise' sentiment cluster in 3 Florentin units — ticketing acoustics review.",
        metric: { label: "Sentiment", value: "+0.81" },
      },
    ],
  },
  {
    id: "growth",
    name: "Growth & Portfolio Sourcing",
    director: "Director: Acquisition Lead",
    tagline: "Scouts for the next high-yield unit.",
    icon: TrendingUp,
    accent: "from-amber-500/20 to-amber-500/5",
    health: 82,
    kpis: [
      { label: "Candidates in funnel", value: "31" },
      { label: "Avg projected IRR", value: "16.4%" },
      { label: "LOIs out", value: "4" },
    ],
    workers: [
      {
        id: "grw-scraper",
        name: "Market Scraper",
        role: "Crawls Yad2, Madlan, OnMap and partner portals",
        status: "active",
        lastAction: "Surfaced 12 new candidates across Neve Tzedek and Lev HaIr; 3 advanced to underwriting.",
        metric: { label: "Listings scanned", value: "4,218" },
      },
      {
        id: "grw-underwriter",
        name: "Underwriter Agent",
        role: "Automated feasibility + ROI stress tests",
        status: "attention",
        lastAction: "Stress test on Allenby 88 failed (downside IRR 6.2%) — kicked back to scraper.",
        metric: { label: "Models run today", value: "47" },
      },
    ],
  },
];

export interface ActivityEvent {
  id: string;
  ts: string;
  department: Department["id"];
  worker: string;
  message: string;
  level: "info" | "success" | "warning" | "danger";
}

export const ACTIVITY_FEED: ActivityEvent[] = [
  {
    id: "evt-1",
    ts: new Date(Date.now() - 1000 * 35).toISOString(),
    department: "revenue",
    worker: "Pricing Specialist",
    message: "Lifted nightly rate on 3 Neve Tzedek units +8% — DLD Festival demand confirmed.",
    level: "success",
  },
  {
    id: "evt-2",
    ts: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
    department: "logistics",
    worker: "Maintenance Dispatcher",
    message: "Plumber dispatched to Kerem HaTeimanim 7 — guest reported lukewarm water at 14:02.",
    level: "warning",
  },
  {
    id: "evt-3",
    ts: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
    department: "guest",
    worker: "Inquiry Specialist",
    message: "Booking confirmed: 62 nights, Florentin studio, ₪48,720 total, source=Blueground.",
    level: "success",
  },
  {
    id: "evt-4",
    ts: new Date(Date.now() - 1000 * 60 * 9).toISOString(),
    department: "logistics",
    worker: "Field QC Agent",
    message: "Turnover REJECTED at Rothschild 14 — linen crease pattern below standard. Re-clean ordered.",
    level: "danger",
  },
  {
    id: "evt-5",
    ts: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
    department: "growth",
    worker: "Underwriter Agent",
    message: "Allenby 88 fails downside stress test (IRR 6.2% < 11% floor). Returned to sourcing.",
    level: "warning",
  },
  {
    id: "evt-6",
    ts: new Date(Date.now() - 1000 * 60 * 21).toISOString(),
    department: "guest",
    worker: "Digital Concierge",
    message: "Sent DigiTel residency walkthrough + Kerem HaTeimanim food guide to guest #4412.",
    level: "info",
  },
  {
    id: "evt-7",
    ts: new Date(Date.now() - 1000 * 60 * 28).toISOString(),
    department: "revenue",
    worker: "Listing Optimizer",
    message: "Listing #BG-2231 dropped 6 ranks on Airbnb — refreshed hero copy and reshot 4 photos.",
    level: "warning",
  },
  {
    id: "evt-8",
    ts: new Date(Date.now() - 1000 * 60 * 37).toISOString(),
    department: "growth",
    worker: "Market Scraper",
    message: "12 new sourcing candidates across Neve Tzedek + Lev HaIr; 3 advanced to underwriting.",
    level: "info",
  },
  {
    id: "evt-9",
    ts: new Date(Date.now() - 1000 * 60 * 52).toISOString(),
    department: "guest",
    worker: "Review Strategist",
    message: "Sentiment cluster detected: 'noise' across 3 Florentin units. Acoustics audit ticketed.",
    level: "warning",
  },
  {
    id: "evt-10",
    ts: new Date(Date.now() - 1000 * 60 * 64).toISOString(),
    department: "logistics",
    worker: "Supply Manager",
    message: "Auto-ordered consumables for 14 units (₪1,840). Next sweep scheduled 18:00 IDT.",
    level: "info",
  },
];

export const PORTFOLIO_SUMMARY = {
  unitsLive: 84,
  unitsOnboarding: 6,
  agentsOnline: 11,
  humanApprovalsPending: 3,
  avgHealth: Math.round(
    DEPARTMENTS.reduce((s, d) => s + d.health, 0) / DEPARTMENTS.length,
  ),
};
