import { NextResponse } from "next/server";
import {
  listCicoProfiles,
  upsertCicoProfile,
  setCicoArchived,
  listMinStayProfiles,
  upsertMinStayProfile,
  setMinStayProfileArchived,
  listObaProfiles,
  upsertObaProfile,
  setObaProfileArchived,
  listPricingProfiles,
  upsertPricingProfile,
  setPricingProfileArchived,
  listSeasonalProfiles,
  upsertSeasonalProfile,
  setSeasonalProfileArchived,
  type MinStayProfilePayload,
  type ObaProfilePayload,
  type PricingProfilePayload,
  type SeasonalProfilePayload,
} from "@/lib/repos/profiles";
import { logActivity } from "@/lib/repos/activity";

export const dynamic = "force-dynamic";

// Restriction/customization profiles (PriceLabs "Profiles" tab): Check-in/
// Check-out, Min Stay, and custom OBA profiles. All share the same lifecycle —
// upsert by name, archive instead of delete, archived-but-attached keeps
// applying, and updating a profile propagates everywhere it's attached.

export async function GET(req: Request) {
  const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
  return NextResponse.json({
    cico: listCicoProfiles(includeArchived),
    minStay: listMinStayProfiles(includeArchived),
    oba: listObaProfiles(includeArchived),
    pricing: listPricingProfiles(includeArchived),
    seasonal: listSeasonalProfiles(includeArchived),
  });
}

export async function POST(req: Request) {
  let body: {
    save?: { name: string; allowedCheckin: number[]; allowedCheckout: number[] };
    archive?: string;
    unarchive?: string;
    saveMinStay?: { name: string; rules: MinStayProfilePayload };
    archiveMinStay?: string;
    unarchiveMinStay?: string;
    saveOba?: { name: string; windows: ObaProfilePayload["windows"] };
    archiveOba?: string;
    unarchiveOba?: string;
    savePricing?: { name: string; rules: PricingProfilePayload };
    archivePricing?: string;
    unarchivePricing?: string;
    saveSeasonal?: { name: string; payload: SeasonalProfilePayload };
    archiveSeasonal?: string;
    unarchiveSeasonal?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const log = (msg: string) =>
    logActivity({ department: "revenue", worker: "Pricing Specialist", message: msg, level: "success" });

  try {
    if (body.save) {
      upsertCicoProfile(body.save);
      log(`Check-in/Check-out profile "${body.save.name}" saved.`);
    } else if (body.archive !== undefined || body.unarchive !== undefined) {
      setCicoArchived(String(body.archive ?? body.unarchive), body.archive !== undefined);
    } else if (body.saveMinStay) {
      upsertMinStayProfile(body.saveMinStay.name, body.saveMinStay.rules ?? {});
      log(`Min Stay profile "${body.saveMinStay.name}" saved — propagates to every scope it's attached to.`);
    } else if (body.archiveMinStay !== undefined || body.unarchiveMinStay !== undefined) {
      setMinStayProfileArchived(
        String(body.archiveMinStay ?? body.unarchiveMinStay),
        body.archiveMinStay !== undefined,
      );
    } else if (body.saveOba) {
      upsertObaProfile(body.saveOba.name, { windows: body.saveOba.windows ?? [] });
      log(`OBA profile "${body.saveOba.name}" saved — propagates to every scope it's attached to.`);
    } else if (body.archiveOba !== undefined || body.unarchiveOba !== undefined) {
      setObaProfileArchived(String(body.archiveOba ?? body.unarchiveOba), body.archiveOba !== undefined);
    } else if (body.savePricing) {
      upsertPricingProfile(body.savePricing.name, body.savePricing.rules ?? {});
      log(`Pricing Profile "${body.savePricing.name}" saved — attach it to seasons in a seasonal profile.`);
    } else if (body.archivePricing !== undefined || body.unarchivePricing !== undefined) {
      setPricingProfileArchived(
        String(body.archivePricing ?? body.unarchivePricing),
        body.archivePricing !== undefined,
      );
    } else if (body.saveSeasonal) {
      upsertSeasonalProfile(body.saveSeasonal.name, body.saveSeasonal.payload ?? { mode: "fixed", seasons: [] });
      log(`Custom Seasonal Profile "${body.saveSeasonal.name}" saved — propagates to every scope it's attached to.`);
    } else if (body.archiveSeasonal !== undefined || body.unarchiveSeasonal !== undefined) {
      setSeasonalProfileArchived(
        String(body.archiveSeasonal ?? body.unarchiveSeasonal),
        body.archiveSeasonal !== undefined,
      );
    } else {
      return NextResponse.json({ error: "nothing to do" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "profile update failed" },
      { status: 400 },
    );
  }
  return NextResponse.json({
    ok: true,
    cico: listCicoProfiles(false),
    minStay: listMinStayProfiles(false),
    oba: listObaProfiles(false),
    pricing: listPricingProfiles(false),
    seasonal: listSeasonalProfiles(false),
  });
}
