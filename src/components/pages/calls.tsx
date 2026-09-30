import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Ban, CalendarClock, ClipboardCopy, Loader2, MapPin, Phone, PhoneCall, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Page } from "@/components/app/app-shell";
import { Card, EmptyState, Notice, PageHeader, ScoreBadge, Segmented } from "@/components/app/ui";
import { CallStatusBadge } from "@/components/app/contactability";
import { callContactability, SCREENING_VALID_DAYS, type CallContactability } from "@/lib/contactability/phone";
import { getContactContext, recordPhoneScreening, setDoNotCall, type ContactContext } from "@/lib/contactability/server";
import { friendlyServerError } from "@/lib/server-errors";
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
 *
 * A marketing call may only go to a number screened against both the TPS and
 * the CTPS within the last 28 days (or one that asked you to call). So the
 * list splits in two: ready to ring, and screen first. A number on your
 * do-not-call list, or registered with either service, is not shown at all.
 */
export function CallsPage() {
  const leads = useLeadsStore((store) => store.leads);
  const updateLead = useLeadsStore((store) => store.updateLead);
  const queue = useMemo(() => callQueue(liveLeads(leads)), [leads]);
  const [view, setView] = useState<"today" | "screen" | "later">("today");
  const [contact, setContact] = useState<ContactContext | null>(null);
  const [contactError, setContactError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await getContactContext();
      if (result.success) {
        setContact(result);
        setContactError("");
      } else setContactError(result.error);
    } catch (error) {
      setContactError(friendlyServerError(error));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const statusOf = useCallback(
    (item: CallItem): CallContactability => {
      const base = callContactability({
        phone: item.lead.phone,
        callResult: item.lead.callResult,
        called: item.lead.called,
        unsubscribed: item.lead.unsubscribed,
        outreachStatus: item.lead.outreachStatus,
      });
      const number = base.phone?.e164 ?? "";
      return callContactability({
        phone: item.lead.phone,
        screening: number ? contact?.screenings[number] : null,
        doNotCall: number ? contact?.doNotCall[number] : null,
        callResult: item.lead.callResult,
        called: item.lead.called,
        unsubscribed: item.lead.unsubscribed,
        outreachStatus: item.lead.outreachStatus,
      });
    },
    [contact],
  );

  const today = useMemo(() => queue.today.map((item) => ({ item, call: statusOf(item) })), [queue.today, statusOf]);
  const ready = today.filter((row) => row.call.status === "ELIGIBLE");
  const toScreen = today.filter((row) => row.call.status === "UNKNOWN");
  const blocked = today.filter((row) => row.call.status === "BLOCKED").length;
  const later = useMemo(() => queue.later.map((item) => ({ item, call: statusOf(item) })).filter((row) => row.call.status !== "BLOCKED"), [queue.later, statusOf]);

  const record = (item: CallItem, result: CallResult, note: string) => {
    const patch = callOutcomePatch(result, item.lead);
    const stamp = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const notes = note.trim() ? [item.lead.notes.trim(), `${stamp} call: ${note.trim()}`].filter(Boolean).join("\n") : item.lead.notes;
    updateLead(item.lead.id, { ...patch, notes });
    toast(describeOutcome(result, patch.followUpDate ?? ""));
  };

  const doNotCall = async (item: CallItem, objection: boolean) => {
    try {
      const result = await setDoNotCall({
        data: {
          phone: item.lead.phone,
          reason: objection ? "Asked not to be called" : "",
          source: objection ? "objection" : "internal",
          leadId: item.lead.id,
        },
      });
      if (!result.success) return void toast(result.error);
      if (objection) record(item, "Not Interested", "Asked not to be called again");
      else toast(`${item.lead.businessName}: added to your do-not-call list.`);
      await refresh();
    } catch (error) {
      toast(friendlyServerError(error));
    }
  };

  const rows = view === "today" ? ready : view === "screen" ? toScreen : later;

  return (
    <Page>
      <PageHeader
        eyebrow="Call list"
        title={ready.length ? `${plural(ready.length, "call")} to make today` : "Call list"}
        description="Good prospects with no usable email, and follow-ups whose day has come. Every number is screened against TPS and CTPS before it is offered."
      />
      {contactError ? (
        <Notice tone="warn" title="Screening records could not be loaded">
          Until they load, every number is treated as unscreened. {contactError}
        </Notice>
      ) : null}
      <Segmented
        label="Calls"
        value={view}
        onChange={setView}
        options={[
          { id: "today", label: "Ready to call", count: ready.length },
          { id: "screen", label: "Screen first", count: toScreen.length },
          { id: "later", label: "Upcoming", count: later.length },
        ]}
      />
      {blocked > 0 && view !== "later" ? (
        <p className="text-xs text-muted">
          {plural(blocked, "number")} not shown: on the TPS/CTPS, on your do-not-call list, or they asked not to be contacted.
        </p>
      ) : null}
      {view === "screen" ? (
        <ScreeningList rows={toScreen} onDone={refresh} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Phone />} title={view === "today" ? "No screened calls due today" : "Nothing scheduled"}>
          {view === "today"
            ? toScreen.length
              ? `${plural(toScreen.length, "number")} need screening against TPS and CTPS first — see Screen first.`
              : "Prospects with a phone number but no usable email land here after a Find run, alongside any callbacks you set."
            : "Callbacks and follow-ups you schedule appear here until their day comes."}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map(({ item, call }) => (
            <CallCard key={item.lead.id} item={item} call={call} onRecord={record} onDoNotCall={doNotCall} />
          ))}
        </div>
      )}
    </Page>
  );
}

/**
 * Numbers waiting on a TPS/CTPS check. There is no public screening API, so
 * the results come from your screening service: copy the numbers, check them,
 * record each result. Screening is valid for 28 days.
 */
function ScreeningList({ rows, onDone }: { rows: { item: CallItem; call: CallContactability }[]; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const numbers = rows.map((row) => row.call.phone?.national ?? row.item.lead.phone);

  const save = async (entries: { phone: string; leadId: string; tps: "clear" | "registered"; ctps: "clear" | "registered" }[], label: string) => {
    setBusy(label);
    try {
      const result = await recordPhoneScreening({ data: { entries, method: "Screened by you (TPS/CTPS service)" } });
      if (!result.success) return void toast(result.error);
      toast(`${plural(result.saved.length, "number")} recorded${result.rejected.length ? ` · ${result.rejected.length} not valid UK numbers` : ""}.`);
      setConfirmed(false);
      await onDone();
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setBusy("");
    }
  };

  if (rows.length === 0) {
    return (
      <EmptyState icon={<ShieldCheck />} title="Nothing to screen">
        Every number due today has a current TPS and CTPS screening.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card as="div" className="flex flex-col gap-3 p-4">
        <p className="text-sm text-muted">
          Check these against the TPS and CTPS with your screening service, then record the result. A screening counts for {SCREENING_VALID_DAYS}{" "}
          days. Sole traders can be on the TPS and companies on the CTPS, so both are needed.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(numbers.join("\n")).then(
                () => toast(`${plural(numbers.length, "number")} copied.`),
                () => toast("Could not copy — select the numbers below instead."),
              );
            }}
          >
            <ClipboardCopy /> Copy {plural(numbers.length, "number")}
          </Button>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--color-accent)]" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>I screened all {plural(rows.length, "number")} against both the TPS and the CTPS today, and none is registered.</span>
        </label>
        <Button
          disabled={!confirmed || Boolean(busy)}
          onClick={() => void save(rows.map(({ item }) => ({ phone: item.lead.phone, leadId: item.lead.id, tps: "clear", ctps: "clear" })), "all")}
        >
          {busy === "all" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          Mark all clear
        </Button>
      </Card>
      <Card as="div" className="divide-y divide-border">
        {rows.map(({ item, call }) => (
          <div key={item.lead.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate font-medium">{item.lead.businessName || "Unnamed business"}</p>
              <p className="text-sm text-muted tabular select-all">{call.phone?.national ?? item.lead.phone}</p>
              <p className="text-xs text-subtle">{call.reasons[0]}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={Boolean(busy)}
                onClick={() => void save([{ phone: item.lead.phone, leadId: item.lead.id, tps: "clear", ctps: "clear" }], item.lead.id)}
              >
                Clear on both
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={Boolean(busy)}
                onClick={() => void save([{ phone: item.lead.phone, leadId: item.lead.id, tps: "registered", ctps: "clear" }], `${item.lead.id}-tps`)}
              >
                On TPS
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={Boolean(busy)}
                onClick={() => void save([{ phone: item.lead.phone, leadId: item.lead.id, tps: "clear", ctps: "registered" }], `${item.lead.id}-ctps`)}
              >
                On CTPS
              </Button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function CallCard({
  item,
  call,
  onRecord,
  onDoNotCall,
}: {
  item: CallItem;
  call: CallContactability;
  onRecord: (item: CallItem, result: CallResult, note: string) => void;
  onDoNotCall: (item: CallItem, objection: boolean) => Promise<void>;
}) {
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
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            <CallStatusBadge call={call} />
            {call.reasons[0]}
          </p>
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
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <button type="button" className="inline-flex items-center gap-1 text-bad hover:underline" onClick={() => void onDoNotCall(item, true)}>
          <Ban className="size-3.5" /> They asked not to be called
        </button>
        <button type="button" className="text-muted hover:text-fg hover:underline" onClick={() => void onDoNotCall(item, false)}>
          Don&apos;t call again
        </button>
      </div>
    </Card>
  );
}
