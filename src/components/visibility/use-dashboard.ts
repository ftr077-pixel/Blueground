"use client";

import { useEffect, useState } from "react";
import type { Dashboard } from "@/lib/revenue";

// Shared loader for the Revenue & Yield views — one fetch of the dashboard payload
// (profiles + listings with latest snapshots + costs + primary stay).
export function useDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/visibility", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`load failed (${r.status})`);
        return r.json();
      })
      .then((b: Dashboard) => setData(b))
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, []);

  return { data, error, loading };
}
