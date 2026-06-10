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
}

const pct = (o: number) => `${Math.round(o * 100)}%`;

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
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-semibold tabular-nums">{pct(data!.current.occupancy)}</span>
              <span className="text-xs text-muted-foreground">
                {data!.current.month} · {data!.current.bookedNights.toLocaleString()} booked nights
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
