import { useEffect, useMemo, useState } from "react";
import { getEvidence } from "@/lib/outreach/server";
import { parseEvidenceRows, type LeadEvidence } from "@/lib/outreach/evidence-record";

/**
 * What discovery recorded about these leads' websites and emails, loaded once
 * per set of leads. Missing evidence is simply absent — older leads were found
 * before it was recorded.
 */
export function useEvidence(leadIds: readonly string[]): Map<string, LeadEvidence> {
  const key = useMemo(() => [...new Set(leadIds)].sort().join(","), [leadIds]);
  const [evidence, setEvidence] = useState<Map<string, LeadEvidence>>(new Map());
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void getEvidence({ data: { leadIds: key.split(",").slice(0, 500) } })
      .then((result) => {
        if (!cancelled && result.ok) setEvidence(parseEvidenceRows(result.evidence));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key]);
  return evidence;
}
