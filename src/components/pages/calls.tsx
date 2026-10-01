import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeft, Ban, CalendarClock, ChevronRight, ClipboardCopy, Loader2, MapPin, Phone, PhoneCall, Play, ShieldCheck, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/app/app-shell";
import { Card, EmptyState, Notice, PageHeader, ScoreBadge, Segmented } from "@/components/app/ui";
import { CallStatusBadge } from "@/components/app/contactability";
import { callContactability, SCREENING_VALID_DAYS, type CallContactability } from "@/lib/contactability/phone";
import { getContactContext, recordPhoneScreening, setDoNotCall, type ContactContext } from "@/lib/contactability/server";
import { friendlyServerError } from "@/lib/server-errors";
import { WhyThisProspect } from "@/components/app/prospect-facts";
import { liveLeads, mapsHref, phoneHref } from "@/lib/leads";
import { callQueue, type CallItem } from "@/lib/outreach/call-queue";
import type { OutreachLead } from "@/lib/outreach/types";
import { useAppData } from "@/components/app/app-data";
import type { Lead } from "@/lib/leads";
import { plural } from "@/components/app/format";
import { CallBriefView, CallOutcomePicker } from "@/components/app/sales";
import type { CallBrief } from "@/lib/sales/call-brief";
import { getBusiness } from "@/lib/sales/server";
import { markCallStarted } from "@/lib/sales/call-timer";

/**
 * The call list, from the account's businesses. Every outcome is logged on the
 * server — the call record, the next task, the stage — and the list refreshes.
 *
 * A marketing call may only go to a number screened against both the TPS and
 * the CTPS within the last 28 days (or one that asked you to call). So the
 * list splits in two: ready to ring, and screen first. A number on your
 * do-not-call list, or registered with either service, is not shown at all.
 */
export function CallsPage() {
  // The server's copy is the one list; every outcome is logged there.
  const { state, reload } = useAppData();
  const leads = useMemo(() => (state?.leads ?? []) as unknown as Lead[], [state]);
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

  /** The server logged the call; mirror its call fields here so the list moves on at once. */
  const applied = (_leadId: string, _leadPatch: Record<string, string>) => void reload();

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
      if (objection) {
        const { runSalesAction } = await import("@/lib/sales/client");
        const logged = await runSalesAction({ action: "log_call", leadId: item.lead.id, outcome: "not_interested", note: "Asked not to be called again" });
        if (logged.ok) applied(item.lead.id, (JSON.parse(logged.json) as { leadPatch: Record<string, string> }).leadPatch);
        toast(`${item.lead.businessName}: they won't be called again.`);
      } else toast(`${item.lead.businessName}: added to your do-not-call list.`);
      await refresh();
    } catch (error) {
      toast(friendlyServerError(error));
    }
  };

  const rows = view === "today" ? ready : view === "screen" ? toScreen : later;
  const search = useSearch({ from: "/_app/calls" });
  const navigate = useNavigate();
  const [mode, setMode] = useState(false);

  // Call mode: one business per screen. Opened for the day's ready list, or for
  // one business from its page (?lead=).
  const single = useMemo(() => {
    if (!search.lead) return null;
    const lead = liveLeads(leads).find((item) => item.id === search.lead);
    if (!lead) return null;
    const item: CallItem = { lead, kind: lead.followUpDate ? "follow-up" : "prospect", reason: "", score: 0, due: lead.followUpDate };
    return { item, call: statusOf(item) };
  }, [search.lead, leads, statusOf]);
  if (single || mode) {
    return (
      <CallMode
        rows={single ? [single] : ready}
        onExit={() => {
          setMode(false);
          if (search.lead) void navigate({ to: "/calls", search: {} });
        }}
        onLogged={applied}
        onDoNotCall={doNotCall}
      />
    );
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Call list"
        title={ready.length ? `${plural(ready.length, "call")} to make today` : "Call list"}
        description="Good prospects with no usable email, and follow-ups whose day has come. Every number is screened against TPS and CTPS before it is offered."
      />
      {ready.length > 0 ? (
        <Button className="h-12 w-full text-[15px] sm:w-auto sm:self-start" onClick={() => setMode(true)}>
          <Play /> Start calling — one at a time
        </Button>
      ) : null}
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
            <CallCard key={item.lead.id} item={item} call={call} onLogged={applied} onDoNotCall={doNotCall} />
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
  onLogged,
  onDoNotCall,
}: {
  item: CallItem;
  call: CallContactability;
  onLogged: (leadId: string, leadPatch: Record<string, string>) => void;
  onDoNotCall: (item: CallItem, objection: boolean) => Promise<void>;
}) {
  const { lead } = item;
  const tel = phoneHref(lead.phone);
  const maps = mapsHref(lead);
  return (
    <Card as="article" className="p-4 md:p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link to="/businesses/$leadId" params={{ leadId: lead.id }} className="block truncate text-[17px] font-medium hover:underline">
            {lead.businessName || "Unnamed business"}
          </Link>
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
          <a href={tel} className="flex-1" onClick={() => markCallStarted(lead.id)}>
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

      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-muted hover:text-fg">Log what happened</summary>
        <div className="mt-2">
          <CallOutcomePicker leadId={lead.id} onLogged={({ leadPatch }) => onLogged(lead.id, leadPatch)} />
        </div>
      </details>
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

/**
 * Call mode: one business per screen, built for a phone in one hand. The call
 * button stays in reach; above it, why this business, the last thing that
 * happened and a short brief; below, what happened — then the next business.
 */
function CallMode({
  rows,
  onExit,
  onLogged,
  onDoNotCall,
}: {
  rows: { item: CallItem; call: CallContactability }[];
  onExit: () => void;
  onLogged: (leadId: string, leadPatch: Record<string, string>) => void;
  onDoNotCall: (item: CallItem, objection: boolean) => Promise<void>;
}) {
  // The list is fixed when call mode opens, so logging a call (which takes the
  // business off today's list) moves on instead of reshuffling under you.
  const [queue] = useState(rows);
  const [index, setIndex] = useState(0);
  const [brief, setBrief] = useState<{ leadId: string; brief: CallBrief; actionReason: string } | null>(null);
  const current = queue[index];

  useEffect(() => {
    if (!current) return;
    let live = true;
    setBrief(null);
    getBusiness({ data: { leadId: current.item.lead.id } })
      .then((reply) => {
        if (!live || !reply.ok) return;
        const view = JSON.parse(reply.json) as { brief: CallBrief; score: { actionReason: string } | null };
        setBrief({ leadId: current.item.lead.id, brief: view.brief, actionReason: view.score?.actionReason ?? "" });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [current]);

  if (!current) {
    return (
      <Page>
        <EmptyState icon={<Phone />} title="That's the list done" action={<Button onClick={onExit}>Back to the call list</Button>}>
          Every call you logged is on each business's timeline, and the next steps are on Today.
        </EmptyState>
      </Page>
    );
  }

  const { item, call } = current;
  const { lead } = item;
  const tel = phoneHref(lead.phone);
  const next = () => setIndex((value) => value + 1);

  return (
    <Page>
      <div className="flex items-center justify-between">
        <button type="button" onClick={onExit} className="flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ArrowLeft className="size-4" /> Call list
        </button>
        {queue.length > 1 ? (
          <span className="text-sm text-muted tabular">
            {index + 1} of {queue.length}
          </span>
        ) : null}
      </div>

      <header className="flex flex-col gap-1">
        <Link to="/businesses/$leadId" params={{ leadId: lead.id }} className="font-display text-[1.75rem] leading-tight font-medium tracking-tight hover:underline">
          {lead.businessName || "Unnamed business"}
        </Link>
        <p className="text-sm text-muted">{[lead.trade, lead.town].filter(Boolean).join(" · ")}</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
          <CallStatusBadge call={call} />
          {call.reasons[0]}
        </p>
        {item.reason ? (
          <p className="flex items-center gap-1.5 text-sm text-warn">
            <CalendarClock className="size-4" /> {item.reason}
          </p>
        ) : null}
      </header>

      <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 -mx-1 flex gap-2 rounded-xl bg-bg/90 p-1 backdrop-blur md:static md:bg-transparent md:p-0">
        {tel && call.status !== "BLOCKED" ? (
          <a href={tel} className="flex-1" onClick={() => markCallStarted(lead.id)}>
            <Button className="h-14 w-full text-base">
              <PhoneCall /> Call {lead.phone}
            </Button>
          </a>
        ) : (
          <p className="flex-1 rounded-lg bg-surface-2 px-3 py-3 text-sm text-warn">Not callable: {call.reasons[0]}</p>
        )}
        <Button variant="secondary" className="h-14" onClick={next} aria-label="Skip to the next business">
          <SkipForward />
        </Button>
      </div>

      <Card className="px-4 py-3">
        {brief && brief.leadId === lead.id ? (
          <>
            {brief.actionReason ? <p className="mb-3 text-sm"><span className="text-[11px] font-medium tracking-wider text-subtle uppercase">Next action </span>{brief.actionReason}</p> : null}
            <CallBriefView brief={brief.brief} compact />
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <WhyThisProspect lead={lead as OutreachLead} />
            <p className="text-xs text-subtle">Loading the brief…</p>
          </div>
        )}
      </Card>

      <section className="flex flex-col gap-2">
        <p className="text-sm font-medium">What happened?</p>
        <CallOutcomePicker
          leadId={lead.id}
          onLogged={({ leadPatch }) => {
            onLogged(lead.id, leadPatch);
            next();
          }}
        />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <button type="button" className="inline-flex items-center gap-1 text-bad hover:underline" onClick={() => void onDoNotCall(item, true).then(next)}>
          <Ban className="size-3.5" /> They asked not to be called
        </button>
        <Link to="/businesses/$leadId" params={{ leadId: lead.id }} className="inline-flex items-center gap-0.5 text-muted hover:text-fg">
          Everything about them <ChevronRight className="size-3.5" />
        </Link>
      </div>
    </Page>
  );
}
