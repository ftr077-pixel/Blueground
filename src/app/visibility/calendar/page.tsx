import { CalendarRange } from "lucide-react";
import { RateCalendar } from "@/components/visibility/rate-calendar";

export const dynamic = "force-dynamic";

export default function RatesCalendarPage() {
  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-xl border border-border bg-card grid place-items-center">
          <CalendarRange className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Rates Calendar</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Every listing, every night — nightly rate, availability and minimum-stay in one
            multi-calendar. This is the control surface that replaces PriceLabs: set rates and
            restrictions here, and the Pricing Specialist pushes them to MiniHotel.
          </p>
        </div>
      </header>
      <RateCalendar />
    </div>
  );
}
