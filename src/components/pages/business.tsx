import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, Globe, Mail, MapPin, Pencil, Phone, PhoneCall, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/app/app-shell";
import { Badge, Card, Notice, SectionTitle, Skeleton } from "@/components/app/ui";
import { CallStatusBadge, LegalFormPanel } from "@/components/app/contactability";
import { WhyThisProspect } from "@/components/app/prospect-facts";
import { CallBriefView, CallOutcomePicker, StageEditor, TaskList, Timeline } from "@/components/app/sales";
import { FeedbackControl } from "@/components/app/feedback";
import { runSalesAction } from "@/lib/sales/client";
import { BusinessForm } from "@/components/app/business-form";
import { businessAction } from "@/lib/businesses/server";
import { relativeTime } from "@/components/app/format";
import { OPPORTUNITY_LABEL, dateLabel } from "@/lib/audit/findings";
import { websitePhrase, websiteVerificationOf } from "@/lib/audit/website-state";
import { legalFormOf } from "@/lib/contactability/lead";
import type { ContactRules } from "@/lib/contactability/legal-form";
import { callContactability, type DoNotCall, type PhoneScreening } from "@/lib/contactability/phone";
import { mapsHref, phoneHref, websiteHref } from "@/lib/leads";
import type { OutreachEmail, OutreachLead } from "@/lib/outreach/types";
import { ACTION_LABEL, BAND_LABEL, type ProspectScore } from "@/lib/scoring/prospect-score";
import type { CallBrief } from "@/lib/sales/call-brief";
import { formatPence } from "@/lib/sales/pipeline";
import { getBusiness } from "@/lib/sales/server";
import type { TimelineEvent } from "@/lib/sales/timeline";
import { STAGE_LABEL, type Opportunity, type Stage, type Task } from "@/lib/sales/types";
import { markCallStarted } from "@/lib/sales/call-timer";
import { friendlyServerError } from "@/lib/server-errors";
import { cn } from "@/lib/utils";

type BusinessView = {
  lead: OutreachLead;
  score: ProspectScore | null;
  stage: Stage;
  stageReason: string;
  opportunity: Opportunity | null;
  emails: OutreachEmail[];
  tasks: Task[];
  timeline: TimelineEvent[];
  brief: CallBrief;
  screening: PhoneScreening | null;
  doNotCall: DoNotCall | null;
  rules: ContactRules;
  suppressed: boolean;
};

const EMAIL_STATUS: Record<string, string> = { draft: "Draft", approved: "Approved", queued: "Queued", sending: "Sending", sent: "Sent", replied: "Replied", failed: "Failed", bounced: "Bounced", skipped: "Skipped", cancelled: "Cancelled" };

/**
 * One business, everything about it: where the sale stands, what to do next,
 * why it is worth it, how it can be contacted, its website, its emails, every
 * interaction, and a call brief. The page all the intelligence comes back to.
 */
export function BusinessPage() {
  const { leadId } = useParams({ from: "/_app/businesses/$leadId/" });
  const [view, setView] = useState<BusinessView | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const logCall = useRef<HTMLDetailsElement>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const reply = await getBusiness({ data: { leadId } });
      if (!reply.ok) return setError(reply.error);
      setView(JSON.parse(reply.json) as BusinessView);
      setError("");
    } catch (failure) {
      setError(friendlyServerError(failure));
    }
  }, [leadId]);
  useEffect(() => {
    void load();
  }, [load]);

  const call = useMemo(
    () =>
      view
        ? callContactability({ phone: view.lead.phone, screening: view.screening, doNotCall: view.doNotCall, callResult: view.lead.callResult, called: view.lead.called, unsubscribed: view.lead.unsubscribed, outreachStatus: view.lead.outreachStatus })
        : null,
    [view],
  );

  if (error) return <Page><Notice tone="bad" title="Could not load this business">{error}</Notice></Page>;
  if (!view || !call) return <Page><Skeleton className="h-10 w-2/3" /><Skeleton className="h-64" /></Page>;

  const { lead, score } = view;
  const tel = phoneHref(lead.phone);
  const site = websiteHref(lead.website);
  const maps = mapsHref(lead);
  const website = websiteVerificationOf(lead);
  const audit = lead.facts?.audit;
  const legal = legalFormOf(lead, view.rules);
  // Once a sale is under way, the next step is the sale's, not the prospect score's.
  const nextTask = view.tasks.find((task) => task.status === "open");
  const nextLine = nextTask
    ? nextTask.title
    : view.stage === "WON"
      ? "Won — nothing to chase"
      : view.stage === "LOST"
        ? `Lost${view.opportunity?.lostReason ? ` — ${view.opportunity.lostReason}` : ""}`
        : view.stage === "CONVERSATION" || view.stage === "MEETING" || view.stage === "QUOTE_SENT"
          ? "Agree the next step and add it as a task"
          : score
            ? `${ACTION_LABEL[score.action]} — ${score.actionReason}`
            : "";

  const remove = async () => {
    if (!window.confirm(`Remove ${lead.businessName} from your businesses? Its history is kept, and an opted-out address stays suppressed.`)) return;
    const reply = await businessAction({ data: { action: "remove", id: lead.id } }).catch((error: unknown) => ({ ok: false as const, error: friendlyServerError(error) }));
    if (!reply.ok) return void toast(reply.error);
    toast(`${lead.businessName} removed.`);
    void navigate({ to: "/prospects" });
  };

  const addNote = async () => {
    const reply = await runSalesAction({ action: "add_note", leadId: lead.id, note });
    if (!reply.ok) return void toast(reply.error);
    setNote("");
    void load();
  };

  return (
    <Page>
      <Link to="/prospects" className="-mb-2 flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Businesses
      </Link>

      <header className="flex flex-col gap-2">
        <h1 className="font-display text-[1.75rem] leading-tight font-medium tracking-tight">{lead.businessName}</h1>
        <p className="text-sm text-muted">{[lead.trade, lead.town].filter(Boolean).join(" · ")}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={view.stage === "WON" ? "good" : view.stage === "LOST" ? "bad" : view.stage === "PROSPECT" ? "neutral" : "info"}>{STAGE_LABEL[view.stage]}</Badge>
          {view.opportunity?.valuePence != null ? <Badge tone="neutral">{formatPence(view.opportunity.valuePence)}</Badge> : null}
          {score ? <Badge tone={score.band === "STRONG" ? "good" : score.band === "NONE" ? "bad" : "neutral"}>{BAND_LABEL[score.band]}</Badge> : null}
          <span className="text-xs text-muted">Next: {nextLine}</span>
        </div>
      </header>

      {/* The one thing to do, always in reach of a thumb. */}
      <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 -mx-1 flex gap-2 rounded-xl bg-bg/90 p-1 backdrop-blur md:static md:bg-transparent md:p-0">
        {tel && call.status !== "BLOCKED" ? (
          <a
            href={tel}
            className="flex-1"
            onClick={() => {
              markCallStarted(lead.id);
              // Ready for when the call ends.
              logCall.current?.setAttribute("open", "");
            }}
          >
            <Button className="h-12 w-full text-[15px]">
              <Phone /> Call {lead.phone}
            </Button>
          </a>
        ) : null}
        {lead.phone ? (
          <Link to="/calls" search={{ lead: lead.id } as never} className="flex-1">
            <Button variant="secondary" className="h-12 w-full">
              <PhoneCall /> Call mode
            </Button>
          </Link>
        ) : null}
        {view.emails.some((email) => ["draft", "approved", "queued"].includes(email.status)) ? (
          <Link to="/send" className="flex-1">
            <Button variant="secondary" className="h-12 w-full">
              <Send /> Review email
            </Button>
          </Link>
        ) : null}
      </div>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <section className="flex flex-col gap-2">
            <SectionTitle>Next steps</SectionTitle>
            <Card className="px-4 py-3">
              <TaskList leadId={lead.id} tasks={view.tasks} onChanged={() => void load()} />
            </Card>
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle>The sale</SectionTitle>
            <Card className="px-4 py-3">
              <StageEditor leadId={lead.id} stage={view.stage} opportunity={view.opportunity} onChanged={() => void load()} />
              {view.stageReason && !view.opportunity ? <p className="mt-2 text-xs text-subtle">{STAGE_LABEL[view.stage]} because: {view.stageReason.toLowerCase()}.</p> : null}
            </Card>
          </section>

          {lead.phone ? (
            <section className="flex flex-col gap-2">
              <SectionTitle>Call brief</SectionTitle>
              <Card className="px-4 py-3">
                <CallBriefView brief={view.brief} />
              </Card>
              <details ref={logCall} className="rounded-xl bg-surface px-4 py-3 shadow-(--shadow-border)">
                <summary className="cursor-pointer text-sm font-medium">Log a call</summary>
                <div className="mt-3">
                  <CallOutcomePicker
                    leadId={lead.id}
                    onLogged={() => void load()}
                  />
                </div>
              </details>
            </section>
          ) : null}

          <section className="flex flex-col gap-2">
            <SectionTitle>Why this prospect</SectionTitle>
            <Card className="px-4 py-3">{score ? <WhyThisProspect lead={lead} score={score} limit={8} /> : <p className="text-sm text-muted">Not scored.</p>}</Card>
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle>Your verdict</SectionTitle>
            <Card className="px-4 py-3">
              <FeedbackControl leadId={lead.id} verdicts={lead.facts?.feedback ?? []} onChanged={() => void load()} />
            </Card>
          </section>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <section className="flex flex-col gap-2">
            <SectionTitle
              action={
                <span className="flex gap-3">
                  <button type="button" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg" onClick={() => setEditing((open) => !open)}>
                    <Pencil className="size-3" /> Edit
                  </button>
                  <button type="button" className="inline-flex items-center gap-1 text-xs text-muted hover:text-bad" onClick={() => void remove()}>
                    <Trash2 className="size-3" /> Remove
                  </button>
                </span>
              }
            >
              Contact
            </SectionTitle>
            {editing ? (
              <Card className="px-4 py-4">
                <BusinessForm
                  id={lead.id}
                  initial={{ businessName: lead.businessName, trade: lead.trade, town: lead.town, phone: lead.phone, email: lead.email, website: lead.website, address: lead.address }}
                  onSaved={() => {
                    setEditing(false);
                    void load();
                  }}
                  onCancel={() => setEditing(false)}
                />
              </Card>
            ) : null}
            <Card className="flex flex-col gap-3 px-4 py-3 text-sm">
              <div className="flex items-start gap-2">
                <Phone className="mt-0.5 size-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p>{lead.phone || "No phone number"}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <CallStatusBadge call={call} />
                    <span className="text-xs text-muted">{call.reasons[0]}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Mail className="mt-0.5 size-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="break-all">{lead.email || "No public email found"}</p>
                  {lead.email ? (
                    <p className="text-xs text-muted">
                      {lead.emailConfidence ? `${lead.emailConfidence.toLowerCase()} confidence` : ""}
                      {lead.emailSource ? ` · from ${lead.emailSource}` : ""}
                      {view.suppressed ? " · opted out — never emailed" : ""}
                    </p>
                  ) : null}
                </div>
              </div>
              {lead.address || maps ? (
                <div className="flex items-start gap-2">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-muted" />
                  <p className="min-w-0 flex-1">
                    {lead.address || lead.town}
                    {maps ? (
                      <a href={maps} target="_blank" rel="noreferrer" className="ml-1 text-xs text-muted underline">
                        map
                      </a>
                    ) : null}
                  </p>
                </div>
              ) : null}
              <div className="border-t border-border pt-3">
                <LegalFormPanel leadId={lead.id} businessName={lead.businessName} legal={legal} onChanged={load} compact />
              </div>
            </Card>
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle
              action={
                lead.website ? (
                  <Link to="/businesses/$leadId/audit" params={{ leadId: lead.id }} className="text-xs text-muted hover:text-fg">
                    {audit ? "Full audit" : "Run an audit"}
                  </Link>
                ) : null
              }
            >
              Website
            </SectionTitle>
            <Card className="flex flex-col gap-2 px-4 py-3 text-sm">
              <p className="flex items-center gap-2">
                <Globe className="size-4 shrink-0 text-muted" />
                {site ? (
                  <a href={site} target="_blank" rel="noreferrer" className="truncate underline">
                    {lead.website.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  <span className="text-muted">{websitePhrase(website, lead.businessName) || website.reasons[0] || "No website on record — not yet searched."}</span>
                )}
                {site ? <ExternalLink className="size-3 shrink-0 text-subtle" /> : null}
              </p>
              {audit ? (
                <>
                  <p className={cn("text-sm", audit.opportunity === "strong" ? "text-good" : "text-fg")}>
                    {audit.opportunity === "unmeasured" ? "Audit could not measure the site" : OPPORTUNITY_LABEL[audit.opportunity]}
                    <span className="text-xs text-subtle"> · audited {dateLabel(audit.finishedAt)}</span>
                  </p>
                  <ul className="flex flex-col gap-1">
                    {audit.keyFindings.slice(0, 3).map((finding) => (
                      <li key={finding.kind} className="text-xs">
                        <span className="text-fg">{finding.title}</span>
                        <span className="text-muted"> — {finding.evidence}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : lead.website ? (
                <p className="text-xs text-muted">Not audited yet — run an audit before claiming anything about the site.</p>
              ) : null}
            </Card>
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle action={view.emails.length ? <Link to="/send" className="text-xs text-muted hover:text-fg">Send</Link> : null}>Emails</SectionTitle>
            <Card className="px-4 py-2">
              {view.emails.length === 0 ? (
                <p className="py-1.5 text-sm text-subtle">None written yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {view.emails.map((email) => (
                    <li key={email.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{email.subject || "(no subject)"}</span>
                      <span className="shrink-0 text-xs text-muted">
                        {EMAIL_STATUS[email.status] ?? email.status}
                        {email.sentAt ? ` · ${relativeTime(email.sentAt)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle>Timeline</SectionTitle>
            <Card className="px-4 py-2">
              <div className="flex gap-2 py-2">
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Add a note…"
                  rows={1}
                  className="min-h-10 flex-1 resize-y rounded-md bg-surface-2 px-3 py-2 text-sm outline-none"
                />
                <Button variant="secondary" disabled={!note.trim()} onClick={() => void addNote()}>
                  Add
                </Button>
              </div>
              {lead.notes.trim() ? <p className="border-b border-border pb-2 text-xs whitespace-pre-line text-muted">{lead.notes.trim()}</p> : null}
              <Timeline events={view.timeline} />
            </Card>
          </section>
        </div>
      </div>
    </Page>
  );
}
