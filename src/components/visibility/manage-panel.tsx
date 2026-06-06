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
  active: boolean;
}

interface Listing {
  id: string;
  airbnbId: string;
  label: string;
  profileId: string;
  active: boolean;
}

const input =
  "rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/50";
const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50";

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

  // ---- new profile form ----
  const [pLabel, setPLabel] = useState("");
  const [pGuests, setPGuests] = useState("2");
  const [pCurrency, setPCurrency] = useState("ILS");
  const [pStays, setPStays] = useState("7,14,30");
  const [pDates, setPDates] = useState("");
  const [pBox, setPBox] = useState("32.04,34.74,32.12,34.83");
  const [pZoom, setPZoom] = useState("14");

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
    });
    setPLabel("");
    setPDates("");
  }

  // ---- new listing form ----
  const [lProfile, setLProfile] = useState("");
  const [lId, setLId] = useState("");
  const [lLabel, setLLabel] = useState("");
  const [bulk, setBulk] = useState("");

  useEffect(() => {
    if (!lProfile && profiles.length) setLProfile(profiles[0].id);
  }, [profiles, lProfile]);

  return (
    <div className="space-y-6">
      {error && <p className="text-[11px] text-[hsl(var(--danger))]">{error}</p>}

      {/* ---------------------------------------------------------- profiles */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Search profiles</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            A profile is one search — an area + guest count + the date windows to check. Many
            listings share a profile, so the scanner runs a few searches instead of one per listing.
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
                    {p.guests} guests · {p.currency} · stays {p.stayNights.join("/")}n ·{" "}
                    {p.startDates.length} date{p.startDates.length === 1 ? "" : "s"}
                  </span>
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
              <input className={input} placeholder="Guests" value={pGuests} onChange={(e) => setPGuests(e.target.value)} />
              <input className={input} placeholder="Currency" value={pCurrency} onChange={(e) => setPCurrency(e.target.value)} />
              <input className={input} placeholder="Stay lengths, nights (7,14,30)" value={pStays} onChange={(e) => setPStays(e.target.value)} />
              <input className={input} placeholder="Check-in dates (2026-08-01,2026-09-01)" value={pDates} onChange={(e) => setPDates(e.target.value)} />
              <input className={input} placeholder="Zoom (14)" value={pZoom} onChange={(e) => setPZoom(e.target.value)} />
              <input className={`${input} sm:col-span-2 lg:col-span-3`} placeholder="Search box: swLat,swLng,neLat,neLng" value={pBox} onChange={(e) => setPBox(e.target.value)} />
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
            Add the listings to track. Paste Airbnb IDs or room URLs — one per line for bulk.
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
                  <button
                    type="button"
                    disabled={busy || !lId.trim()}
                    onClick={async () => {
                      await call("/api/visibility/listings", "POST", { profileId: lProfile, airbnbId: lId, label: lLabel });
                      setLId("");
                      setLLabel("");
                    }}
                    className={btn}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </button>
                </div>
                <textarea
                  className={`${input} w-full font-mono`}
                  rows={3}
                  placeholder="Bulk: paste many Airbnb IDs or room URLs, one per line"
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
                  <Plus className="h-3.5 w-3.5" /> Add all (bulk)
                </button>
              </div>

              <div className="space-y-2">
                {listings.length === 0 && (
                  <p className="text-[11px] text-muted-foreground">No listings yet.</p>
                )}
                {listings.map((l) => {
                  const prof = profiles.find((p) => p.id === l.profileId);
                  return (
                    <div
                      key={l.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/70 bg-background/40 px-3 py-2"
                    >
                      <span className="text-xs font-medium">{l.label}</span>
                      <span className="text-[10px] font-mono text-muted-foreground">{l.airbnbId}</span>
                      <Badge variant="info">{prof?.label ?? "—"}</Badge>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Remove "${l.label}"?`))
                            call(`/api/visibility/listings/${l.id}`, "DELETE");
                        }}
                        className="ml-auto text-muted-foreground hover:text-[hsl(var(--danger))]"
                        title="Remove listing"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
