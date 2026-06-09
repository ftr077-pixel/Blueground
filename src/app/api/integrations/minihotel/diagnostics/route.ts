import { NextResponse } from "next/server";
import { getMiniHotelConnection, miniHotelContentAuth, miniHotelEndpoints } from "@/lib/repos/integrations";
import {
  buildBulkAriRequest,
  buildRoomTypesRequest,
  buildReservationsRequest,
  extractMiniHotelErrors,
} from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

const todayUTC = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// Never leak secrets into a log the operator forwards to a third party.
const redact = (s: string) => s.replace(/password\s*=\s*"[^"]*"/gi, 'password="<redacted>"');

// Real authentication/permission failures — NOT downstream config validations
// (e.g. "ERR 310 Basic occupancy missing") that only happen after a successful login.
const AUTH_FAIL = /S00[489]\b|invalid credentials|\bERR\s?(210|109)\b|not linked|invalid agent|permission/i;

interface Probe {
  name: string;
  url: string;
  request: string;
  status: number | null;
  ms: number;
  bodySnippet: string;
  codes: string[];
  ok: boolean;
  authFailed: boolean;
  error?: string;
}

async function probe(name: string, url: string, body: string): Promise<Probe> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    const codes = extractMiniHotelErrors(text);
    const hasData = /<AvailRaters|<RoomTypes|<ArrayOfRoomTypes|<Bookings/i.test(text);
    // Auth failed = 401, or a credential/permission code. Config codes (ERR 310) don't count.
    const authFailed = res.status === 401 || AUTH_FAIL.test(text);
    const looksOk = res.status >= 200 && res.status < 300 && hasData && !authFailed;
    return {
      name,
      url,
      request: redact(body),
      status: res.status,
      ms: Date.now() - t0,
      bodySnippet: text.replace(/\s+/g, " ").trim().slice(0, 300),
      codes,
      ok: looksOk,
      authFailed,
    };
  } catch (e) {
    return {
      name,
      url,
      request: redact(body),
      status: null,
      ms: Date.now() - t0,
      bodySnippet: "",
      codes: [],
      ok: false,
      authFailed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatLog(opts: {
  conn: ReturnType<typeof getMiniHotelConnection>;
  endpoints: ReturnType<typeof miniHotelEndpoints>;
  probes: Probe[];
}): string {
  const { conn, probes } = opts;
  const line = (p: Probe) => {
    const verdict = p.error
      ? `UNREACHABLE — ${p.error}`
      : p.ok
        ? `OK — credentials accepted`
        : p.authFailed
          ? `FAIL — credentials rejected${p.codes[0] ? ` (${p.codes[0]})` : p.status === 401 ? " (HTTP 401 Invalid credentials)" : ""}`
          : `FAIL — ${p.codes[0] ?? `HTTP ${p.status}`}`;
    return [
      `[${p.name}]`,
      `    POST ${p.url}`,
      `    Request : ${p.request.slice(0, 240)}`,
      `    Response: ${p.status != null ? `HTTP ${p.status}` : "(no response)"} in ${p.ms} ms`,
      p.bodySnippet ? `    Body    : ${p.bodySnippet}` : null,
      p.codes.length ? `    Codes   : ${p.codes.join(" | ")}` : null,
      `    => ${verdict}`,
    ]
      .filter(Boolean)
      .join("\n");
  };

  const ariOk = probes.find((p) => p.name.startsWith("ARI"))?.ok;
  const contentAuthFails = probes.filter((p) => p.name.startsWith("Content") && p.authFailed);
  const unreachable = probes.some((p) => p.error);

  return [
    "MiniHotel API diagnostics — Rental Orchestrator Hub",
    `Generated : ${new Date().toISOString()}`,
    `Account   : hotel id "${conn.hotelId}", username "${conn.username}", env ${conn.env}`,
    "Note      : password redacted below. This request is sent from our whitelisted server.",
    "",
    "SUMMARY",
    ariOk
      ? "  • ARI API (api.minihotel.cloud) authenticates and responds OK with these credentials."
      : "  • ARI API did not respond OK (see below).",
    contentAuthFails.length
      ? '  • Content & Data API (api2.minihotel.cloud) rejects the SAME credentials with "Invalid credentials".'
      : "  • Content & Data API: see probes below.",
    unreachable
      ? "  • NOTE: one or more hosts were unreachable from where this ran — run this on the whitelisted box."
      : null,
    "",
    "REQUEST TO MINIHOTEL SUPPORT",
    `  Please enable the Content & Data API for hotel "${conn.hotelId}" / user "${conn.username}".`,
    "  Confirm whether it uses the same credentials or a separate login, and that our",
    "  server IP is whitelisted for api2.minihotel.cloud (not only the ARI host).",
    "",
    "PROBES",
    "============================================================",
    probes.map(line).join("\n------------------------------------------------------------\n"),
    "============================================================",
  ].join("\n");
}

export async function POST() {
  const conn = getMiniHotelConnection();
  if (!conn.username || !conn.password || !conn.hotelId) {
    return NextResponse.json({ ok: false, message: "Set username, password and hotel id first, then save." });
  }
  const ep = miniHotelEndpoints(conn.env);
  const from = todayUTC();

  // Same credentials against both APIs: ARI (should pass) vs Content & Data (the failing one).
  const probes = await Promise.all([
    probe("ARI — Bulk ARI (rates/availability)", ep.ari, buildBulkAriRequest(conn, from, plusDays(from, 1))),
    probe(
      "Content & Data — getRoomTypes",
      `${ep.content}/agents/ws/settings/rooms/RoomsMain.asmx/getRoomTypes`,
      buildRoomTypesRequest(conn),
    ),
    probe(
      "Content & Data — GetReservationKey (reservations)",
      `${ep.content}/api/Agents/Sci/Reservation/GetReservationKey`,
      buildReservationsRequest(conn, from, plusDays(from, 30)),
    ),
  ]);

  const usingSeparateContentLogin = !!(conn.contentUsername && conn.contentPassword);
  const log = formatLog({ conn, endpoints: ep, probes }) +
    (usingSeparateContentLogin ? `\n\n(Note: a separate Content API login "${conn.contentUsername}" is configured.)` : "");

  return NextResponse.json({ ok: true, generatedAt: new Date().toISOString(), log, probes });
}
