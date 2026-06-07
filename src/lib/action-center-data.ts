// Seed data for the Action Center approval queue. Inserted into the
// `approval_items` table by lib/db.ts on first run.

export interface ApprovalItem {
  id: string;
  department: "revenue" | "logistics" | "guest" | "growth";
  worker: string;
  proposedAction: string;
  rationale: string;
  blastRadius: "low" | "medium" | "high";
  amount?: string;
  raisedAt: string;
  rule: string;
}

export const APPROVAL_QUEUE: ApprovalItem[] = [
  {
    id: "ac-001",
    department: "revenue",
    worker: "Pricing Specialist",
    proposedAction:
      "Lift nightly rate +18% on 4 Rothschild boulevard units for the DLD Festival week (May 26 – Jun 01).",
    rationale:
      "Demand model shows 3.2× normalized search volume for those nights; comp set already trending +14%. Move exceeds the §5 ±15% per-turn ceiling.",
    blastRadius: "medium",
    amount: "+18% (above 15% ceiling)",
    raisedAt: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
    rule: "spec.md §5 — pricing move > ±15%",
  },
  {
    id: "ac-002",
    department: "logistics",
    worker: "Maintenance Dispatcher",
    proposedAction:
      "Authorize emergency HVAC replacement at Kerem HaTeimanim 7 (₪9,200, technician on standby).",
    rationale:
      "Compressor failed mid-stay; inbound 30°C heatwave forecast. Cost exceeds department auto-approve threshold (₪3,000).",
    blastRadius: "high",
    amount: "₪9,200",
    raisedAt: new Date(Date.now() - 1000 * 60 * 11).toISOString(),
    rule: "spec.md §5 — maintenance over cost threshold",
  },
  {
    id: "ac-003",
    department: "growth",
    worker: "Underwriter Agent",
    proposedAction:
      "Send LOI for 2BR on Shabazi 41, Neve Tzedek (₪2.85M ask) — projected IRR 17.2% after furnishing.",
    rationale:
      "Passes 5/5 stress tests; comparable Shabazi unit ramped to 92% occupancy in 60 days. Per §5, all LOIs require human sign-off.",
    blastRadius: "high",
    amount: "₪2.85M ask",
    raisedAt: new Date(Date.now() - 1000 * 60 * 27).toISOString(),
    rule: "spec.md §5 — new-unit acquisition LOI",
  },
];
