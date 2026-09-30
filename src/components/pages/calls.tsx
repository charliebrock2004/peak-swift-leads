import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, MapPin, Phone, PhoneCall } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Page } from "@/components/app/app-shell";
import { Card, EmptyState, PageHeader, ScoreBadge, Segmented } from "@/components/app/ui";
import { WhyThisProspect } from "@/components/app/prospect-facts";
import { callOutcomePatch, liveLeads, mapsHref, phoneHref, type CallResult } from "@/lib/leads";
import { callQueue, type CallItem } from "@/lib/outreach/call-queue";
import type { OutreachLead } from "@/lib/outreach/types";
import { useLeadsStore } from "@/store/leads-store";
import { plural } from "@/components/app/format";

const OUTCOMES: { result: CallResult; label: string; tone?: "good" | "bad" }[] = [
  { result: "No Answer", label: "No answer" },
  { result: "Callback", label: "Callback" },
  { result: "Interested", label: "Interested", tone: "good" },
  { result: "Not Interested", label: "Not interested", tone: "bad" },
  { result: "Booked", label: "Booked", tone: "good" },
];

function describeOutcome(result: CallResult, followUp: string): string {
  if (result === "Not Interested") return "Recorded: not interested. They won't be emailed or listed again.";
  if (result === "Booked") return "Recorded: booked.";
  const when = followUp ? new Date(`${followUp}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" }) : "";
  return `Recorded: ${result.toLowerCase()}${when ? ` — back on your list ${when}` : ""}.`;
}

/**
 * The call list. Local-first like the lead sheet it reads: outcomes land on the
 * phone immediately and sync to the account when there is signal.
 */
export function CallsPage() {
  const leads = useLeadsStore((store) => store.leads);
  const updateLead = useLeadsStore((store) => store.updateLead);
  const queue = useMemo(() => callQueue(liveLeads(leads)), [leads]);
  const [view, setView] = useState<"today" | "later">("today");
  const items = view === "today" ? queue.today : queue.later;

  const record = (item: CallItem, result: CallResult, note: string) => {
    const patch = callOutcomePatch(result, item.lead);
    const stamp = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const notes = note.trim() ? [item.lead.notes.trim(), `${stamp} call: ${note.trim()}`].filter(Boolean).join("\n") : item.lead.notes;
    updateLead(item.lead.id, { ...patch, notes });
    toast(describeOutcome(result, patch.followUpDate ?? ""));
  };

  return (
    <Page>
      <PageHeader
        eyebrow="Call list"
        title={queue.today.length ? `${plural(queue.today.length, "call")} to make today` : "Call list"}
        description="Good prospects with no public email, and follow-ups whose day has come. Tap to ring, then one tap records how it went."
      />
      <Segmented
        label="Calls"
        value={view}
        onChange={setView}
        options={[
          { id: "today", label: "Today", count: queue.today.length },
          { id: "later", label: "Upcoming", count: queue.later.length },
        ]}
      />
      {items.length === 0 ? (
        <EmptyState icon={<Phone />} title={view === "today" ? "No calls due today" : "Nothing scheduled"}>
          {view === "today"
            ? "Prospects with a phone number but no public email land here after a Find run, alongside any callbacks you set."
            : "Callbacks and follow-ups you schedule appear here until their day comes."}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <CallCard key={item.lead.id} item={item} onRecord={record} />
          ))}
        </div>
      )}
    </Page>
  );
}

function CallCard({ item, onRecord }: { item: CallItem; onRecord: (item: CallItem, result: CallResult, note: string) => void }) {
  const [note, setNote] = useState("");
  const { lead } = item;
  const tel = phoneHref(lead.phone);
  const maps = mapsHref(lead);
  return (
    <Card as="article" className="p-4 md:p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[17px] font-medium">{lead.businessName || "Unnamed business"}</h3>
          <p className="mt-0.5 text-sm text-muted">{[lead.trade, lead.town].filter(Boolean).join(" · ")}</p>
          <p className="mt-1.5 flex items-center gap-1.5 text-sm">
            {item.kind === "follow-up" ? <CalendarClock className="size-4 text-warn" /> : null}
            <span className={item.kind === "follow-up" ? "text-warn" : "text-fg"}>{item.reason}</span>
          </p>
        </div>
        <ScoreBadge score={item.score} />
      </div>

      <div className="mt-3">
        <WhyThisProspect lead={lead as OutreachLead} />
      </div>
      {lead.notes.trim() ? <p className="mt-3 line-clamp-3 text-sm whitespace-pre-line text-muted">{lead.notes}</p> : null}

      <div className="mt-4 flex gap-2">
        {tel ? (
          <a href={tel} className="flex-1">
            <Button className="h-12 w-full text-[15px]">
              <PhoneCall />
              Call {lead.phone}
            </Button>
          </a>
        ) : null}
        {maps ? (
          <a href={maps} target="_blank" rel="noreferrer noopener">
            <Button variant="secondary" className="h-12" aria-label="Open in Maps">
              <MapPin />
            </Button>
          </a>
        ) : null}
      </div>

      <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note from the call (optional)" className="mt-3 h-11" />
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {OUTCOMES.map((outcome) => (
          <Button
            key={outcome.result}
            variant="secondary"
            className={`h-11 ${outcome.tone === "good" ? "text-good" : outcome.tone === "bad" ? "text-bad" : ""}`}
            onClick={() => {
              onRecord(item, outcome.result, note);
              setNote("");
            }}
          >
            {outcome.label}
          </Button>
        ))}
      </div>
    </Card>
  );
}
