"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface OccMonth {
  month: string;
  bookedNights: number;
  availableNights: number;
  occupancy: number;
  bookings: number;
}
interface OccupancyReport {
  thisMonth: string;
  rooms: number;
  totalBookings: number;
  current: OccMonth;
  byMonth: OccMonth[];
  window: { from: string; to: string } | null;
  syncedAt: string | null;
}

const pct = (o: number) => `${Math.round(o * 100)}%`;
const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
const fmtAgo = (iso: string) => {
  const d = daysAgo(iso);
  if (d <= 0) return "today";
  return d === 1 ? "1 day ago" : `${d} days ago`;
};

// Real occupancy from MiniHotel's ARI bookings (no revenue — that's the P&L's
// reservation feed). Booked nights ÷ rooms × days, refreshed by "Sync occupancy".
export function OccupancyPanel() {
  const [data, setData] = useState<OccupancyReport | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/occupancy", { cache: "no-store" })
      .then((r) => r.json())
      .then(setData)
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return null;
  const hasData = !!data && data.totalBookings > 0;
  const months = data ? data.byMonth.slice(-14) : [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle>Occupancy — actual, from MiniHotel</CardTitle>
          {hasData ? (
            <span className="text-[11px] text-muted-foreground">
              {data!.rooms} rooms · {data!.totalBookings.toLocaleString()} bookings
            </span>
          ) : null}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Real bookings from the ARI server — booked nights ÷ rooms × days. No revenue here (that comes
          from the reservation feed). Refresh with <b>Sync occupancy (ARI)</b> in MiniHotel settings.
        </p>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
            No occupancy data yet — run <b>Sync occupancy (ARI)</b> in MiniHotel settings (on the box).
          </div>
        ) : (
          <div className="space-y-4">
            {/* The ARI Room Status feed only sees today-forward bookings as of the
                last sync — an old or window-less snapshot makes these numbers
                meaningless, so say so instead of presenting them as truth. */}
            {!data!.window ? (
              <p className="rounded-md border border-[hsl(var(--warning))]/40 bg-warning/10 px-3 py-2 text-[11px] text-[hsl(var(--warning))]">
                ⚠️ This snapshot was stored by an older version and has no observed-window info:
                occupancy is divided by <b>full calendar months</b> even though the feed only covers
                part of them, so these percentages are <b>understated</b> and past/far-future months
                show phantom bars. Run <b>Sync occupancy (ARI)</b> in MiniHotel settings to fix.
              </p>
            ) : data!.syncedAt && daysAgo(data!.syncedAt) >= 2 ? (
              <p className="rounded-md border border-[hsl(var(--warning))]/40 bg-warning/10 px-3 py-2 text-[11px] text-[hsl(var(--warning))]">
                ⚠️ Snapshot is {fmtAgo(data!.syncedAt)} old — bookings made since are missing. Run{" "}
                <b>Sync occupancy (ARI)</b> in MiniHotel settings to refresh.
              </p>
            ) : null}
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-semibold tabular-nums">{pct(data!.current.occupancy)}</span>
              <span className="text-xs text-muted-foreground">
                {data!.current.month} · {data!.current.bookedNights.toLocaleString()} booked nights
                {data!.window && (
                  <>
                    {" "}
                    · observed {data!.window.from} → {data!.window.to}
                    {data!.syncedAt ? ` · synced ${fmtAgo(data!.syncedAt)}` : ""}
                  </>
                )}
              </span>
            </div>
            <div className="flex items-end gap-1">
              {months.map((m) => (
                <div
                  key={m.month}
                  className="flex flex-1 flex-col items-center gap-1"
                  title={`${m.month}: ${pct(m.occupancy)} · ${m.bookedNights.toLocaleString()} nights · ${m.bookings} bookings`}
                >
                  <div className="flex h-20 w-full items-end">
                    <div
                      className={`w-full rounded-t ${m.month === data!.thisMonth ? "bg-primary" : "bg-primary/50"}`}
                      style={{ height: `${Math.max(2, Math.min(100, m.occupancy * 100))}%` }}
                    />
                  </div>
                  <span className="text-[9px] text-muted-foreground">{m.month.slice(2)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
