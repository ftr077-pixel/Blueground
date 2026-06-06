// Pure (no-DB) parsing + column mapping for the property/unit CSV importer.
//
// Accepts CSV *or* TSV — copy-pasting a range straight out of Google Sheets
// yields tab-separated values, while "File ▸ Download ▸ CSV" yields commas, so
// we support both. Headers from the sheet are mapped onto the `units` schema
// with forgiving aliases, so the operator doesn't have to rename columns first.

export type FieldKey =
  | "id"
  | "name"
  | "neighborhood"
  | "bedrooms"
  | "baseRate"
  | "currentRate"
  | "occupancy30d"
  | "platform";

export interface ParsedUnit {
  id: string | null;
  name: string;
  neighborhood: string;
  bedrooms: number;
  baseRate: number;
  currentRate: number;
  occupancy30d: number;
  platform: string;
}

export interface ParsedRow {
  line: number; // 1-based data-row index (header row excluded)
  unit: ParsedUnit | null;
  error: string | null;
}

export interface ParseResult {
  delimiter: "tab" | "comma";
  headers: string[];
  mapping: Record<FieldKey, string | null>; // target field -> source header (or null)
  present: FieldKey[]; // fields actually backed by a column
  unmapped: string[]; // headers we couldn't place (ignored)
  rows: ParsedRow[];
  valid: number;
  errors: number;
}

// Normalized header aliases. Matching is done on a stripped form (lowercase,
// alphanumerics only) so "Base Rate", "base_rate" and "BASE-RATE" all collapse.
const FIELD_ALIASES: Record<FieldKey, string[]> = {
  id: ["id", "unit", "unitid", "code", "unitcode", "ref", "reference", "propertyid", "listingid", "sku"],
  name: [
    "name", "title", "listing", "listingname", "property", "propertyname",
    "unitname", "apartment", "apartmentname", "address", "addr", "street",
  ],
  neighborhood: ["neighborhood", "neighbourhood", "hood", "area", "district", "location", "city", "zone", "quarter"],
  bedrooms: ["bedrooms", "bedroom", "beds", "bed", "br", "rooms", "bedroomcount", "numbedrooms", "noofbedrooms", "bdr"],
  baseRate: [
    "baserate", "base", "baseprice", "baserent", "basenightly", "listprice",
    "rate", "price", "nightlyrate", "nightly", "rent", "pricepernight", "nightlyprice", "adr",
  ],
  currentRate: ["currentrate", "current", "currentprice", "currentrent", "liverate", "activerate", "sellingrate", "currentnightly", "todayrate"],
  occupancy30d: ["occupancy30d", "occupancy", "occ", "occ30", "occ30d", "occupancyrate", "occupancy30", "occupancypct", "occupancypercent", "occupied"],
  platform: ["platform", "channel", "source", "listedon", "site", "provider", "ota", "managedby"],
};

// Specific fields claim their header before generic money columns ("rate"/
// "price" should land on baseRate, leaving currentRate to fall back to it).
const FIELD_PRIORITY: FieldKey[] = [
  "id",
  "name",
  "neighborhood",
  "bedrooms",
  "occupancy30d",
  "platform",
  "baseRate",
  "currentRate",
];

function emptyMapping(): Record<FieldKey, string | null> {
  return {
    id: null,
    name: null,
    neighborhood: null,
    bedrooms: null,
    baseRate: null,
    currentRate: null,
    occupancy30d: null,
    platform: null,
  };
}

function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function detectDelimiter(text: string): "tab" | "comma" {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > 0 && tabs >= commas ? "tab" : "comma";
}

// RFC-4180-ish reader: handles quoted fields, escaped ("") quotes, and quoted
// newlines/delimiters. Fully blank rows are dropped.
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      endField();
    } else if (c === "\n") {
      endRow();
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) endRow();

  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function buildMapping(headers: string[]): {
  mapping: Record<FieldKey, string | null>;
  unmapped: string[];
} {
  const normd = headers.map(normHeader);
  const used = new Array(headers.length).fill(false);
  const mapping = emptyMapping();

  for (const field of FIELD_PRIORITY) {
    const aliases = FIELD_ALIASES[field];
    for (let i = 0; i < headers.length; i++) {
      if (used[i]) continue;
      if (aliases.includes(normd[i])) {
        mapping[field] = headers[i];
        used[i] = true;
        break;
      }
    }
  }

  const unmapped = headers.filter((_, i) => !used[i]);
  return { mapping, unmapped };
}

function coerceBedrooms(v: string): number {
  const s = v.trim().toLowerCase();
  if (!s) return 0;
  if (s.includes("studio")) return 0; // "Studio" → 0BR
  const m = s.match(/\d+(?:\.\d+)?/); // "2BR", "2 bed", "3" → 2/2/3
  return m ? Math.max(0, Math.round(parseFloat(m[0]))) : 0;
}

function coerceMoney(v: string): number {
  const s = v.replace(/[^0-9.]/g, ""); // strip ₪ $ € , and spaces
  if (!s) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function coerceOccupancy(v: string): number {
  const hasPct = v.includes("%");
  const s = v.replace(/[^0-9.]/g, "");
  if (!s) return 0;
  let n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  if (hasPct || n > 1.5) n /= 100; // "91%" / "91" → 0.91; "0.91" stays
  return Math.min(1, Math.max(0, n));
}

export function parseUnitsCsv(text: string): ParseResult {
  const delimiter = detectDelimiter(text);
  const matrix = parseDelimited(text, delimiter === "tab" ? "\t" : ",");
  if (matrix.length === 0) {
    return {
      delimiter,
      headers: [],
      mapping: emptyMapping(),
      present: [],
      unmapped: [],
      rows: [],
      valid: 0,
      errors: 0,
    };
  }

  const headers = matrix[0].map((h) => h.trim());
  const { mapping, unmapped } = buildMapping(headers);
  const present = (Object.keys(mapping) as FieldKey[]).filter((k) => mapping[k] !== null);

  const idx = {} as Record<FieldKey, number>;
  for (const k of present) idx[k] = headers.indexOf(mapping[k] as string);
  const cell = (cols: string[], k: FieldKey): string =>
    k in idx ? (cols[idx[k]] ?? "").trim() : "";

  const nameMapped = mapping.name !== null;
  const rows: ParsedRow[] = [];
  let valid = 0;
  let errors = 0;

  for (let r = 1; r < matrix.length; r++) {
    const cols = matrix[r];
    const line = r;

    if (!nameMapped) {
      rows.push({ line, unit: null, error: 'No "Name" column found — add or rename one.' });
      errors++;
      continue;
    }
    const name = cell(cols, "name");
    if (!name) {
      rows.push({ line, unit: null, error: "Missing name" });
      errors++;
      continue;
    }

    const baseRate = present.includes("baseRate") ? coerceMoney(cell(cols, "baseRate")) : 0;
    const currentRate = present.includes("currentRate")
      ? coerceMoney(cell(cols, "currentRate"))
      : baseRate; // single price column drives both

    rows.push({
      line,
      error: null,
      unit: {
        id: present.includes("id") ? cell(cols, "id") || null : null,
        name,
        neighborhood: cell(cols, "neighborhood"),
        bedrooms: coerceBedrooms(cell(cols, "bedrooms")),
        baseRate,
        currentRate,
        occupancy30d: coerceOccupancy(cell(cols, "occupancy30d")),
        platform: cell(cols, "platform") || "Blueground",
      },
    });
    valid++;
  }

  return { delimiter, headers, mapping, present, unmapped, rows, valid, errors };
}
