import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Machine-to-machine endpoints the scraper box calls — these carry their own
// key auth (or are read-only config) and must bypass the browser login.
const BYPASS = [
  "/api/visibility/snapshot",
  "/api/visibility/config",
  "/api/rates/snapshot",
  // The reservations reader mirrors /api/rates/snapshot (x-scraper-key auth);
  // without the bypass, Basic auth 401s the box job and revenue actuals never land.
  "/api/reservations/snapshot",
  "/api/market/sync",
  // PriceLabs Market Dashboard PDF ingest (pricelabs_pdf.py posts here, x-scraper-key auth).
  "/api/market/pricelabs",
];

// Dual-use endpoints: the dashboard's "Pull/Push to MiniHotel" buttons call these
// from the browser (so they stay behind the normal login), but the nightly box
// cron drives them too. Rather than open them to everyone, let a valid
// x-scraper-key stand in for the login on these paths — browsers fall through to
// the usual Basic-auth check below, the cron presents the key.
const KEY_BYPASS = ["/api/rates/sync", "/api/rates/push"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (BYPASS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  if (KEY_BYPASS.some((p) => pathname.startsWith(p))) {
    const key = process.env.SCRAPER_API_KEY;
    if (key && req.headers.get("x-scraper-key") === key) {
      return NextResponse.next();
    }
    // No/invalid key → fall through to the browser Basic-auth check below.
  }

  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;
  // No credentials configured → dashboard stays open (unchanged behaviour).
  if (!user || !pass) return NextResponse.next();

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(":");
    if (sep !== -1 && decoded.slice(0, sep) === user && decoded.slice(sep + 1) === pass) {
      return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Rental Orchestrator Hub"' },
  });
}

export const config = {
  // Run on everything except Next internals / static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
