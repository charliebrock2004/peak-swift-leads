import { useEffect, useState } from "react";
import type { Revenue } from "@/lib/sales/revenue";
import { getRevenue } from "@/lib/sales/server";
import { friendlyServerError } from "@/lib/server-errors";

/** Revenue analytics for Insights, loaded once per visit. */
export function useRevenue() {
  const [revenue, setRevenue] = useState<Revenue | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    getRevenue()
      .then((reply) => {
        if (!live) return;
        if (!reply.ok) return setError(reply.error);
        setRevenue(JSON.parse(reply.json) as Revenue);
      })
      .catch((failure: unknown) => live && setError(friendlyServerError(failure)));
    return () => {
      live = false;
    };
  }, []);
  return { revenue, error };
}
