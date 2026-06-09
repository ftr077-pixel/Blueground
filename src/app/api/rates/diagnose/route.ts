import { NextResponse } from "next/server";
import { getMiniHotelConnection, getMiniHotelMapping } from "@/lib/repos/integrations";
import {
  fetchBulkAri,
  parseBulkAri,
  parseAriRoomTypes,
  extractMiniHotelErrors,
} from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

const todayUTC = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// One-shot diagnosis of why the Rates Calendar may be empty: what the Bulk ARI
// feed actually returns for the saved rate code, and whether those room types
// match the apartment mapping.
export async function POST() {
  const conn = getMiniHotelConnection();
  if (!conn.username || !conn.password || !conn.hotelId) {
    return NextResponse.json({ ok: false, message: "MiniHotel connection isn't configured (Settings)." });
  }

  let raw: string;
  try {
    raw = await fetchBulkAri(conn, todayUTC(), plusDays(todayUTC(), 2));
  } catch (e) {
    return NextResponse.json({
      ok: false,
      rateCode: conn.rateCode || "(none)",
      message: `Couldn't reach MiniHotel ARI: ${e instanceof Error ? e.message : "error"}`,
    });
  }

  const errors = extractMiniHotelErrors(raw);
  const cells = parseBulkAri(raw);
  const ariRoomTypeIds = parseAriRoomTypes(raw).map((t) => t.code);
  const mappedCodes = new Set(
    getMiniHotelMapping()
      .filter((m) => m.roomType)
      .map((m) => (m.roomType as string).trim().toUpperCase()),
  );
  const matched = ariRoomTypeIds.filter((id) => mappedCodes.has(id.trim().toUpperCase()));
  const unmatched = ariRoomTypeIds.filter((id) => !mappedCodes.has(id.trim().toUpperCase()));

  return NextResponse.json({
    ok: true,
    rateCode: conn.rateCode || "(none)",
    roomTypesInFeed: ariRoomTypeIds.length,
    sampleRoomTypeIds: ariRoomTypeIds.slice(0, 12),
    pricedCells: cells.length,
    mappedToUnits: matched.length,
    unmatchedRoomTypes: unmatched.slice(0, 12),
    errors: errors.slice(0, 5),
    rawHead: raw.replace(/\s+/g, " ").trim().slice(0, 280),
  });
}
