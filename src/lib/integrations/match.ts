import { listUnits } from "@/lib/repos/units";
import { listListings, setUnitListing } from "@/lib/repos/visibility";

/**
 * Suggest / auto-apply links between MiniHotel apartments (units) and our tracked
 * Airbnb listings, by comparing the apartment's name + room-type code against each
 * listing's label + address. Token-overlap scoring means an exact code token like
 * "tlv1" matches "tlv1" but not "tlv10", so numbered names line up cleanly.
 */

export interface MatchProposal {
  unitId: string;
  unitName: string;
  listingId: string;
  listingLabel: string;
  score: number;
}

// Minimum Jaccard score before a pairing is even proposed (and auto-applied).
// Without a floor, ANY shared token — a street name, a bare "14" — produced a
// nonzero score and automatch linked it, wiring the wrong apartment to a
// listing and poisoning everything keyed on the mapping.
const MIN_SCORE = 0.3;

// "TLV1" -> ["tlv1"], "TLV10 Rothschild 14" -> ["tlv10","rothschild","14"].
function tokenize(s: string): string[] {
  return (s ?? "").toLowerCase().match(/[a-z]+\d+|\d+|[a-z]{2,}/g) ?? [];
}

function score(aptText: string, listingText: string): number {
  const a = new Set(tokenize(aptText));
  const b = new Set(tokenize(listingText));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  if (inter === 0) return 0;
  return inter / (a.size + b.size - inter); // Jaccard; exact code tokens dominate
}

/** Greedy best-match of unlinked apartments to unused Airbnb listings. */
export function suggestMatches(): MatchProposal[] {
  const units = listUnits();
  const listings = listListings();
  const usedListing = new Set(listings.filter((l) => l.unitId).map((l) => l.id));
  const linkedUnit = new Set(
    listings.filter((l) => l.unitId).map((l) => l.unitId as string),
  );
  const openUnits = units.filter((u) => !linkedUnit.has(u.id));
  const openListings = listings.filter((l) => !usedListing.has(l.id));

  const pairs: MatchProposal[] = [];
  for (const u of openUnits) {
    const aptText = `${u.name} ${u.minihotelRoomType ?? ""}`;
    for (const l of openListings) {
      const s = score(aptText, `${l.label} ${l.address ?? ""}`);
      if (s >= MIN_SCORE) {
        pairs.push({ unitId: u.id, unitName: u.name, listingId: l.id, listingLabel: l.label, score: s });
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score);

  const takenU = new Set<string>();
  const takenL = new Set<string>();
  const out: MatchProposal[] = [];
  for (const p of pairs) {
    if (takenU.has(p.unitId) || takenL.has(p.listingId)) continue;
    takenU.add(p.unitId);
    takenL.add(p.listingId);
    out.push(p);
  }
  return out;
}

/** Apply the suggestions (links only currently-unlinked apartments). */
export function autoMatchUnitsToListings(): { matched: number; proposals: MatchProposal[] } {
  const proposals = suggestMatches();
  for (const p of proposals) setUnitListing(p.unitId, p.listingId);
  return { matched: proposals.length, proposals };
}
