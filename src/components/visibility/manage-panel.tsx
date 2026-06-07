"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Profile {
  id: string;
  label: string;
  guests: number;
  currency: string;
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
  zoom: number;
  stayNights: number[];
  startDates: string[];
  dateMode: string;
  active: boolean;
}

interface Listing {
  id: string;
  airbnbId: string;
  label: string;
  profileId: string;
  guests: number | null;
  startDates: string[] | null;
  monthlyRent: number | null;
  utilities: number | null;
  cleaningFee: number | null;
  address: string | null;
  active: boolean;
}

const input =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";

function ListingRow({
  l,
  profile,
  busy,
  onPatch,
  onDelete,
}: {
  l: Listing;
  profile: Profile | undefined;
  busy: boolean;
  onPatch: (id: string, body: Record<string, unknown>) => void;
  onDelete: (l: Listing) => void;
}) {
  const [name, setName] = useState(l.label);
  const [guests, setGuests] = useState(l.guests != null ? String(l.guests) : "");
  const [dates, setDates] = useState(l.startDates ? l.startDates.join(", ") : "");
  const [address, setAddress] = useState(l.address ?? "");
  const [rent, setRent] = useState(l.monthlyRent != null ? String(l.monthlyRent) : "");
  const [util, setUtil] = useState(l.utilities != null ? String(l.utilities) : "");
  const [clean, setClean] = useState(l.cleaningFee != null ? String(l.cleaningFee) : "");
  const parseNum = (s: string) => {
    const n = parseFloat(s);
    return s.trim() && Number.isFinite(n) ? n : null;
  };

  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-background/40 px-3 py-2 ${
        l.active ? "" : "opacity-60"
      }`}
    >
      <input
        className={`${input} w-40`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name.trim() && name.trim() !== l.label) onPatch(l.id, { label: name.trim() });
        }}
        title="Name"
      />
      <span className="text-[10px] font-mono text-muted-foreground">{l.airbnbId}</span>
      <input
        className={`${input} w-44`}
        value={address}
        placeholder="Address"
        title="Address"
        onChange={(e) => setAddress(e.target.value)}
        onBlur={() => onPatch(l.id, { address: address.trim() || null })}
      />
      <input
        className={`${input} w-14`}
        value={guests}
        placeholder={profile ? String(profile.guests) : "2"}
        onChange={(e) => setGuests(e.target.value)}
        onBlur={() => onPatch(l.id, { guests: guests.trim() ? parseInt(guests, 10) : null })}
        title="Guests (blank = profile default)"
      />
      <input
        className={`${input} w-44`}
        value={dates}
        placeholder={profile && profile.startDates.length ? profile.startDates.join(", ") : "profile dates"}
        onChange={(e) => setDates(e.target.value)}
        onBlur={() =>
          onPatch(l.id, {
            startDates: dates.trim()
              ? dates.split(",").map((s) => s.trim()).filter(Boolean)
              : null,
          })
        }
        title="Check-in dates (blank = profile default)"
      />
      <input
        className={`${input} w-20`}
        value={rent}
        placeholder="Rent/mo"
        title="Monthly rent (your cost)"
        onChange={(e) => setRent(e.target.value)}
        onBlur={() => onPatch(l.id, { monthlyRent: parseNum(rent) })}
      />
      <input
        className={`${input} w-20`}
        value={util}
        placeholder="Utils/mo"
        title="Monthly utilities (your cost)"
        onChange={(e) => setUtil(e.target.value)}
        onBlur={() => onPatch(l.id, { utilities: parseNum(util) })}
      />
      <input
        className={`${input} w-20`}
        value={clean}
        placeholder="Cleaning"
        title="Cleaning fee per stay (your cost)"
        onChange={(e) => setClean(e.target.value)}
        onBlur={() => onPatch(l.id, { cleaningFee: parseNum(clean) })}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => onPatch(l.id, { active: !l.active })}
        className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        {l.active ? "Pause" : "Resume"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => onDelete(l)}
        className="text-muted-foreground hover:text-[hsl(var(--danger))]"
        title="Remove listing"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function ManagePanel() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/visibility", { cache: "no-store" });
    const body = (await res.json()) as { profiles: Profile[]; listings: Listing[] };
    setProfiles(body.profiles);
    setListings(body.listings);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function call(url: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error || `request failed (${res.status})`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  // ---- scanner settings (proxy) ----
  const [proxyUrl, setProxyUrl] = useState("");
  const [availabilityDays, setAvailabilityDays] = useState("90");
  const [primaryStay, setPrimaryStay] = useState("30");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/visibility/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((s: { proxyUrl?: string; availabilityDays?: number; primaryStay?: number }) => {
        setProxyUrl(s.proxyUrl || "");
        if (s.availabilityDays) setAvailabilityDays(String(s.availabilityDays));
        if (s.primaryStay) setPrimaryStay(String(s.primaryStay));
      })
      .catch(() => undefined);
  }, []);

  async function saveSettings() {
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/visibility/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proxyUrl,
          availabilityDays: parseInt(availabilityDays, 10) || 90,
          primaryStay: parseInt(primaryStay, 10) || 30,
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError("could not save settings");
    } finally {
      setBusy(false);
    }
  }

  // ---- new profile form ----
  const [pLabel, setPLabel] = useState("");
  const [pGuests, setPGuests] = useState("2");
  const [pCurrency, setPCurrency] = useState("ILS");
  const [pStays, setPStays] = useState("7,14,30");
  const [pDates, setPDates] = useState("");
  const [pBox, setPBox] = useState("32.04,34.74,32.12,34.83");
  const [pZoom, setPZoom] = useState("14");
  const [pDateMode, setPDateMode] = useState("fixed");

  async function addProfile() {
    const parts = pBox.split(",").map((s) => parseFloat(s.trim()));
    if (!pLabel.trim()) {
      setError("profile needs a name");
      return;
    }
    await call("/api/visibility/profiles", "POST", {
      label: pLabel.trim(),
      guests: parseInt(pGuests, 10) || 2,
      currency: pCurrency.trim() || "ILS",
      stayNights: pStays.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0),
      startDates: pDates.split(",").map((s) => s.trim()).filter(Boolean),
      swLat: parts[0],
      swLng: parts[1],
      neLat: parts[2],
      neLng: parts[3],
      zoom: parseInt(pZoom, 10) || 14,
      dateMode: pDateMode,
    });
    setPLabel("");
    setPDates("");
  }

  // ---- new listing form ----
  const [lProfile, setLProfile] = useState("");
  const [lId, setLId] = useState("");
  const [lLabel, setLLabel] = useState("");
  const [lGuests, setLGuests] = useState("");
  const [bulk, setBulk] = useState("");
  const [importText, setImportText] = useState("");
  const [importResult, setImportResult] = useState<{ updated: number; unmatched: string[] } | null>(
    null,
  );

  useEffect(() => {
    if (!lProfile && profiles.length) setLProfile(profiles[0].id);
  }, [profiles, lProfile]);

  function patchListing(id: string, body: Record<string, unknown>) {
    call(`/api/visibility/listings/${id}`, "PATCH", body);
  }
  function removeListing(l: Listing) {
    if (confirm(`Remove "${l.label}"?`)) call(`/api/visibility/listings/${l.id}`, "DELETE");
  }

  async function runImport() {
    setBusy(true);
    setError(null);
    setImportResult(null);
    try {
      const res = await fetch("/api/visibility/listings/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: importText }),
      });
      const r = (await res.json()) as { updated?: number; unmatched?: string[]; error?: string };
      if (!res.ok) throw new Error(r.error || "import failed");
      setImportResult({ updated: r.updated ?? 0, unmatched: r.unmatched ?? [] });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>}

      {/* ---------------------------------------------------------- settings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Scanner settings</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Your residential proxy endpoint. With IP-whitelisting it&apos;s just the host:port — no
            username or password. Powers the “Run scan now” button.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            className={`${input} w-full`}
            placeholder="Proxy: http://gate.decodo.com:10001"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
            <label className="flex items-center gap-1.5">
              Skip if no availability within
              <input
                className={`${input} w-16`}
                value={availabilityDays}
                onChange={(e) => setAvailabilityDays(e.target.value)}
              />
              days
            </label>
            <label className="flex items-center gap-1.5">
              Primary stay (what you optimise for)
              <select
                className={input}
                value={primaryStay}
                onChange={(e) => setPrimaryStay(e.target.value)}
              >
                <option value="7">1 week</option>
                <option value="14">2 weeks</option>
                <option value="30">1 month</option>
                <option value="60">2 months</option>
                <option value="90">3 months</option>
              </select>
            </label>
            <button type="button" disabled={busy} onClick={saveSettings} className={btn}>
              {saved ? "Saved ✓" : "Save settings"}
            </button>
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------- profiles */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Search profiles</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            A profile is the shared search context — the area, currency, stay-lengths and default
            dates/guests. Each apartment below can override guests and dates.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {profiles.length > 0 && (
            <div className="space-y-2">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/70 bg-background/40 px-3 py-2"
                >
                  <span className="text-xs font-medium">{p.label}</span>
                  {!p.active && <Badge variant="muted">paused</Badge>}
                  <span className="text-[10px] text-muted-foreground">
                    default {p.guests} guests · {p.currency} · stays {p.stayNights.join("/")}n ·{" "}
                    {p.startDates.length} date{p.startDates.length === 1 ? "" : "s"}
                  </span>
                  <select
                    value={p.dateMode}
                    disabled={busy}
                    onChange={(e) =>
                      call(`/api/visibility/profiles/${p.id}`, "PATCH", { dateMode: e.target.value })
                    }
                    className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    title="How check-in dates are chosen for this profile"
                  >
                    <option value="fixed">dates: fixed</option>
                    <option value="first_available">dates: first-available</option>
                  </select>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Delete profile "${p.label}" and its listings + history?`))
                        call(`/api/visibility/profiles/${p.id}`, "DELETE");
                    }}
                    className="ml-auto text-muted-foreground hover:text-[hsl(var(--danger))]"
                    title="Delete profile"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-dashed border-border p-3">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              New profile
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <input className={input} placeholder="Name (e.g. Tel Aviv · 2 guests)" value={pLabel} onChange={(e) => setPLabel(e.target.value)} />
              <input className={input} placeholder="Default guests" value={pGuests} onChange={(e) => setPGuests(e.target.value)} />
              <input className={input} placeholder="Currency" value={pCurrency} onChange={(e) => setPCurrency(e.target.value)} />
              <input className={input} placeholder="Stay lengths, nights (7,14,30)" value={pStays} onChange={(e) => setPStays(e.target.value)} />
              <input className={input} placeholder="Default check-in dates (2026-08-01,2026-09-01)" value={pDates} onChange={(e) => setPDates(e.target.value)} />
              <input className={input} placeholder="Zoom (14)" value={pZoom} onChange={(e) => setPZoom(e.target.value)} />
              <input className={`${input} sm:col-span-2 lg:col-span-3`} placeholder="Search box: swLat,swLng,neLat,neLng" value={pBox} onChange={(e) => setPBox(e.target.value)} />
              <select className={input} value={pDateMode} onChange={(e) => setPDateMode(e.target.value)}>
                <option value="fixed">Date strategy: fixed dates</option>
                <option value="first_available">Date strategy: first available</option>
              </select>
            </div>
            <button type="button" disabled={busy} onClick={addProfile} className={`${btn} mt-2`}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Add profile
            </button>
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------- listings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Tracked listings</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Each apartment. Guests &amp; dates default to the profile — leave them blank to inherit,
            or set per-apartment. Rent / utilities / cleaning are your monthly costs — utilities and
            cleaning fall back to the Settings defaults, and the BG fee is applied automatically.
            Bulk box accepts Airbnb IDs, room URLs, or rows from your sheet.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {profiles.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">Create a profile first.</p>
          ) : (
            <>
              <div className="rounded-lg border border-dashed border-border p-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Add listings
                </div>
                <select className={input} value={lProfile} onChange={(e) => setLProfile(e.target.value)}>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <div className="flex flex-wrap gap-2">
                  <input className={`${input} flex-1`} placeholder="Airbnb ID or room URL" value={lId} onChange={(e) => setLId(e.target.value)} />
                  <input className={`${input} flex-1`} placeholder="Label (optional)" value={lLabel} onChange={(e) => setLLabel(e.target.value)} />
                  <input className={`${input} w-20`} placeholder="Guests" value={lGuests} onChange={(e) => setLGuests(e.target.value)} />
                  <button
                    type="button"
                    disabled={busy || !lId.trim()}
                    onClick={async () => {
                      await call("/api/visibility/listings", "POST", {
                        profileId: lProfile,
                        airbnbId: lId,
                        label: lLabel,
                        guests: lGuests.trim() ? parseInt(lGuests, 10) : null,
                      });
                      setLId("");
                      setLLabel("");
                      setLGuests("");
                    }}
                    className={btn}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </button>
                </div>
                <textarea
                  className={`${input} w-full font-mono`}
                  rows={4}
                  placeholder={"Bulk / CSV — one per line, e.g.:\nRothschild 14 Studio, https://www.airbnb.com/rooms/123456789\n1602229503214826484"}
                  value={bulk}
                  onChange={(e) => setBulk(e.target.value)}
                />
                <button
                  type="button"
                  disabled={busy || !bulk.trim()}
                  onClick={async () => {
                    await call("/api/visibility/listings", "POST", { profileId: lProfile, bulk });
                    setBulk("");
                  }}
                  className={btn}
                >
                  <Plus className="h-3.5 w-3.5" /> Add all (bulk / CSV)
                </button>
              </div>

              <div className="rounded-lg border border-dashed border-border p-3 space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Import rent &amp; address (bulk)
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Paste rows of <span className="font-mono">address &lt;tab&gt; rent</span> (a leading
                  row-number is fine). Each address is matched to a listing&apos;s name; you can also
                  use the Airbnb ID as the key. Unmatched rows are listed so you can fix them.
                </p>
                <textarea
                  className={`${input} w-full font-mono`}
                  rows={5}
                  placeholder={"Florentin 7, 23\t7500\nHerzel 114, 32\t9400"}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                />
                <button
                  type="button"
                  disabled={busy || !importText.trim()}
                  onClick={runImport}
                  className={btn}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Import rent &amp; address
                </button>
                {importResult && (
                  <div className="text-[11px]">
                    <p className="text-[hsl(var(--success))]">
                      Updated {importResult.updated} listing(s).
                    </p>
                    {importResult.unmatched.length > 0 && (
                      <div className="mt-1">
                        <p className="text-[hsl(var(--warning))]">
                          {importResult.unmatched.length} not matched (no listing with that
                          name/ID):
                        </p>
                        <ul className="mt-1 max-h-32 overflow-y-auto font-mono text-muted-foreground">
                          {importResult.unmatched.map((u, i) => (
                            <li key={i}>{u}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                {listings.length === 0 && (
                  <p className="text-[11px] text-muted-foreground">No listings yet.</p>
                )}
                {listings.map((l) => (
                  <ListingRow
                    key={l.id}
                    l={l}
                    profile={profiles.find((p) => p.id === l.profileId)}
                    busy={busy}
                    onPatch={patchListing}
                    onDelete={removeListing}
                  />
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
