import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { toast } from "sonner";
import { ExternalLink, Inbox, Mail, RotateCcw, Search, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/app/app-shell";

import { WithState } from "@/components/app/setup-gate";
import { EmailCard, type CardActions } from "@/components/app/email-card";
import { SendSession } from "@/components/app/send-session";
import { useEvidence } from "@/components/app/use-evidence";
import { sendQueue } from "@/components/app/send-queue";
import { Badge, Card, EmptyState, Notice, PageHeader, Segmented } from "@/components/app/ui";
import { followUpsDue } from "@/lib/outreach/follow-ups";
import {
  generateEmails,
  reconcileSending,
  retryFailedEmails,
  setEmailDecision,
  updateDraft,
  type OutreachState,
} from "@/lib/outreach/server";
import type { OutreachEmail, OutreachLead } from "@/lib/outreach/types";
import { friendlyServerError } from "@/lib/server-errors";
import { useAppData } from "@/components/app/app-data";
import { plural, relativeTime } from "@/components/app/format";

type View = "ready" | "attention" | "failed" | "follow-ups" | "sent";

export function SendPage() {
  return (
    <Page wide>
      <WithState>{(state) => <SendScreen state={state} />}</WithState>
    </Page>
  );
}

function SendScreen({ state }: { state: OutreachState }) {
  const { reload, context } = useAppData();
  const search = useSearch({ from: "/_app/send" });
  const navigate = useNavigate();
  const [view, setView] = useState<View>((["ready", "attention", "failed", "follow-ups", "sent"].includes(search.view ?? "") ? search.view : "ready") as View);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [session, setSession] = useState<OutreachEmail[] | null>(null);
  const [reconciled, setReconciled] = useState<string>("");

  // Anything whose answer was lost last time is settled from Gmail's own
  // record before this screen offers to send anything.
  useEffect(() => {
    if (!state.emails.some((email) => email.status === "sending")) return;
    void reconcileSending()
      .then(async (result) => {
        if (!result.ok) return setReconciled(result.error);
        if (result.checked > 0) {
          setReconciled(
            `${plural(result.checked, "unfinished send")} checked against Gmail: ${result.recovered} had gone out and are now recorded, ${result.released} never went and can be retried.`,
          );
          await reload();
        } else if (result.error) setReconciled(result.error);
      })
      .catch(() => undefined);
    // Once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const campaign = search.campaign ? state.campaigns.find((item) => item.id === search.campaign) : undefined;
  const groups = useMemo(() => sendQueue(state, campaign?.id), [state, campaign?.id]);
  const leadsById = useMemo(() => new Map((state.leads as OutreachLead[]).map((lead) => [lead.id, lead])), [state.leads]);

  const due = useMemo(
    () => (context ? followUpsDue(state.leads as OutreachLead[], state.emails, state.settings, context) : []),
    [state.leads, state.emails, state.settings, context],
  );

  // Default selection: everything ready. Kept as the person changes it.
  const chosen = selected ?? new Set(groups.ready.map((entry) => entry.email.id));
  const chosenEmails = groups.ready.filter((entry) => chosen.has(entry.email.id)).map((entry) => entry.email);
  const remaining = state.allowance.remaining;
  const willSend = Math.min(chosenEmails.length, remaining);
  const evidence = useEvidence(useMemo(() => [...groups.ready, ...groups.attention].map((entry) => entry.email.leadId), [groups]));

  const toggle = (id: string) =>
    setSelected(() => {
      const next = new Set(chosen);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const withBusy = async (id: string, label: string, task: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [id]: label }));
    try {
      await task();
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setBusy((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  const actions: CardActions = {
    save: (id, subject, body) =>
      withBusy(id, "save", async () => {
        const result = await updateDraft({ data: { id, subject, body } });
        if (!result.ok) toast(result.error);
        else toast("Saved. Edited emails need approving again.");
        await reload();
      }),
    regenerate: (email) =>
      withBusy(email.id, "regenerate", async () => {
        const result = await generateEmails({
          data: { leadIds: [email.leadId], mode: state.settings.defaultMode || "ai", kind: email.kind, campaignId: email.campaignId },
        });
        if (!result.ok) toast(result.error);
        else if (result.rows[0] && !result.rows[0].ok) toast(result.rows[0].error ?? "Could not rewrite it.");
        else if (result.rows[0]?.note) toast(result.rows[0].note);
        await reload();
      }),
    approve: (id) =>
      withBusy(id, "approve", async () => {
        const result = await setEmailDecision({ data: { ids: [id], decision: "queue" } });
        if (!result.ok) toast(result.error);
        else if (result.refused.length) toast(result.refused[0]!);
        await reload();
      }),
    skip: (id) =>
      withBusy(id, "skip", async () => {
        await setEmailDecision({ data: { ids: [id], decision: "skip" } });
        await reload();
      }),
    sendNow: (email) => setSession([email]),
  };

  const writeFollowUps = async (leadIds: string[], kind: "follow-up-1" | "follow-up-2") => {
    const result = await generateEmails({ data: { leadIds, mode: state.settings.defaultMode || "ai", kind } }).catch((error: unknown) => ({
      ok: false as const,
      error: friendlyServerError(error),
    }));
    if (!result.ok) toast(result.error);
    else toast(`${plural(result.rows.filter((row) => row.ok).length, "follow-up")} written — review them under Ready.`);
    await reload();
    setView("ready");
  };

  const sentToday = groups.sent.filter((email) => email.sentAt.slice(0, 10) === new Date().toISOString().slice(0, 10));

  return (
    <>
      <PageHeader
        eyebrow="Send"
        title={groups.ready.length ? `${plural(groups.ready.length, "email")} ready to send` : "Ready to send"}
        description={
          state.connection.status === "connected"
            ? `Sending as ${state.connection.email} · ${state.allowance.sent} of ${state.allowance.limit} sent today · ${remaining} left`
            : "Connect Gmail in Settings to send."
        }
        actions={
          groups.ready.length ? (
            <Button
              className="h-11 px-5"
              disabled={willSend === 0 || state.connection.status !== "connected"}
              onClick={() => setSession(chosenEmails)}
            >
              <Send />
              Send {plural(willSend, "email")}
            </Button>
          ) : null
        }
      />

      {campaign ? (
        <div className="flex items-center gap-2">
          <Badge tone="info">Campaign: {campaign.name}</Badge>
          <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => void navigate({ to: "/send", search: {} })}>
            <X className="inline size-3.5" /> Show all
          </button>
        </div>
      ) : null}

      {state.connection.status !== "connected" ? (
        <Notice
          tone={state.connection.status === "needs_attention" ? "bad" : "warn"}
          title={state.connection.status === "needs_attention" ? "Gmail needs reconnecting" : "Gmail is not connected"}
          action={
            <Link to="/settings" search={{ section: "gmail" }}>
              <Button variant="secondary" size="sm">
                Open Gmail settings
              </Button>
            </Link>
          }
        >
          {state.connection.lastError || "You can review and approve emails now; sending needs Gmail."}
        </Notice>
      ) : null}
      {reconciled ? <Notice tone="info" title="Unfinished sends checked">{reconciled}</Notice> : null}
      {remaining === 0 && groups.ready.length > 0 ? (
        <Notice tone="warn" title="Today's limit is reached">
          Everything approved stays ready for tomorrow. Change the limit in Settings → Sending.
        </Notice>
      ) : null}

      <Segmented
        label="Emails"
        value={view}
        onChange={setView}
        options={[
          { id: "ready", label: "Ready", count: groups.ready.length },
          { id: "attention", label: "Blocked", count: groups.attention.length },
          { id: "failed", label: "Failed", count: groups.failed.length },
          { id: "follow-ups", label: "Follow-ups due", count: due.length },
          { id: "sent", label: "Sent", count: groups.sent.length },
        ]}
      />

      {view === "ready" ? (
        groups.ready.length === 0 ? (
          <EmptyState
            icon={<Mail />}
            title="Nothing waiting to be sent"
            action={
              <Link to="/find">
                <Button>
                  <Search />
                  Find & reach prospects
                </Button>
              </Link>
            }
          >
            Run Find to discover new prospects and write their emails, or write to prospects you already have from Prospects.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between text-sm text-muted">
              <span>
                {chosenEmails.length} of {groups.ready.length} selected
              </span>
              <span className="flex gap-3">
                <button type="button" className="hover:text-fg" onClick={() => setSelected(new Set(groups.ready.map((entry) => entry.email.id)))}>
                  Select all
                </button>
                <button type="button" className="hover:text-fg" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </span>
            </div>
            {groups.ready.map(({ email, blocked }) => (
              <EmailCard
                key={`${email.id}-${email.updatedAt}`}
                email={email}
                lead={leadsById.get(email.leadId)}
                evidence={evidence.get(email.leadId)}
                blocked={blocked}
                selected={chosen.has(email.id)}
                onToggle={() => toggle(email.id)}
                busy={busy[email.id] ?? ""}
                actions={actions}
              />
            ))}
          </div>
        )
      ) : null}

      {view === "attention" ? (
        groups.attention.length === 0 ? (
          <EmptyState title="Nothing is blocked">Every draft passes the quality gate and the eligibility rules.</EmptyState>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">
              These cannot be sent as they stand. Each says why — edit and approve again, regenerate, or skip.
            </p>
            {groups.attention.map(({ email, blocked }) => (
              <EmailCard
                key={`${email.id}-${email.updatedAt}`}
                email={email}
                lead={leadsById.get(email.leadId)}
                evidence={evidence.get(email.leadId)}
                blocked={blocked}
                selected={false}
                onToggle={() => undefined}
                busy={busy[email.id] ?? ""}
                actions={actions}
              />
            ))}
          </div>
        )
      ) : null}

      {view === "failed" ? <FailedList emails={groups.failed} onChanged={reload} onRequeued={() => setView("ready")} /> : null}

      {view === "follow-ups" ? (
        !state.settings.followUpsOn ? (
          <EmptyState
            title="Follow-ups are off"
            action={
              <Link to="/settings" search={{ section: "follow-ups" }}>
                <Button variant="secondary">Turn on follow-ups</Button>
              </Link>
            }
          >
            When on, a short follow-up is suggested {state.settings.followUp1Days} days after the first email if there is no reply — and
            never after a reply, an unsubscribe, a bounce, or once you are talking to them.
          </EmptyState>
        ) : due.length === 0 ? (
          <EmptyState title="No follow-ups due">Follow-ups appear here when their day comes and nobody has replied.</EmptyState>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex justify-end">
              <Button
                variant="secondary"
                onClick={() => {
                  const first = due.filter((entry) => entry.kind === "follow-up-1").map((entry) => entry.lead.id);
                  const second = due.filter((entry) => entry.kind === "follow-up-2").map((entry) => entry.lead.id);
                  void (async () => {
                    if (first.length) await writeFollowUps(first, "follow-up-1");
                    if (second.length) await writeFollowUps(second, "follow-up-2");
                  })();
                }}
              >
                Write all {due.length}
              </Button>
            </div>
            <Card as="div" className="divide-y divide-border">
              {due.map((entry) => (
                <div key={entry.lead.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{entry.lead.businessName}</p>
                    <p className="text-xs text-muted">
                      {entry.kind === "follow-up-1" ? "First follow-up" : "Final follow-up"} · first emailed {relativeTime(entry.after.sentAt)}
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => void writeFollowUps([entry.lead.id], entry.kind as "follow-up-1" | "follow-up-2")}>
                    Write
                  </Button>
                </div>
              ))}
            </Card>
          </div>
        )
      ) : null}

      {view === "sent" ? (
        groups.sent.length === 0 ? (
          <EmptyState icon={<Inbox />} title="Nothing sent yet" />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              {sentToday.length} sent today · {groups.sent.length} in total. Each has Gmail's own message id.
            </p>
            <Card as="div" className="divide-y divide-border">
              {groups.sent.slice(0, 200).map((email) => (
                <div key={email.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{email.businessName}</p>
                    <p className="truncate text-xs text-muted">
                      {email.recipient} · {email.subject}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone={email.status === "replied" ? "good" : email.status === "bounced" ? "bad" : "neutral"}>
                      {email.status === "replied" ? "Replied" : email.status === "bounced" ? "Bounced" : email.replyKind === "auto_reply" ? "Auto-reply" : "Sent"}
                    </Badge>
                    <span className="text-xs text-subtle">{relativeTime(email.sentAt)}</span>
                  </div>
                  {email.gmailThreadId ? (
                    <a
                      href={`https://mail.google.com/mail/?authuser=${encodeURIComponent(email.sendingAccount)}#all/${email.gmailThreadId}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
                      aria-label="Open in Gmail"
                    >
                      <ExternalLink className="size-4" />
                    </a>
                  ) : null}
                </div>
              ))}
            </Card>
          </div>
        )
      ) : null}

      {session ? (
        <SendSession
          open
          emails={session}
          delaySeconds={session.length > 1 ? state.settings.delaySeconds : 0}
          remaining={remaining}
          onClose={() => {
            setSession(null);
            setSelected(null);
          }}
          onChanged={reload}
        />
      ) : null}
    </>
  );
}

function FailedList({ emails, onChanged, onRequeued }: { emails: OutreachEmail[]; onChanged: () => Promise<void>; onRequeued: () => void }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});
  if (emails.length === 0) return <EmptyState title="No failed sends">Anything Gmail refuses appears here with the reason.</EmptyState>;
  const retry = async (ids: string[]) => {
    setBusy(true);
    try {
      const result = await retryFailedEmails({ data: { ids } });
      if (!result.ok) {
        toast(result.error);
        return;
      }
      const next: Record<string, string> = {};
      for (const item of result.results) next[item.emailId] = item.reason;
      setResults((current) => ({ ...current, ...next }));
      const requeued = result.results.filter((item) => item.result === "requeued").length;
      if (requeued) toast(`${plural(requeued, "email")} checked in Gmail — not sent before, so approved again. Press Send when ready.`);
      await onChanged();
      if (requeued) onRequeued();
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setBusy(false);
    }
  };
  const retryable = emails.filter((email) => email.failureKind !== "permanent");
  return (
    <div className="flex flex-col gap-3">
      {retryable.length > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted">Retrying checks Gmail first. If an email did go out, it is recorded as sent — never sent twice.</p>
          <Button variant="secondary" disabled={busy} onClick={() => void retry(retryable.map((email) => email.id))}>
            <RotateCcw />
            Retry {retryable.length}
          </Button>
        </div>
      ) : null}
      <Card as="div" className="divide-y divide-border">
        {emails.map((email) => (
          <div key={email.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{email.businessName}</p>
              <p className="text-xs text-muted">{email.recipient}</p>
              <p className="mt-1 text-sm text-bad">{email.error || "Failed"}</p>
              {results[email.id] ? <p className="mt-1 text-xs text-muted">{results[email.id]}</p> : null}
            </div>
            {email.failureKind === "permanent" ? (
              <Badge tone="bad">Needs a fix</Badge>
            ) : (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void retry([email.id])}>
                Retry
              </Button>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
