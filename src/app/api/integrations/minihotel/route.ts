import { NextResponse } from "next/server";
import {
  getMiniHotelConnectionView,
  saveMiniHotelConnection,
  type MiniHotelConnectionPatch,
} from "@/lib/repos/integrations";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getMiniHotelConnectionView());
}

export async function POST(req: Request) {
  let body: MiniHotelConnectionPatch & { env?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const patch: MiniHotelConnectionPatch = {};
  if (body.env !== undefined) patch.env = body.env === "production" ? "production" : "sandbox";
  if (typeof body.username === "string") patch.username = body.username;
  if (typeof body.hotelId === "string") patch.hotelId = body.hotelId;
  if (typeof body.rateCode === "string") patch.rateCode = body.rateCode;
  if (typeof body.password === "string") patch.password = body.password;
  if (typeof body.vatRate === "string") patch.vatRate = body.vatRate;
  if (typeof body.vatCountries === "string") patch.vatCountries = body.vatCountries;
  if (typeof body.excludedRoomTypes === "string") patch.excludedRoomTypes = body.excludedRoomTypes;

  saveMiniHotelConnection(patch);
  // Return the masked view so the client refreshes without ever seeing the password.
  return NextResponse.json(getMiniHotelConnectionView());
}
