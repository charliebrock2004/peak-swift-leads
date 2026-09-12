import { useMemo, useState } from "react";
import { Check, ChevronDown, Loader2, Pencil, RotateCcw, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OutreachActions } from "@/components/outreach/outreach-panel";
import type { OutreachState } from "@/lib/outreach/server";
import type { OutreachEmail } from "@/lib/outreach/types";
import { leadFacts } from "@/lib/outreach/compose";
import { parseEvidenceSummary } from "@/lib/outreach/evidence";
import type { Campaign } from "@/lib/outreach/campaigns";
import { decideProspect } from "@/lib/decision";
import type { OutreachLead } from "@/lib/outreach/types";
import { cn } from "@/lib/utils";

/**
 * Read the emails before they go, then send them.
 *
 * Nothing here sends by accident: a draft has to be approved, an approved email
 * has to be queued, and sending is one deliberate button that says exactly how
 * many will go and how many the daily limit still allows.
 */
export function OutreachQueue({
  state,
  busy,
  actions,
}: {
  state: OutreachState;
  busy: string;
  actions: OutreachActions;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const drafts: OutreachEmail[] = [];
    const ready: OutreachEmail[] = [];
    const failed: OutreachEmail[] = [];
    const sent: OutreachEmail[] = [];
    for (const email of state.emails) {
      if (email.status === "draft") drafts.push(email);
      else if (email.status === "approved" || email.status === "queued") ready.push(email);
      else if (email.status === "failed") failed.push(email);
      else if (email.status === "sent" || email.status === "replied") sent.push(email);
    }
    return { drafts, ready, failed, sent };
  }, [state.emails]);

  const leadsById = useMemo(() => {
    const map = new Map(state.leads.map((lead) => [lead.id, lead]));
    return map;
  }, [state.leads]);

  const queued = groups.ready.filter((email) => email.status === "queued");
  const willSend = Math.min(queued.length, state.allowance.batch);

  function startEdit(email: OutreachEmail) {
    setEditing(email.id);
    setDraftSubject(email.subject);
    setDraftBody(email.body);
  }

  async function saveEdit(id: string) {
    await actions.saveDraft(id, draftSubject, draftBody);
    setEditing(null);
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const chosenDrafts = groups.drafts.filter((email) => selected.has(email.id)).map((email) => email.id);

  return (
    <section className="flex flex-col gap-6">
      {groups.drafts.length > 0 ? (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-xl font-medium">{groups.drafts.length} to review</h3>
            <div className="ml-auto flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setSelected(new Set(groups.drafts.map((email) => email.id)))}
              >
                Select all
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          </div>

          <ul className="mt-3 flex flex-col gap-2">
            {groups.drafts.map((email) => (
              <li key={email.id} className="lead-card">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 size-5 shrink-0"
                    checked={selected.has(email.id)}
                    onChange={() => toggle(email.id)}
                    aria-label={`Select the email to ${email.businessName}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="leading-snug font-medium">{email.businessName}</h4>
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                        {email.generatedBy === "ai" ? "AI" : email.generatedBy === "manual" ? "Edited" : "Template"}
                      </span>
                      <CampaignTag email={email} campaigns={state.campaigns} />
                      {email.kind !== "initial" ? (
                        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                          {email.kind === "follow-up-1" ? "Follow-up 1" : "Follow-up 2"}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-muted">{email.recipient}</p>

                    {editing === email.id ? (
                      <div className="mt-3 flex flex-col gap-2">
                        <Input
                          value={draftSubject}
                          onChange={(event) => setDraftSubject(event.target.value)}
                          aria-label="Subject"
                          className="bg-bg"
                        />
                        <textarea
                          rows={12}
                          value={draftBody}
                          onChange={(event) => setDraftBody(event.target.value)}
                          aria-label="Email body"
                          className="w-full resize-y rounded-md bg-bg px-3 py-2 text-sm text-fg shadow-(--shadow-border) outline-none"
                        />
                        <div className="flex gap-2">
                          <Button size="sm" disabled={busy !== ""} onClick={() => void saveEdit(email.id)}>
                            Save
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="mt-2 text-sm font-medium">{email.subject}</p>
                        <p className="mt-1 text-sm whitespace-pre-wrap text-muted">{email.body}</p>
                        <WhyThisEmail email={email} lead={leadsById.get(email.leadId)} />
                      </>
                    )}

                    {editing === email.id ? null : (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" disabled={busy !== ""} onClick={() => void actions.decide([email.id], "queue")}>
                          <Check />
                          Approve
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => startEdit(email)}>
                          <Pencil />
                          Edit
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy !== ""}
                          onClick={() => void actions.generate([email.leadId], state.settings.defaultMode, email.kind)}
                        >
                          {busy === "generate" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                          Regenerate
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy !== ""}
                          onClick={() => void actions.decide([email.id], "skip")}
                        >
                          <X />
                          Skip
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {chosenDrafts.length > 0 ? (
            <div className="mt-3 flex gap-2">
              <Button className="h-11 flex-1" disabled={busy !== ""} onClick={() => void actions.decide(chosenDrafts, "queue")}>
                <Check />
                Approve {chosenDrafts.length}
              </Button>
              <Button variant="secondary" className="h-11" disabled={busy !== ""} onClick={() => void actions.decide(chosenDrafts, "skip")}>
                Skip {chosenDrafts.length}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
        <h3 className="font-display text-lg font-medium">
          {queued.length} email{queued.length === 1 ? "" : "s"} ready to send
        </h3>
        <p className="mt-1 text-sm text-muted">
          {state.allowance.atLimit
            ? `Daily limit reached — ${state.allowance.sent} of ${state.allowance.limit} sent today.`
            : `${willSend} will go in this batch. ${state.allowance.remaining} left of today's ${state.allowance.limit}.`}
        </p>
        {state.connection.status !== "connected" ? (
          <p className="mt-2 text-sm text-warm-lead">Connect Gmail in Settings before sending.</p>
        ) : null}
        <Button
          className="mt-4 h-12 w-full sm:w-auto"
          disabled={busy !== "" || willSend === 0 || state.connection.status !== "connected"}
          onClick={() => void actions.send()}
        >
          {busy === "send" ? <Loader2 className="animate-spin" /> : <Send />}
          Send {willSend} now
        </Button>
      </div>

      {groups.failed.length > 0 ? (
        <div>
          <h3 className="font-display text-lg font-medium">{groups.failed.length} failed</h3>
          <p className="mt-1 text-sm text-muted">
            These were not sent and will not be retried on their own. Fix the address or skip them.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {groups.failed.map((email) => (
              <li key={email.id} className="rounded-md bg-surface px-3 py-2.5 shadow-(--shadow-border)">
                <p className="text-sm font-medium">{email.businessName}</p>
                <p className="truncate text-xs text-muted">{email.recipient}</p>
                <p className="mt-1 text-xs text-hot">{email.error}</p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="secondary" disabled={busy !== ""} onClick={() => void actions.decide([email.id], "queue")}>
                    Try again
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy !== ""} onClick={() => void actions.decide([email.id], "skip")}>
                    Give up
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {groups.sent.length > 0 ? (
        <div>
          <h3 className="font-display text-lg font-medium">Sent</h3>
          <ul className="mt-3 flex flex-col gap-1.5">
            {groups.sent.slice(0, 50).map((email) => (
              <li key={email.id} className="rounded-md bg-surface shadow-(--shadow-border)">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{email.businessName}</p>
                      <p className="truncate text-xs text-muted">
                        {email.recipient} ·{" "}
                        {email.sentAt ? new Date(email.sentAt).toLocaleDateString("en-GB") : ""}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-xs",
                        email.status === "replied" ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
                      )}
                    >
                      {email.status === "replied" ? "Replied" : "Sent"}
                    </span>
                    <CampaignTag email={email} campaigns={state.campaigns} />
                    <ChevronDown className="size-4 shrink-0 text-muted group-open:rotate-180" />
                  </summary>
                  <div className="px-3 pb-3">
                    <p className="text-sm font-medium">{email.subject}</p>
                    <p className="mt-1 text-sm whitespace-pre-wrap text-muted">{email.body}</p>
                    <WhyThisEmail email={email} lead={leadsById.get(email.leadId)} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state.emails.length === 0 ? (
        <div className="rounded-xl bg-surface px-5 py-12 text-center shadow-(--shadow-border)">
          <p className="font-medium">Nothing written yet</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            Pick some prospects and write their emails. They land here for you to read before anything is sent.
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Why this email says what it says.
 *
 * Prefers the evidence stored with the email over anything recomputed from the
 * lead. The lead row moves — a website appears, a review count changes — and a
 * sent email must still be explainable by what was true when it was written.
 * Emails written before the evidence column exists fall back to the live facts,
 * which is the best answer available for them and is labelled as such.
 */
/**
 * Which campaign an outreach event belongs to.
 *
 * Empty for every email written outside a campaign, and for everything written
 * before campaigns existed — shown as nothing rather than as "no campaign",
 * which would read as a fault on perfectly good history.
 */
function CampaignTag({ email, campaigns }: { email: OutreachEmail; campaigns: Campaign[] }) {
  if (!email.campaignId) return null;
  const campaign = campaigns.find((entry) => entry.id === email.campaignId);
  if (!campaign) return null;
  return (
    <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
      {campaign.name || "Campaign"}
    </span>
  );
}

function WhyThisEmail({ email, lead }: { email: OutreachEmail; lead: OutreachLead | undefined }) {
  const stored = parseEvidenceSummary(email.personalisationEvidence);
  if (stored.length > 0) {
    return (
      <div className="mt-3 rounded-md bg-surface-2 px-3 py-2.5">
        <p className="text-xs font-medium text-muted">Why this email was written</p>
        <ul className="mt-1 flex flex-col gap-0.5">
          {stored.slice(0, 6).map((item) => (
            <li key={`${item.kind}-${item.text}`} className="text-xs text-subtle">
              {item.text}
              {item.source ? <span className="text-subtle/70"> · {item.source}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (!lead) return null;
  const decision = decideProspect(lead);
  const facts = leadFacts(lead);
  if (facts.length === 0) return null;
  return (
    <div className="mt-3 rounded-md bg-surface-2 px-3 py-2.5">
      <p className="text-xs font-medium text-muted">
        {decision.level} {decision.score} · what this lead looks like now
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {facts.slice(0, 6).map((fact) => (
          <li key={fact} className="text-xs text-subtle">
            {fact}
          </li>
        ))}
      </ul>
    </div>
  );
}
