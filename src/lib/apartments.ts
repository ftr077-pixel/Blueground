// The live Tel-Aviv portfolio — the operator's apartment list, keyed by the
// internal apartment ID. This is the single source of truth for "which number
// is which apartment": the same ID the operator sees under each internal name
// in the Airbnb/MiniHotel sync. IDs are intentionally sparse (some numbers
// retired), so we key off the explicit id, not array position.
//
// Client-safe: pure data + string helpers, no Node/sqlite imports.
export const APARTMENTS: ReadonlyArray<readonly [number, string]> = [
  [1, "Florentin 7, 23"],
  [2, "Herzl 114, 32"],
  [3, "Herzl 114, 2"],
  [4, "Herzl 114, 14"],
  [5, "Herzl 114, 3"],
  [6, "Rambam 24, 7"],
  [7, "Rambam 24, 10"],
  [8, "Rambam 24, 11"],
  [9, "Rambam 24, 12"],
  [10, "Rambam 24, 16"],
  [11, "Rambam 24, 15"],
  [12, "Markolet 5, 3"],
  [13, "Halutzim 28, 1"],
  [14, "Halutzim 28, 2"],
  [15, "Halutzim 28, 3"],
  [16, "Halutzim 28, 4"],
  [17, "Halutzim 28, 5"],
  [18, "Halutzim 28, 6"],
  [19, "Halutzim 28, 7"],
  [20, "Halutzim 28, 8"],
  [21, "Halutzim 28, 9"],
  [22, "Trumpeldor 20, 6"],
  [23, "Levontin 26, 23"],
  [24, "Markolet 5, 4"],
  [25, "Markolet 5, 10"],
  [26, "Markolet 5, 14"],
  [27, "Rambam 24, 17"],
  [28, "Rambam 24, 19"],
  [29, "Harugei Malchut 10, 5"],
  [30, "Mohaliver Street 31, 2"],
  [31, "Mohaliver Street 31, 4"],
  [32, "Mohaliver Street 31, 11"],
  [33, "Mohaliver Street 31, 12"],
  [34, "Mohaliver Street 31, 13"],
  [35, "Mohaliver Street 31, 15"],
  [36, "Mohaliver Street 31, 16"],
  [37, "Mohaliver Street 31, 17"],
  [38, "Trumpeldor 20, 7"],
  [39, "Dizengoff 282, 4"],
  [40, "Meitav 5, 140"],
  [41, "Menachem Begin 158, 166"],
  [42, "Dizengoff 288, 3"],
  [43, "Dizengoff 288, 10"],
  [44, "Markolet 5, 8"],
  [45, "Rambam 24, 1"],
  [46, "Levontin 26, 3"],
  [47, "Rambam 24, 18"],
  [48, "Herzl 4, 9"],
  [49, "Dizengoff 288, 9"],
  [50, "Mohaliver Street 31, 9"],
  [51, "Nahalat Binyamin 9, 3"],
  [52, "Nahalat Binyamin 9, 4"],
  [53, "Nahalat Binyamin 9, 5"],
  [54, "Nahalat Binyamin 9, 6"],
  [55, "Nahalat Binyamin 9, 7"],
  [56, "Nahalat Binyamin 9, 8"],
  [57, "Nahalat Binyamin 9, 9"],
  [58, "Nahalat Binyamin 9, 10"],
  [59, "Menachem Begin 160, 148"],
  [60, "Wyssotsky 6, 24"],
  [61, "Wyssotsky 6, 25"],
  [63, "Rambam 24, 9"],
  [64, "Shlomo Ibn Gabirol Street 144, 20"],
  [65, "Derech Menachem Begin 160, 149"],
  [66, "Jerusalem Boulevard 1, 17"],
  [67, "Wyssotsky 8, 74"],
  [68, "Shlomo Ibn Gabirol Street 144, 16"],
  [70, "HaYarkon Street 276, #2"],
  [71, "HaYarkon Street 276, #3"],
  [72, "HaYarkon Street 276, #4"],
  [73, "HaYarkon Street 276, #5"],
  [74, "HaYarkon Street 276, #6"],
  [75, "HaYarkon Street 276, #7"],
  [76, "Florentin 7, 22"],
  [77, "Shlomo Ibn Gabirol Street 144, 24"],
  [78, "Rambam 24, 2"],
  [79, "Nitzana 9"],
  [80, "Arlozorov 33, 4A"],
  [81, "Arlozorov 33, 4B"],
  [82, "Rembrandt 20, 10"],
  [83, "Shlomo Ibn Gabirol Street 144, 6"],
  [84, "Melchett 52, 3"],
  [85, "Allenby 114, 3"],
  [86, "Allenby 114, 4"],
  [87, "Allenby 114, 5"],
  [88, "Allenby 114, 6"],
  [89, "Allenby 114, 7"],
  [90, "Allenby 114, 8"],
  [91, "Allenby 114, 9"],
  [92, "Allenby 114, 10"],
  [93, "Allenby 114, 11"],
  [94, "Allenby 114, 12"],
  [95, "Allenby 114, 13"],
  [96, "Allenby 114, 14"],
  [97, "Allenby 114, 15"],
  [98, "Allenby 114, 16"],
  [99, "Allenby 114, 17"],
  [100, "Yavnieli 24, 15"],
  [101, "Trumpeldor 20, 5"],
  [102, "Rambam 24, 3"],
  [103, "Trumpeldor 20, 4"],
  [105, "Rambam 24, 14"],
  [112, "Yitzhak Elhanan 14, 14"],
  [113, "HaYarkon 276, 9"],
  [114, "Levontin 26, 2"],
  [115, "Totzeret HaAretz 5 apt 289"],
];

const ADDRESS_BY_ID = new Map<number, string>(APARTMENTS);

export function apartmentAddress(n: number): string | undefined {
  return ADDRESS_BY_ID.get(n);
}

// Neighborhood grouping = the street (everything before the building number).
export function streetOf(addr: string): string {
  const m = addr.match(/^(.*?)[\s,]*\d/);
  return (m ? m[1] : addr).replace(/[,\s]+$/, "").trim() || addr;
}

/**
 * Extract the apartment ID from a unit's internal name, the way it arrives
 * from the operator's Airbnb/MiniHotel sync — the ID is written into the
 * internal name, e.g. "1. Florentine723", "#12 Herzl 114-2", "TLV 12".
 * Strict on purpose: only a leading "<n>." / "#<n>" / "<n> -" style marker or
 * a TLV<n> tag counts, and the number must exist in the portfolio. Incidental
 * digits (street/apartment numbers like "Markolet 5, 3") never match.
 */
export function apartmentIdFromName(name: string): number | null {
  const m =
    name.match(/^\s*#?\s*(\d{1,4})\s*[.\-–—·:]/) ??
    name.match(/^\s*#\s*(\d{1,4})\b/) ??
    name.match(/\btlv[\s#]*(\d{1,4})\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return ADDRESS_BY_ID.has(n) ? n : null;
}

/**
 * The apartment ID for a unit. The internal name is authoritative (that's
 * where the ID lives in the operator's sync); seeded units fall back to their
 * "BG-<n>" id, which is the apartment ID by construction. Anything else —
 * e.g. a MiniHotel room-type code like "MH-204" — is NOT an apartment ID, so
 * we return null rather than display a number that means nothing.
 */
export function apartmentIdFromUnit(unit: { id: string; name: string }): number | null {
  const fromName = apartmentIdFromName(unit.name);
  if (fromName != null) return fromName;
  const m = unit.id.match(/^BG-(\d{1,4})$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (ADDRESS_BY_ID.has(n)) return n;
  }
  return null;
}

/** "<id> · <address>" when the ID is known; otherwise just the unit's name. */
export function apartmentDisplayParts(unit: { id: string; name: string }): {
  num: number | null;
  text: string;
} {
  const num = apartmentIdFromUnit(unit);
  return { num, text: num != null ? ADDRESS_BY_ID.get(num) ?? unit.name : unit.name };
}

export function apartmentLabel(unit: { id: string; name: string }): string {
  const { num, text } = apartmentDisplayParts(unit);
  return num != null ? `${num} · ${text}` : text;
}
