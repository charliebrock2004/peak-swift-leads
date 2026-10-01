import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  CircleCheck,
  Inbox,
  Mail,
  Phone,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  UserRound,
  UserX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/app/app-shell";

import { WithState } from "@/components/app/setup-gate";
import { sendQueue } from "@/components/app/send-queue";
import { Badge, Card, ProgressBar, SectionTitle, Stat } from "@/components/app/ui";
import { useScores } from "@/components/app/use-scores";
import { liveLeads } from "@/lib/leads";
import { outreachOverview } from "@/lib/outreach/analytics";
import { callQueue } from "@/lib/outreach/call-queue";
import { campaignProgress } from "@/lib/outreach/campaigns";
import { checkEligibility } from "@/lib/outreach/eligibility";
import { followUpsDue } from "@/lib/outreach/follow-ups";
import { listRuns, type OutreachState } from "@/lib/outreach/server";
import { funnelHeadline, parseFunnel } from "@/lib/outreach/run-funnel";
import type { OutreachLead } from "@/lib/outreach/types";
import { useLeadsStore } from "@/store/leads-store";
import { cn } from "@/lib/utils";
import { useAppData } from "@/components/app/app-data";
import { plural, relativeTime } from "@/components/app/format";
import { missingNames, whereRunning } from "@/lib/outreach/oauth-setup";

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function HomePage() {
  return (
    <Page wide>
      <WithState>{(state) => <Home state={state} />}</WithState>
    </Page>
  );
}

type Attention = { key: string; tone: "bad" | "warn" | "info" | "good"; icon: typeof Mail; title: string; detail: string; to: string; search?: Record<string, string>; cta: string };

function Home({ state }: { state: OutreachState }) {
  const { context, prospecting } = useAppData();
  const sheet = useLeadsStore((store) => store.leads);
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof listRuns>> | null>(null);
  useEffect(() => {
    void listRuns().then(setRuns).catch(() => setRuns(null));
  }, []);

  const leads = state.leads as OutreachLead[];
  const scores = useScores(state);
  const overview = useMemo(() => outreachOverview(state.leads, state.emails), [state.leads, state.emails]);
  const figures = useMemo(() => {
    let good = 0;
    let held = 0;
    for (const lead of leads) {
      const action = scores.get(lead.id)?.action;
      if (action === "CALL" || action === "EMAIL") good += 1;
      if (context && checkEligibility(lead, context).manualReview) held += 1;
    }
    const emails = state.emails;
    const queue = sendQueue(state);
    return {
      good,
      held,
      ready: queue.ready.length,
      blocked: queue.attention.length,
      failed: queue.failed.length,
      unfinished: emails.filter((email) => email.status === "sending").length,
      newReplies: emails.filter((email) => email.status === "replied" && (email.replyStage || "new") === "new").length,
      followUps: context ? followUpsDue(leads, emails, state.settings, context).length : 0,
    };
  }, [leads, state, context, scores]);
  const calls = useMemo(() => callQueue(liveLeads(sheet)).today.length, [sheet]);

  const attention: Attention[] = [];
  const connection = state.connection;
  if (!connection.configured) {
    const setup = connection.setup;
    attention.push({
      key: "oauth",
      tone: "bad",
      icon: AlertTriangle,
      title: setup?.missing.length ? `${missingNames(setup)} not visible to this build` : "Gmail is not set up on this deployment",
      detail: setup?.missing.length
        ? `This is ${whereRunning(setup)}. If you added the variables after it was built, it needs a redeploy.`
        : "The Google client id and secret are missing, so nothing can be sent.",
      to: "/settings",
      search: { section: "gmail" },
      cta: "See why",
    });
  } else if (connection.status === "needs_attention") {
    attention.push({ key: "gmail", tone: "bad", icon: AlertTriangle, title: "Gmail needs reconnecting", detail: connection.lastError || "The connection stopped working. Nothing can be sent until it is reconnected.", to: "/settings", search: { section: "gmail" }, cta: "Reconnect" });
  } else if (connection.status !== "connected") {
    attention.push({ key: "gmail", tone: "warn", icon: Mail, title: "Connect Gmail to send", detail: "Emails go out from your own Gmail account.", to: "/settings", search: { section: "gmail" }, cta: "Connect" });
  }
  if (!state.profileSaved) {
    attention.push({ key: "profile", tone: "warn", icon: UserRound, title: "Set up your business profile", detail: `Emails are signed "${state.profile.senderName} · ${state.profile.businessName}" until you do.`, to: "/settings", search: { section: "profile" }, cta: "Set up" });
  }
  if (figures.unfinished > 0) {
    attention.push({ key: "unfinished", tone: "warn", icon: RotateCcw, title: `${plural(figures.unfinished, "send")} did not finish`, detail: "Opening Send checks each one against Gmail before anything is retried.", to: "/send", cta: "Check" });
  }
  if (figures.failed > 0) {
    attention.push({ key: "failed", tone: "bad", icon: AlertTriangle, title: `${plural(figures.failed, "email")} failed to send`, detail: "See why, and retry safely — Gmail is checked first so nothing is sent twice.", to: "/send", search: { view: "failed" }, cta: "Review" });
  }
  if (figures.newReplies > 0) {
    attention.push({ key: "replies", tone: "good", icon: Inbox, title: `${plural(figures.newReplies, "new reply", "new replies")}`, detail: "Answer them from Gmail, then set how each one is going.", to: "/replies", cta: "Open" });
  }
  if (figures.ready > 0) {
    attention.push({ key: "ready", tone: "info", icon: Send, title: `${plural(figures.ready, "email")} ready to review`, detail: `${state.allowance.remaining} can go today under your daily limit.`, to: "/send", cta: "Review & send" });
  }
  if (figures.blocked > 0) {
    attention.push({ key: "blocked", tone: "warn", icon: AlertTriangle, title: `${plural(figures.blocked, "email")} blocked by the quality gate`, detail: "Each one says why. Edit or regenerate it, or skip it.", to: "/send", search: { view: "attention" }, cta: "Fix" });
  }
  if (figures.followUps > 0) {
    attention.push({ key: "followups", tone: "info", icon: Mail, title: `${plural(figures.followUps, "follow-up")} due`, detail: "No reply yet — a short, polite follow-up is due.", to: "/send", search: { view: "follow-ups" }, cta: "Write" });
  }
  if (calls > 0) {
    attention.push({ key: "calls", tone: "info", icon: Phone, title: `${plural(calls, "call")} to make today`, detail: "Good prospects with no public email, and follow-ups whose day has come.", to: "/calls", cta: "Start calling" });
  }
  if (figures.held > 0) {
    attention.push({ key: "held", tone: "warn", icon: UserX, title: `${plural(figures.held, "prospect")} held for you`, detail: "Not confirmed as companies — check Companies House, or call them instead.", to: "/prospects", search: { filter: "manual-review" }, cta: "Look" });
  }

  const activeCampaigns = state.campaigns.filter((campaign) => campaign.status === "ACTIVE").slice(0, 3);
  const members = state.campaignMembers;
  const recent = runs && runs.ok ? runs.runs.slice(0, 3) : [];
  const now = new Date();

  return (
    <>
      <header className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-medium tracking-widest text-subtle uppercase">
            {now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
          </p>
          <h1 className="mt-1 font-display text-[1.9rem] leading-tight font-medium tracking-tight md:text-[2.25rem]">
            {greeting(now)}, {state.profile.senderName}
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            {state.allowance.sent} of {state.allowance.limit} emails sent today · {plural(overview.replies, "reply", "replies")} so far
          </p>
        </div>
        <Link to="/find" className="md:shrink-0">
          <Button className="h-12 w-full px-5 text-[15px] md:w-auto">
            {prospecting.running ? <Sparkles className="animate-pulse" /> : <Search />}
            {prospecting.running ? "Run in progress" : "Find & reach prospects"}
            <ArrowRight />
          </Button>
        </Link>
      </header>

      <div className="order-2 grid grid-cols-2 gap-3 sm:grid-cols-3 md:order-none lg:grid-cols-5">
        <Stat label="Prospects" value={overview.prospects} sub={`${figures.good} good opportunities`} to="/prospects" />
        <Stat label="Verified emails" value={overview.emailsFound} sub="Published, never guessed" to="/prospects" search={{ filter: "email" }} />
        <Stat label="Ready to send" value={figures.ready} sub={`${state.allowance.remaining} can go today`} to="/send" tone={figures.ready ? "info" : "neutral"} />
        <Stat label="Sent today" value={`${state.allowance.sent}/${state.allowance.limit}`} sub={`${overview.emailsSent} sent in total`} to="/send" search={{ view: "sent" }} />
        <Stat label="Call list" value={calls} sub="To ring today" to="/calls" />
        <Stat label="Replies" value={overview.replies} sub={figures.newReplies ? `${figures.newReplies} new` : overview.replyRate.value !== null ? `${Math.round(overview.replyRate.value)}% reply rate` : "Too few sent for a rate"} to="/replies" tone={figures.newReplies ? "good" : "neutral"} />
        <Stat label="Interested" value={overview.interested} to="/replies" />
        <Stat label="Booked" value={overview.booked} to="/replies" />
        <Stat label="Won" value={overview.won} tone={overview.won ? "good" : "neutral"} to="/analytics" />
        <Stat label="Delivery failures" value={overview.deliveryFailures} tone={overview.deliveryFailures ? "bad" : "neutral"} to="/analytics" />
      </div>

      <section className="order-1 flex flex-col gap-3 md:order-none">
        <SectionTitle>What needs you today</SectionTitle>
        {attention.length === 0 ? (
          <Card className="flex items-center gap-3 px-4 py-4">
            <CircleCheck className="size-5 text-good" />
            <p className="text-sm text-muted">Nothing is waiting on you. Find more prospects when you are ready.</p>
          </Card>
        ) : (
          <Card as="div" className="divide-y divide-border">
            {attention.map((item) => (
              <Link
                key={item.key}
                to={item.to}
                search={item.search as never}
                className="group flex items-center gap-3 px-4 py-3.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-surface-2"
              >
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-full",
                    item.tone === "bad" ? "bg-bad/12 text-bad" : item.tone === "warn" ? "bg-warn/12 text-warn" : item.tone === "good" ? "bg-good/12 text-good" : "bg-info/12 text-info",
                  )}
                >
                  <item.icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{item.title}</span>
                  <span className="line-clamp-2 text-sm text-muted md:line-clamp-1">{item.detail}</span>
                </span>
                <span className="hidden shrink-0 text-sm text-muted group-hover:text-fg sm:inline">{item.cta}</span>
                <ArrowRight className="size-4 shrink-0 text-subtle group-hover:text-fg" />
              </Link>
            ))}
          </Card>
        )}
      </section>

      <section className="order-3 flex flex-col gap-3 md:order-none">
        <SectionTitle>Pipeline</SectionTitle>
        <Card className="grid grid-cols-5 divide-x divide-border">
          {[
            { label: "Emailed", value: new Set(state.emails.filter((email) => ["sent", "replied", "bounced"].includes(email.status)).map((email) => email.leadId)).size },
            { label: "Replied", value: overview.replies },
            { label: "Interested", value: overview.interested },
            { label: "Booked", value: overview.booked },
            { label: "Won", value: overview.won },
          ].map((step) => (
            <div key={step.label} className="px-2 py-3.5 text-center sm:px-4">
              <p className="font-display text-xl font-medium tabular sm:text-2xl">{step.value}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted sm:text-xs">{step.label}</p>
            </div>
          ))}
        </Card>
      </section>

      <div className="order-4 grid grid-cols-[minmax(0,1fr)] gap-6 md:order-none lg:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-3">
          <SectionTitle action={<Link to="/campaigns" className="text-xs text-muted hover:text-fg">All campaigns</Link>}>Active campaigns</SectionTitle>
          {activeCampaigns.length === 0 ? (
            <Card className="px-4 py-5 text-sm text-muted">No active campaigns. A run from Find creates one for you.</Card>
          ) : (
            activeCampaigns.map((campaign) => {
              const ids = new Set(members.filter((member) => member.campaignId === campaign.id).map((member) => member.leadId));
              const progress = campaignProgress(
                campaign,
                state.leads.filter((lead) => ids.has(lead.id)),
                state.emails.filter((email) => ids.has(email.leadId) || email.campaignId === campaign.id),
              );
              return (
                <Link key={campaign.id} to="/campaigns" className="block">
                  <Card className="px-4 py-3.5 transition-shadow hover:shadow-(--shadow-border-hover)">
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate font-medium">{campaign.name}</p>
                      <span className="shrink-0 text-xs text-muted tabular">{campaign.dailyTarget}/day</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {progress.found} prospects · {progress.emailsFound} emails · {progress.sent} sent · {progress.replies} replies
                    </p>
                    <ProgressBar className="mt-2.5" value={progress.found} max={progress.target} />
                  </Card>
                </Link>
              );
            })
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-3">
          <SectionTitle action={<Link to="/runs" className="text-xs text-muted hover:text-fg">Run history</Link>}>Recent runs</SectionTitle>
          {recent.length === 0 ? (
            <Card className="px-4 py-5 text-sm text-muted">No runs yet.</Card>
          ) : (
            recent.map((run) => {
              const funnel = parseFunnel(run.funnel);
              const headline = funnel ? funnelHeadline(funnel) : null;
              return (
                <Link key={run.id} to="/runs/$runId" params={{ runId: run.id }} className="block">
                  <Card className="px-4 py-3.5 transition-shadow hover:shadow-(--shadow-border-hover)">
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate font-medium">
                        {run.businessType || "Run"} · {run.location}
                      </p>
                      <Badge tone={run.status === "done" ? "good" : run.status === "running" ? "info" : run.status === "failed" ? "bad" : "neutral"}>
                        {run.status === "done" ? relativeTime(run.startedAt) : run.status}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted tabular">
                      {headline
                        ? `${headline[0]!.value} found → ${headline[2]!.value} new → ${headline[4]!.value} emails → ${headline[6]!.value} written`
                        : run.summary || `${run.found} found · ${run.prepared} prepared`}
                    </p>
                  </Card>
                </Link>
              );
            })
          )}
        </section>
      </div>
    </>
  );
}
