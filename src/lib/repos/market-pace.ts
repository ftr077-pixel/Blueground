import { getDb } from "@/lib/db";

// The market's booking pace per area (search profile) × stay length, supplied by
// the operator. Compared against our own realized pace (repos/bookings.ts) to
// answer "are we booking behind or ahead of the market?".
export interface MarketPaceRow {
  profileId: string;
  nights: number;
  medianLeadDays: number | null;
  leadCdf: Array<{ leadDays: number; bookedPct: number }> | null;
  updatedAt: string;
}

interface MarketPaceSql {
  profile_id: string;
  nights: number;
  median_lead_days: number | null;
  lead_cdf: string | null;
  updated_at: string;
}

function rowTo(r: MarketPaceSql): MarketPaceRow {
  return {
    profileId: r.profile_id,
    nights: r.nights,
    medianLeadDays: r.median_lead_days,
    leadCdf: r.lead_cdf ? (JSON.parse(r.lead_cdf) as MarketPaceRow["leadCdf"]) : null,
    updatedAt: r.updated_at,
  };
}

export function setMarketPace(
  rows: Array<{
    profileId: string;
    nights: number;
    medianLeadDays?: number | null;
    leadCdf?: Array<{ leadDays: number; bookedPct: number }> | null;
  }>,
): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO market_pace (profile_id, nights, median_lead_days, lead_cdf, updated_at)
     VALUES (@profile_id, @nights, @median_lead_days, @lead_cdf, @updated_at)
     ON CONFLICT(profile_id, nights) DO UPDATE SET
       median_lead_days=excluded.median_lead_days, lead_cdf=excluded.lead_cdf, updated_at=excluded.updated_at`,
  );
  const now = new Date().toISOString();
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.profileId || !Number.isFinite(r.nights)) continue;
      stmt.run({
        profile_id: r.profileId,
        nights: r.nights,
        median_lead_days: r.medianLeadDays ?? null,
        lead_cdf: r.leadCdf ? JSON.stringify(r.leadCdf) : null,
        updated_at: now,
      });
      n++;
    }
  });
  tx();
  return n;
}

export function getMarketPace(profileId: string, nights: number): MarketPaceRow | null {
  const db = getDb();
  const r = db
    .prepare("SELECT * FROM market_pace WHERE profile_id = ? AND nights = ?")
    .get(profileId, nights) as MarketPaceSql | undefined;
  return r ? rowTo(r) : null;
}

export function listMarketPace(): MarketPaceRow[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM market_pace ORDER BY profile_id, nights").all() as MarketPaceSql[]).map(rowTo);
}
