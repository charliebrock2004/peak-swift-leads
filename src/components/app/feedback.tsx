/**
 * Your verdict on a business Find gave you. Each mark is a toggle; what it
 * does is spelled out, because every mark changes something by a fixed rule
 * (feedback/verdicts.ts) — nothing is learned behind your back.
 */
import { useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { businessAction } from "@/lib/businesses/server";
import { CORRECTING, POSITIVE, REJECTING, VERDICT_LABEL, type Verdict } from "@/lib/feedback/verdicts";
import { friendlyServerError } from "@/lib/server-errors";
import { cn } from "@/lib/utils";

const GROUPS: { title: string; verdicts: readonly Verdict[]; tone: "good" | "bad" | "neutral" }[] = [
  { title: "Worth working", verdicts: POSITIVE, tone: "good" },
  { title: "Not a prospect", verdicts: REJECTING, tone: "bad" },
  { title: "Something's wrong", verdicts: CORRECTING, tone: "neutral" },
];

const EFFECT: Partial<Record<Verdict, string>> = {
  good: "Ranked a little higher.",
  useful: "Ranked a little higher.",
  wrong_website: "The site comes off the record and is never attached to them again; an email on that site is not used.",
  good_website: "Nothing to offer them — they leave your queues.",
  wrong_contact: "Their email and phone are not used until you edit them.",
};

export function FeedbackControl({ leadId, verdicts, onChanged }: { leadId: string; verdicts: readonly Verdict[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<Verdict | "">("");
  const toggle = async (verdict: Verdict) => {
    const on = !verdicts.includes(verdict);
    setBusy(verdict);
    const reply = await businessAction({ data: { action: "feedback", id: leadId, verdict, on } }).catch((error: unknown) => ({ ok: false as const, error: friendlyServerError(error) }));
    setBusy("");
    if (!reply.ok) return void toast(reply.error);
    toast(
      on
        ? `Marked: ${VERDICT_LABEL[verdict].toLowerCase()}. ${REJECTING.includes(verdict) ? "Out of every queue, and Find won't add it again." : (EFFECT[verdict] ?? "")}`
        : `Removed: ${VERDICT_LABEL[verdict].toLowerCase()}.`,
    );
    onChanged();
  };
  const rejected = verdicts.some((verdict) => REJECTING.includes(verdict));
  const corrections = verdicts.filter((verdict) => CORRECTING.includes(verdict));
  return (
    <div className="flex flex-col gap-3">
      {GROUPS.map((group) => (
        <div key={group.title} className="flex flex-col gap-1.5">
          <p className="text-xs text-subtle">{group.title}</p>
          <div className="flex flex-wrap gap-1.5">
            {group.verdicts.map((verdict) => {
              const on = verdicts.includes(verdict);
              return (
                <button
                  key={verdict}
                  type="button"
                  aria-pressed={on}
                  disabled={busy !== ""}
                  onClick={() => void toggle(verdict)}
                  className={cn(
                    "inline-flex h-9 items-center gap-1 rounded-full px-3 text-sm transition-colors disabled:opacity-60",
                    on
                      ? group.tone === "good"
                        ? "bg-good text-bg"
                        : group.tone === "bad"
                          ? "bg-bad text-bg"
                          : "bg-accent text-accent-fg"
                      : "bg-surface-2 text-muted hover:text-fg",
                  )}
                >
                  {on ? <Check className="size-3.5" /> : null}
                  {VERDICT_LABEL[verdict]}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {rejected || corrections.length ? (
        <p className="text-xs text-muted">
          {rejected ? "Out of every queue and never emailed; Find won't add it again. " : ""}
          {corrections.map((verdict) => EFFECT[verdict]).filter(Boolean).join(" ")}
        </p>
      ) : (
        <p className="text-xs text-subtle">Your marks steer what Find brings back: sources and searches you mostly reject rank lower.</p>
      )}
    </div>
  );
}
