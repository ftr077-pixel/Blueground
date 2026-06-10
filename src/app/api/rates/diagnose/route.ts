import { NextResponse } from "next/server";
import { getMiniHotelConnection, getMiniHotelMapping } from "@/lib/repos/integrations";
import {
  fetchBulkAri,
  parseBulkAri,
  parseAriRoomTypes,
  extractMiniHotelErrors,
  fetchGuestsAvail,
  parseGuestsAvail,
  pushRatesToMiniHotel,
} from "@/lib/integrations/minihotel";

export const dynamic = "force-dynamic";

const todayUTC = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PushTestResult {
  attempted: boolean;
  message: string;
  unitId?: string;
  roomType?: string;
  date?: string;
  before?: number;
  pushedValue?: number;
  requestId?: string;
  pushErrors?: string[];
  readBack?: number | null;
  applied?: boolean;
  reverted?: boolean;
}

// One-shot diagnosis of why the Rates Calendar may be empty: what the Bulk ARI
// feed actually returns for the saved rate code, and whether those room types
// match the apartment mapping.
export async function POST(req: Request) {
  let body: { testPush?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }
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

  // When the bulk feed comes back empty/blocked, probe the guests-based
  // availability search (1 night) to see whether THAT endpoint can return rooms
  // despite the misconfigured room type — i.e. whether the Sync fallback works.
  let guests:
    | { roomTypes: number; priced: number; sample: string[]; errors: string[] }
    | undefined;
  if (cells.length === 0) {
    try {
      const graw = await fetchGuestsAvail(conn, todayUTC(), plusDays(todayUTC(), 1));
      const rooms = parseGuestsAvail(graw);
      guests = {
        roomTypes: rooms.length,
        priced: rooms.filter((r) => r.price != null).length,
        sample: rooms.slice(0, 12).map((r) => r.roomType),
        errors: extractMiniHotelErrors(graw).slice(0, 3),
      };
    } catch (e) {
      guests = {
        roomTypes: 0,
        priced: 0,
        sample: [],
        errors: [e instanceof Error ? e.message : "availability search failed"],
      };
    }
  }

  // Reverse-ARI write verification: push a 1-shekel test bump to ONE mapped
  // night, read the feed back, then revert. Proves end-to-end whether pushes
  // actually land in MiniHotel — and on which price list.
  let pushTest: PushTestResult | undefined;
  if (body.testPush) {
    if (!conn.rateCode || conn.rateCode.trim() === "") {
      pushTest = {
        attempted: false,
        message: "No price-list (rate) code set — Settings → Find rate code. Pushes can't write a price without it.",
      };
    } else {
      const unitByCode = new Map(
        getMiniHotelMapping()
          .filter((m) => m.roomType)
          .map((m) => [(m.roomType as string).trim().toUpperCase(), m.unitId]),
      );
      const tomorrow = plusDays(todayUTC(), 1);
      const cand = cells.find(
        (c) =>
          c.date >= tomorrow && c.price != null && unitByCode.has(c.roomType.trim().toUpperCase()),
      );
      if (!cand) {
        pushTest = {
          attempted: false,
          message:
            "No mapped room type with a priced future night in the feed — nothing safe to test-push against.",
        };
      } else {
        const unitId = unitByCode.get(cand.roomType.trim().toUpperCase())!;
        const before = Math.round(cand.price as number);
        const testPrice = before + 1;
        const res1 = await pushRatesToMiniHotel([{ unitId, date: cand.date, price: testPrice }]);
        let readBack: number | null = null;
        if (res1.ok || res1.errors.length === 0) {
          await sleep(2500); // give the PMS a beat to apply
          try {
            const rb = parseBulkAri(await fetchBulkAri(conn, cand.date, plusDays(cand.date, 1)));
            readBack =
              rb.find(
                (c) =>
                  c.date === cand.date &&
                  c.roomType.trim().toUpperCase() === cand.roomType.trim().toUpperCase(),
              )?.price ?? null;
          } catch {
            readBack = null;
          }
        }
        const applied = readBack != null && Math.round(readBack) === testPrice;
        const res2 = await pushRatesToMiniHotel([{ unitId, date: cand.date, price: before }]);
        pushTest = {
          attempted: true,
          unitId,
          roomType: cand.roomType,
          date: cand.date,
          before,
          pushedValue: testPrice,
          requestId: res1.requestId,
          pushErrors: [...res1.errors, ...(res1.message ? [res1.message] : [])].slice(0, 3),
          readBack,
          applied,
          reverted: res2.ok,
          message: applied
            ? `VERIFIED: pushed ₪${testPrice} to ${cand.roomType} ${cand.date}, read it back from the feed, reverted to ₪${before}. Pushes work.`
            : res1.errors.length || res1.message
              ? `Push REJECTED by MiniHotel — see errors. Nothing changed.`
              : `Push was ACCEPTED but the feed still reads ₪${readBack ?? "?"} (expected ₪${testPrice}). Almost always a price-list mismatch: we write to rate code "${conn.rateCode}" — check that your MiniHotel screen displays that same price list. (Test value reverted.)`,
        };
      }
    }
  }

  return NextResponse.json({
    ok: true,
    rateCode: conn.rateCode || "(none)",
    roomTypesInFeed: ariRoomTypeIds.length,
    sampleRoomTypeIds: ariRoomTypeIds.slice(0, 12),
    pricedCells: cells.length,
    mappedToUnits: matched.length,
    unmatchedRoomTypes: unmatched.slice(0, 12),
    errors: errors.slice(0, 5),
    guests,
    pushTest,
    rawHead: raw.replace(/\s+/g, " ").trim().slice(0, 280),
  });
}
