# Requirements Contract — Rental Orchestrator Hub

> Ground-truth specification consumed by the Dialectical Orchestrator's
> **Coach** agent. The Coach must ignore prose claims of success and only
> evaluate behavior against this document and captured terminal logs.

## 1. Mission

Operate a Tel Aviv Mid-Term Rental portfolio without human micromanagement
by orchestrating four autonomous departments ("Digital Middle Managers"):
**Revenue & Yield**, **Operational Logistics & QC**, **Guest Relations &
Concierge**, and **Growth & Portfolio Sourcing**.

Humans are escalated to only via the **Action Center** queue.

## 2. Surface contract (UI)

The dashboard MUST expose three first-class views, each reachable from the
sidebar:

1. **Global Mission Control** (`/`)
   - Portfolio stat tiles (units live, agents online, avg dept health,
     pending human approvals).
   - One health card per department showing director, tagline, KPIs,
     and per-worker status + last action.
   - Live Middle Manager activity feed (chronological, severity-coded).

2. **Synthesis View** (`/synthesis`)
   - Alternating Player / Coach turn feed for the active workspace.
   - Live terminal pane streaming `stdout` + `stderr` from the sandbox.
   - Side panel rendering this `spec.md` so reviewers see the contract
     the Coach is grading against.
   - Loop status indicator: turn count, current phase, terminal state
     (one of `RUNNING`, `BLOCKED`, `COACH_APPROVED`).

3. **Action Center** (`/action-center`)
   - Queue of agent-flagged anomalies awaiting human approval.
   - Each item declares: department, worker, proposed action, blast
     radius, and the reason it was escalated.
   - Approve / reject controls (mocked in this milestone).

## 3. Department contract

For each of the four departments the dashboard MUST surface:

- The Director's mandate (one line).
- The set of Active Workers from the playbook below.
- Each worker's current status: `active`, `idle`, or `attention`.
- The worker's most recent meaningful action (free-text, < 240 chars).
- One headline metric per worker.

### 3.1 Revenue & Yield
- **Pricing Specialist** — dynamic rate adjustment (Tel Aviv events,
  seasonality).
- **Financial Analyst** — ROI per unit incl. Mei Avivim, IEC, municipal
  taxes.
- **Listing Optimizer** — Blueground, Airbnb, partner platform presence.

### 3.2 Operational Logistics & QC
- **Field QC Agent** — visual confirmation of cleaning + setup standards.
- **Maintenance Dispatcher** — triage + dispatch local technicians.
- **Supply Manager** — automated restocking of consumables.

### 3.3 Guest Relations & Concierge
- **Inquiry Specialist** — convert leads into 30–90+ night bookings.
- **Digital Concierge** — neighborhood guides + DigiTel residency
  instructions.
- **Review Strategist** — feedback loops + sentiment analysis.

### 3.4 Growth & Portfolio Sourcing
- **Market Scraper** — discover new listings on real-estate portals.
- **Underwriter Agent** — feasibility + ROI stress tests on candidates.

## 4. Dialectical Loop contract

The orchestrator runs a **Player vs. Coach** loop in a bounded workspace.

### 4.1 Phases
- **Init** — load `spec.md`; set `turn_count = 0`.
- **Execution Turn** — the Player generates code + bash commands; the
  orchestrator executes them in the sandbox and captures `stdout` /
  `stderr`.
- **Validation Turn** — the Coach receives the diff + terminal logs and
  evaluates against this `spec.md`. The Coach MUST produce:
  - an `[x]` / `[ ]` checklist of every requirement in §2 and §3,
  - either an `IMMEDIATE ACTIONS NEEDED` block, or
  - a `FINAL STATUS: COACH APPROVED` line.

### 4.2 Routing
- If the Coach emits `IMMEDIATE ACTIONS NEEDED`, increment `turn_count`
  and loop back to Execution.
- If the Coach emits `FINAL STATUS: COACH APPROVED`, terminate the loop
  successfully.
- A `turn_count >= 12` without approval transitions the loop to
  `BLOCKED` and pages a human via the Action Center.

### 4.3 Coach invariants
- Ignore prose claims of success. Only terminal logs and the rendered
  surfaces count.
- Never approve while any §2 surface is missing or any §3 worker is
  unrepresented.
- Never approve a turn whose terminal output ended in a non-zero exit
  code unless the failure is explicitly documented in this spec.

## 5. Human-in-the-Loop contract

The Action Center MUST escalate (and block autonomous execution on) any
of the following:

- A pricing move > ±15% in a single turn.
- A maintenance dispatch above a department-defined cost threshold.
- A new-unit acquisition LOI.
- Any guest refund or compensation > ₪500.
- A turn `BLOCKED` by §4.2.

## 6. Non-goals (this milestone)

- Real integrations with Blueground / Airbnb / Yad2.
- Persisting orchestrator state to a database.
- Authenticated users — single operator view is sufficient.
