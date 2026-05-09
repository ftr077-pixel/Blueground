export interface SynthesisTurn {
  id: string;
  turn: number;
  role: "player" | "coach";
  ts: string;
  title: string;
  summary: string;
  artifacts?: { kind: "code" | "bash" | "checklist" | "verdict"; body: string }[];
}

export interface TerminalLine {
  id: string;
  ts: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export const SYNTHESIS_WORKSPACE = {
  name: "rental-orchestrator-hub",
  contract: "spec.md",
  turnCount: 4,
  phase: "Validation Turn",
  state: "RUNNING" as "RUNNING" | "BLOCKED" | "COACH_APPROVED",
  startedAt: new Date(Date.now() - 1000 * 60 * 23).toISOString(),
};

export const SYNTHESIS_TURNS: SynthesisTurn[] = [
  {
    id: "t-01",
    turn: 1,
    role: "player",
    ts: new Date(Date.now() - 1000 * 60 * 22).toISOString(),
    title: "Scaffold Next.js shell + sidebar",
    summary:
      "Created package.json, tailwind config, sidebar nav for Operations + 4 departments, and a stub Mission Control page.",
    artifacts: [
      {
        kind: "bash",
        body:
          "$ npm install\n$ npx next build\n✓ Compiled successfully\n✓ Generating static pages (4/4)",
      },
    ],
  },
  {
    id: "t-02",
    turn: 1,
    role: "coach",
    ts: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
    title: "Surface contract incomplete",
    summary:
      "Build is green, but §2 of spec.md is not satisfied: Synthesis View and Action Center routes are missing. Mission Control renders department names but no per-worker status.",
    artifacts: [
      {
        kind: "checklist",
        body:
          "[x] Sidebar exposes 3 first-class views\n[x] Mission Control route reachable\n[ ] Mission Control shows per-worker status + last action\n[ ] Synthesis View route exists\n[ ] Action Center route exists",
      },
      {
        kind: "verdict",
        body: "IMMEDIATE ACTIONS NEEDED — implement worker rows + remaining routes.",
      },
    ],
  },
  {
    id: "t-03",
    turn: 2,
    role: "player",
    ts: new Date(Date.now() - 1000 * 60 * 16).toISOString(),
    title: "Department cards + activity feed",
    summary:
      "Added DepartmentCard with KPIs and per-worker rows (status, last action, metric). Added live activity feed timeline on Mission Control.",
    artifacts: [
      {
        kind: "code",
        body:
          "// src/components/department-card.tsx\nexport function DepartmentCard({ dept }: { dept: Department }) {\n  // KPIs grid + worker list with status pulse\n}",
      },
      {
        kind: "bash",
        body: "$ npx next build\n✓ Compiled successfully\nRoute (app)\n┌ ○ /                                    173 B    96.1 kB",
      },
    ],
  },
  {
    id: "t-04",
    turn: 2,
    role: "coach",
    ts: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
    title: "Mission Control accepted; remaining views still missing",
    summary:
      "Per-worker contract from §3 is now visible. Activity feed satisfies §2.1. Synthesis and Action Center routes still 404 — cannot approve.",
    artifacts: [
      {
        kind: "checklist",
        body:
          "[x] Mission Control surface complete\n[x] Per-worker status rendered for all 11 workers\n[ ] Synthesis View renders Player/Coach feed + terminal + spec.md\n[ ] Action Center renders approval queue with required fields",
      },
      {
        kind: "verdict",
        body: "IMMEDIATE ACTIONS NEEDED — build /synthesis and /action-center.",
      },
    ],
  },
  {
    id: "t-05",
    turn: 3,
    role: "player",
    ts: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
    title: "Synthesis + Action Center scaffolds",
    summary:
      "Added /synthesis with alternating Player/Coach feed, terminal pane, spec.md viewer, and loop status header. Added /action-center with approval queue items including department, worker, blast radius, and rationale.",
    artifacts: [
      {
        kind: "bash",
        body:
          "$ npx next build\n✓ Compiled successfully\nRoute (app)\n┌ ○ /                                    173 B    96.1 kB\n├ ○ /synthesis                           1.1 kB    97 kB\n└ ○ /action-center                       0.9 kB    96.8 kB",
      },
    ],
  },
  {
    id: "t-06",
    turn: 3,
    role: "coach",
    ts: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
    title: "Surface contract satisfied; auditing department drill-downs",
    summary:
      "All §2 surfaces present. spec.md §3 requires per-worker visibility — drill-down route /departments/[id] should let an operator inspect a single department in depth.",
    artifacts: [
      {
        kind: "checklist",
        body:
          "[x] /synthesis renders feed + terminal + spec.md\n[x] /action-center renders queue\n[~] /departments/[id] drill-down (recommended, not strictly in §2)",
      },
      {
        kind: "verdict",
        body:
          "IMMEDIATE ACTIONS NEEDED — add department drill-down to satisfy §3 inspection workflow.",
      },
    ],
  },
  {
    id: "t-07",
    turn: 4,
    role: "player",
    ts: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
    title: "Department drill-down route",
    summary:
      "Added /departments/[id] with per-department KPIs, worker roster, and a department-scoped activity slice. Sidebar links resolve.",
    artifacts: [
      {
        kind: "bash",
        body:
          "$ npx next build\n✓ Compiled successfully\n✓ Generating static pages (8/8)",
      },
    ],
  },
];

export const TERMINAL_LINES: TerminalLine[] = [
  { id: "l1", ts: "00:00.001", stream: "system", text: "[orchestrator] loaded spec.md (sha: 7e2c…ad11)" },
  { id: "l2", ts: "00:00.004", stream: "system", text: "[orchestrator] turn_count=0 phase=Init" },
  { id: "l3", ts: "00:00.214", stream: "stdout", text: "$ npm install --silent" },
  { id: "l4", ts: "00:24.800", stream: "stdout", text: "added 110 packages, audited 111 packages in 25s" },
  { id: "l5", ts: "00:24.812", stream: "stdout", text: "$ npx next build" },
  { id: "l6", ts: "00:31.402", stream: "stdout", text: "  ▲ Next.js 14.2.33" },
  { id: "l7", ts: "00:31.580", stream: "stdout", text: "   Creating an optimized production build ..." },
  { id: "l8", ts: "00:42.130", stream: "stdout", text: " ✓ Compiled successfully" },
  { id: "l9", ts: "00:42.401", stream: "stdout", text: "   Linting and checking validity of types ..." },
  { id: "l10", ts: "00:46.220", stream: "stdout", text: " ✓ Generating static pages (8/8)" },
  { id: "l11", ts: "00:46.221", stream: "stdout", text: "Route (app)                              Size     First Load JS" },
  { id: "l12", ts: "00:46.222", stream: "stdout", text: "┌ ○ /                                    173 B          96.1 kB" },
  { id: "l13", ts: "00:46.223", stream: "stdout", text: "├ ○ /synthesis                           1.1 kB         97.0 kB" },
  { id: "l14", ts: "00:46.224", stream: "stdout", text: "├ ○ /action-center                       0.9 kB         96.8 kB" },
  { id: "l15", ts: "00:46.225", stream: "stdout", text: "└ ● /departments/[id]                    1.4 kB         97.4 kB" },
  { id: "l16", ts: "00:46.230", stream: "system", text: "[orchestrator] handing off to Coach for validation turn 4" },
  { id: "l17", ts: "00:46.404", stream: "stdout", text: "$ pytest -q tests/spec_compliance.py" },
  { id: "l18", ts: "00:48.011", stream: "stderr", text: "tests/spec_compliance.py::test_action_center_fields PASSED" },
  { id: "l19", ts: "00:48.012", stream: "stderr", text: "tests/spec_compliance.py::test_synthesis_renders_spec PASSED" },
  { id: "l20", ts: "00:48.013", stream: "stderr", text: "tests/spec_compliance.py::test_workers_match_playbook PASSED" },
  { id: "l21", ts: "00:48.220", stream: "stdout", text: "5 passed in 1.81s" },
  { id: "l22", ts: "00:48.221", stream: "system", text: "[orchestrator] awaiting Coach verdict…" },
];

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
