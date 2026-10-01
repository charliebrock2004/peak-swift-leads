import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { toast } from "sonner";
import { ChevronDown, ExternalLink, Inbox, Loader2, PhoneCall, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/app/app-shell";

import { WithState } from "@/components/app/setup-gate";
import { Badge, Card, EmptyState, PageHeader, SectionTitle, Segmented } from "@/components/app/ui";
import { phoneHref } from "@/lib/leads";
import { checkReplies, setReplyStage, type OutreachState } from "@/lib/outreach/server";
import { REPLY_STAGE_LABELS, REPLY_STAGES, type OutreachEmail, type ReplyStage } from "@/lib/outreach/types";
import { REPLY_INTENT_LABEL, type ReplyIntent } from "@/lib/outreach/replies";
import { getJob } from "@/lib/jobs/server";
import { friendlyServerError } from "@/lib/server-errors";
import { cn } from "@/lib/utils";
import { useAppData } from "@/components/app/app-data";
import { plural, relativeTime } from "@/components/app/format";

export function RepliesPage() {
  return (
    <Page>
      <WithState>{(state) => <Replies state={state} />}</WithState>
    </Page>
  );
}

const SUGGESTION_COPY: Partial<Record<ReplyStage, string>> = {
  interested: "Looks interested",
  not_interested: "Looks like a no",
  booked: "Mentions a meeting",
  needs_follow_up: "Asks a question",
};

function gmailLink(email: OutreachEmail): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email.sendingAccount)}#all/${email.gmailThreadId}`;
}

function Replies({ state }: { state: OutreachState }) {
  const { reload } = useAppData();
  const search = useSearch({ from: "/_app/replies" });
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"all" | ReplyStage>("all");
  const [checking, setChecking] = useState(false);
  const [lastPoll, setLastPoll] = useState<{ at: string; detail: string } | null>(null);
  useEffect(() => {
    let live = true;
    getJob({ data: { type: "reply_poll" } })
      .then((reply) => {
        if (!live || !reply.ok || !reply.job) return;
        const view = JSON.parse(reply.job) as { status: string; finishedAt: string; updatedAt: string; progress?: { detail?: string } };
        setLastPoll({ at: view.finishedAt || view.updatedAt, detail: view.status === "done" ? (view.progress?.detail ?? "") : view.status === "failed" ? "the last check failed" : "checking now…" });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [state]);
  const campaign = search.campaign ? state.campaigns.find((item) => item.id === search.campaign) : undefined;
  const campaignName = useMemo(() => new Map(state.campaigns.map((item) => [item.id, item.name])), [state.campaigns]);
  const leadsById = useMemo(() => new Map(state.leads.map((lead) => [lead.id, lead])), [state.leads]);

  const scoped = state.emails.filter((email) => !campaign || email.campaignId === campaign.id);
  const replies = scoped
    .filter((email) => email.status === "replied")
    .sort((a, b) => (b.repliedAt || b.updatedAt).localeCompare(a.repliedAt || a.updatedAt));
  const stageOf = (email: OutreachEmail): ReplyStage => (email.replyStage || "new") as ReplyStage;
  const shown = filter === "all" ? replies : replies.filter((email) => stageOf(email) === filter);
  const autoReplies = scoped.filter((email) => email.replyKind === "auto_reply" && email.status === "sent");
  const bounces = scoped.filter((email) => email.status === "bounced");

  const poll = async () => {
    setChecking(true);
    try {
      const result = await checkReplies();
      if (!result.ok) {
        toast(result.error);
        return;
      }
      const parts = [
        plural(result.replies, "new reply", "new replies"),
        result.bounces ? plural(result.bounces, "bounce") : "",
        result.autoReplies ? plural(result.autoReplies, "out-of-office reply", "out-of-office replies") : "",
      ].filter(Boolean);
      toast(`Checked ${plural(result.checked, "conversation")}: ${parts.join(" · ")}.${result.more ? " More to check — press again." : ""}`);
      await reload();
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Replies"
        title={replies.length ? `${plural(replies.length, "reply", "replies")}` : "Replies"}
        description={`Read and answer replies in Gmail — Peak Swift never replies for you. Set how each conversation is going; that updates the prospect everywhere and stops follow-ups.${lastPoll?.at ? ` Checked automatically ${relativeTime(lastPoll.at)}${lastPoll.detail ? ` — ${lastPoll.detail}` : ""}.` : ""}`}
        actions={
          <Button variant="secondary" onClick={() => void poll()} disabled={checking || state.connection.status !== "connected"}>
            {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Check for replies
          </Button>
        }
      />
      {campaign ? (
        <div className="flex items-center gap-2">
          <Badge tone="info">Campaign: {campaign.name}</Badge>
          <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => void navigate({ to: "/replies", search: {} })}>
            <X className="inline size-3.5" /> Show all
          </button>
        </div>
      ) : null}

      <Segmented
        label="Stage"
        value={filter}
        onChange={setFilter}
        options={[
          { id: "all" as const, label: "All", count: replies.length },
          ...REPLY_STAGES.map((stage) => ({
            id: stage,
            label: REPLY_STAGE_LABELS[stage],
            count: replies.filter((email) => stageOf(email) === stage).length,
          })),
        ]}
      />

      {shown.length === 0 ? (
        <EmptyState icon={<Inbox />} title={replies.length ? "Nothing at this stage" : "No replies yet"}>
          {replies.length
            ? "Choose another stage above."
            : "When someone writes back to an email sent from here, it appears in this inbox. Bounces and out-of-office replies are kept separately below."}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((email) => (
            <ReplyCard
              key={email.id}
              email={email}
              phone={leadsById.get(email.leadId)?.phone ?? ""}
              campaign={campaignName.get(email.campaignId) ?? ""}
              onStage={async (stage) => {
                const result = await setReplyStage({ data: { emailId: email.id, stage } }).catch((error: unknown) => ({
                  ok: false as const,
                  error: friendlyServerError(error),
                }));
                if (!result.ok) toast(result.error);
                else toast(`${email.businessName}: ${REPLY_STAGE_LABELS[stage]}`);
                await reload();
              }}
            />
          ))}
        </div>
      )}

      {autoReplies.length > 0 ? <Collapsed title={`Out-of-office (${autoReplies.length})`} note="Automatic replies are not conversations: follow-ups carry on as scheduled." emails={autoReplies} /> : null}
      {bounces.length > 0 ? (
        <Collapsed
          title={`Bounced (${bounces.length})`}
          note="The address did not accept the email. It has been added to the suppression list so nothing is sent there again."
          emails={bounces}
        />
      ) : null}
    </>
  );
}

function ReplyCard({
  email,
  phone,
  campaign,
  onStage,
}: {
  email: OutreachEmail;
  phone: string;
  campaign: string;
  onStage: (stage: ReplyStage) => Promise<void>;
}) {
  const [original, setOriginal] = useState(false);
  const [busy, setBusy] = useState<ReplyStage | "">("");
  const stage = (email.replyStage || "new") as ReplyStage;
  const suggestion = email.replySuggestion && email.replySuggestion !== "new" && stage === "new" ? SUGGESTION_COPY[email.replySuggestion] : "";
  const tel = phoneHref(phone);
  return (
    <Card as="article" className="p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-medium">{email.businessName}</h3>
          <p className="truncate text-sm text-muted">{email.replyFrom || email.recipient}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {email.replyIntent && email.replyIntent !== "unsubscribe" ? (
            <Badge tone={email.replyIntent === "positive" ? "good" : email.replyIntent === "negative" ? "bad" : "neutral"}>
              {REPLY_INTENT_LABEL[email.replyIntent as ReplyIntent] ?? email.replyIntent}
            </Badge>
          ) : null}
          {suggestion ? <Badge tone="info">{suggestion}</Badge> : null}
          {email.replyKind === "unsubscribe" ? <Badge tone="warn">Asked to stop — suppressed</Badge> : null}
          <span className="text-xs text-subtle">{relativeTime(email.repliedAt)}</span>
        </div>
      </div>
      {campaign ? <p className="mt-1 text-xs text-subtle">Campaign: {campaign}</p> : null}

      <blockquote className="mt-3 rounded-lg border-l-2 border-accent/60 bg-surface-2 px-3.5 py-2.5 text-sm">
        {email.replySubject ? <p className="text-xs text-subtle">{email.replySubject}</p> : null}
        <p className="mt-0.5 text-fg">{email.replySnippet || "Open it in Gmail to read the reply."}</p>
      </blockquote>

      <button type="button" onClick={() => setOriginal((open) => !open)} className="mt-2 flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ChevronDown className={cn("size-3.5 transition-transform", original ? "rotate-180" : "")} />
        Your original email
      </button>
      {original ? (
        <div className="rise-in mt-2 rounded-md bg-bg/60 px-3 py-2.5 shadow-(--shadow-border)">
          <p className="text-sm font-medium">{email.subject}</p>
          <p className="email-preview mt-1.5 text-muted">{email.body}</p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-3">
        <div className="scroll-x -mx-1 flex gap-1.5 px-1" role="group" aria-label="Stage">
          {REPLY_STAGES.map((option) => (
            <button
              key={option}
              type="button"
              disabled={Boolean(busy)}
              onClick={async () => {
                setBusy(option);
                await onStage(option);
                setBusy("");
              }}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors",
                stage === option ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg",
              )}
            >
              {busy === option ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {REPLY_STAGE_LABELS[option]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {email.gmailThreadId ? (
            <a href={gmailLink(email)} target="_blank" rel="noreferrer noopener">
              <Button size="sm">
                <ExternalLink />
                Reply in Gmail
              </Button>
            </a>
          ) : null}
          {tel ? (
            <a href={tel}>
              <Button size="sm" variant="secondary">
                <PhoneCall />
                Call {phone}
              </Button>
            </a>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function Collapsed({ title, note, emails }: { title: string; note: string; emails: OutreachEmail[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-2">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex items-center gap-1 self-start">
        <SectionTitle>{title}</SectionTitle>
        <ChevronDown className={cn("size-4 text-subtle transition-transform", open ? "rotate-180" : "")} />
      </button>
      {open ? (
        <>
          <p className="text-sm text-muted">{note}</p>
          <Card as="div" className="divide-y divide-border">
            {emails.map((email) => (
              <div key={email.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium">{email.businessName}</p>
                  <span className="shrink-0 text-xs text-subtle">{relativeTime(email.autoReplyAt || email.bouncedAt || email.updatedAt)}</span>
                </div>
                <p className="truncate text-xs text-muted">{email.replySnippet || email.error}</p>
              </div>
            ))}
          </Card>
        </>
      ) : null}
    </section>
  );
}
