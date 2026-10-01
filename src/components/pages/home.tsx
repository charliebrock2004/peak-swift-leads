import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  FileText,
  Flame,
  Inbox,
  Mail,
  Phone,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/app/app-shell";
import { WithState } from "@/components/app/setup-gate";
import { sendQueue } from "@/components/app/send-queue";
import { Card, Notice, SectionTitle, Skeleton } from "@/components/app/ui";
import { useAppData } from "@/components/app/app-data";
import { plural } from "@/components/app/format";
import type { OutreachState } from "@/lib/outreach/server";
import { missingNames, whereRunning } from "@/lib/outreach/oauth-setup";
import { formatPence } from "@/lib/sales/pipeline";
import { getToday, salesAction } from "@/lib/sales/server";
import type { TodayPlan, TodayStep } from "@/lib/sales/today";
import { friendlyServerError } from "@/lib/server-errors";
import { cn } from "@/lib/utils";

/**
 * TODAY — the home screen. It answers one question: what should I do right
 * now? Blocking problems first (Gmail, failed sends), then the day in the
 * order a sale is won: replies, warm conversations, quotes, meetings, calls,
 * emails, and finally finding more prospects.
 */
export function HomePage() {
  return (
    <Page>
      <WithState>{(state) => <Today state={state} />}</WithState>
    </Page>
  );
}

type Blocker = { key: string; tone: "bad" | "warn"; title: string; detail: string; to: string; search?: Record<string, string>; cta: string };

function blockers(state: OutreachState): Blocker[] {
  const out: Blocker[] = [];
  const connection = state.connection;
  if (!connection.configured) {
    const setup = connection.setup;
    out.push({
      key: "oauth",
      tone: "bad",
      title: setup?.missing.length ? `${missingNames(setup)} not visible to this build` : "Gmail is not set up on this deployment",
      detail: setup?.missing.length ? `This is ${whereRunning(setup)}. If you added the variables after it was built, it needs a redeploy.` : "The Google client id and secret are missing, so nothing can be sent.",
      to: "/settings",
      search: { section: "gmail" },
      cta: "See why",
    });
  } else if (connection.status === "needs_attention") {
    out.push({ key: "gmail", tone: "bad", title: "Gmail needs reconnecting", detail: connection.lastError || "Nothing can be sent until it is reconnected.", to: "/settings", search: { section: "gmail" }, cta: "Reconnect" });
  } else if (connection.status !== "connected") {
    out.push({ key: "gmail", tone: "warn", title: "Connect Gmail to send", detail: "Emails go out from your own Gmail account.", to: "/settings", search: { section: "gmail" }, cta: "Connect" });
  }
  if (!state.onboardedAt && (!state.profileSaved || !state.profile.targetTrades.trim())) {
    out.push({ key: "profile", tone: "warn", title: "Tell PeakSwift what you sell", detail: "Seven quick questions — then it finds your first 20 prospects.", to: "/welcome", cta: "Start" });
  } else if (!state.profileSaved) {
    out.push({ key: "profile", tone: "warn", title: "Set up your business profile", detail: `Emails are signed "${state.profile.senderName} · ${state.profile.businessName}" until you do.`, to: "/settings", search: { section: "profile" }, cta: "Set up" });
  }
  const queue = sendQueue(state);
  const unfinished = state.emails.filter((email) => email.status === "sending").length;
  if (unfinished > 0) out.push({ key: "unfinished", tone: "warn", title: `${plural(unfinished, "send")} did not finish`, detail: "Opening Send checks each one against Gmail before anything is retried.", to: "/send", cta: "Check" });
  if (queue.failed.length > 0) out.push({ key: "failed", tone: "bad", title: `${plural(queue.failed.length, "email")} failed to send`, detail: "Gmail is checked first, so nothing is sent twice.", to: "/send", search: { view: "failed" }, cta: "Review" });
  if (queue.attention.length > 0) out.push({ key: "blocked", tone: "warn", title: `${plural(queue.attention.length, "draft")} blocked by the quality gate`, detail: "Each one says why.", to: "/send", search: { view: "attention" }, cta: "Fix" });
  return out;
}

const KIND_ICON: Record<TodayStep["kind"], typeof Mail> = {
  reply: Inbox,
  hot: Flame,
  quote: FileText,
  meeting: CalendarClock,
  call: Phone,
  task: Check,
  email: Mail,
  prospect: Search,
};

function stepLink(step: TodayStep): { to: string; params?: { leadId: string } } {
  return step.link.to === "/businesses/$leadId" && step.link.leadId ? { to: "/businesses/$leadId", params: { leadId: step.link.leadId } } : { to: step.link.to === "/businesses/$leadId" ? "/pipeline" : step.link.to };
}

function dueLabel(iso: string, now = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  const sameDay = at.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time === "10:00" || time === "11:00" ? "today" : `today ${time}`;
  return at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function Today({ state }: { state: OutreachState }) {
  const { prospecting } = useAppData();
  const navigate = useNavigate();
  const [plan, setPlan] = useState<TodayPlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const loading = useRef<Promise<void> | null>(null);
  const loadedAt = useRef(0);
  // Coming back to the tab and the state refreshing land together: one load answers both.
  const load = useCallback((force = false) => {
    if (loading.current) return loading.current;
    if (!force && Date.now() - loadedAt.current < 3000) return Promise.resolve();
    const task = (async () => {
      try {
        const reply = await getToday();
        if (!reply.ok) return setError(reply.error);
        setPlan(JSON.parse(reply.json) as TodayPlan);
        setError("");
      } catch (failure) {
        setError(friendlyServerError(failure));
      } finally {
        loadedAt.current = Date.now();
        loading.current = null;
      }
    })();
    loading.current = task;
    return task;
  }, []);

  // The account's data changed: reload the plan.
  useEffect(() => {
    void load(true);
  }, [load, state, prospecting.run.status]);
  // Back in the tab: tasks and replies may have moved on elsewhere.
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const done = async (step: TodayStep) => {
    setBusy(step.key);
    const reply = await salesAction({ data: { action: "task_status", taskId: step.taskId, status: "done" } }).catch((failure: unknown) => ({ ok: false as const, error: friendlyServerError(failure) }));
    setBusy("");
    if (!reply.ok) return void toast(reply.error);
    toast("Done.");
    void load(true);
  };

  const now = new Date();
  const fixes = blockers(state);
  const first = plan?.steps[0];

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium tracking-widest text-subtle uppercase">{now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</p>
        <h1 className="font-display text-[1.9rem] leading-tight font-medium tracking-tight md:text-[2.25rem]">Today</h1>
        <p className="text-sm text-muted">What to do right now, in the order that wins work.</p>
      </header>

      {fixes.length > 0 ? (
        <Card as="div" className="divide-y divide-border">
          {fixes.map((item) => (
            <Link key={item.key} to={item.to} search={item.search as never} className="group flex items-center gap-3 px-4 py-3 first:rounded-t-xl last:rounded-b-xl hover:bg-surface-2">
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", item.tone === "bad" ? "bg-bad/12 text-bad" : "bg-warn/12 text-warn")}>
                {item.key === "profile" ? <UserRound className="size-4" /> : item.key === "unfinished" ? <RotateCcw className="size-4" /> : <AlertTriangle className="size-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{item.title}</span>
                <span className="line-clamp-2 text-sm text-muted md:line-clamp-1">{item.detail}</span>
              </span>
              <span className="hidden shrink-0 text-sm text-muted group-hover:text-fg sm:inline">{item.cta}</span>
              <ArrowRight className="size-4 shrink-0 text-subtle" />
            </Link>
          ))}
        </Card>
      ) : null}

      {error ? <Notice tone="bad" title="Could not load today">{error}</Notice> : null}

      {!plan ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            <Count value={plan.counts.replies} label={plan.counts.replies === 1 ? "reply needs you" : "replies need you"} to="/replies" tone={plan.counts.replies ? "good" : undefined} />
            <Count value={plan.counts.calls} label={plan.counts.calls === 1 ? "call worth making" : "calls worth making"} to="/calls" />
            <Count value={plan.counts.emailsReady} label="emails to review" to="/send" />
            <Count value={plan.counts.followUps} label="follow-ups due" to="/send" className="hidden sm:flex" />
            <Count value={plan.counts.quotes} label="quotes to chase" to="/pipeline" className="hidden sm:flex" />
          </div>

          <Link to="/pipeline" className="-mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 px-1 text-sm text-muted hover:text-fg">
            <span>
              Pipeline: <span className="font-medium text-fg tabular">{formatPence(plan.pipeline.quotedPence) || "£0"}</span> quoted
            </span>
            <span>
              <span className="font-medium text-fg tabular">{formatPence(plan.pipeline.wonThisMonthPence) || "£0"}</span> won this month
            </span>
            <span>{plural(plan.pipeline.openCount, "sale")} in play</span>
          </Link>

          <section className="flex flex-col gap-3">
            <SectionTitle>Start my day</SectionTitle>
            {first ? (
              <Button className="h-12 w-full text-[15px] sm:w-auto sm:self-start" onClick={() => void navigate(stepLink(first) as never)}>
                <Play />
                Start: {first.title}
              </Button>
            ) : null}
            <Card as="div" className="divide-y divide-border">
              {plan.steps.map((step, index) => {
                const Icon = KIND_ICON[step.kind];
                return (
                  <div key={step.key} className="flex items-center gap-3 px-4 py-3">
                    <span className="w-4 shrink-0 text-right text-xs text-subtle tabular">{index + 1}</span>
                    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", step.kind === "reply" || step.kind === "hot" ? "bg-good/12 text-good" : step.overdue ? "bg-warn/12 text-warn" : "bg-surface-2 text-muted")}>
                      <Icon className="size-4" />
                    </span>
                    <Link {...(stepLink(step) as { to: string })} className="group min-w-0 flex-1">
                      <span className="block text-sm font-medium group-hover:underline">{step.title}</span>
                      <span className="line-clamp-2 text-sm text-muted">
                        {step.overdue ? <span className="text-warn">Overdue · </span> : step.dueAt && step.kind !== "reply" ? <span>{dueLabel(step.dueAt, now)} · </span> : null}
                        {step.detail}
                      </span>
                    </Link>
                    {step.taskId ? (
                      <Button variant="ghost" size="sm" disabled={busy === step.key} onClick={() => void done(step)} aria-label={`Mark "${step.title}" done`}>
                        <Check />
                        <span className="hidden sm:inline">Done</span>
                      </Button>
                    ) : (
                      <ArrowRight className="size-4 shrink-0 text-subtle" />
                    )}
                  </div>
                );
              })}
            </Card>
          </section>

          {prospecting.running ? (
            <Link to="/find" className="flex items-center gap-2 text-sm text-muted hover:text-fg">
              <Sparkles className="size-4 animate-pulse" /> A Find run is going: {prospecting.run.detail || "working…"}
            </Link>
          ) : null}
        </>
      )}
    </>
  );
}

function Count({ value, label, to, tone, className }: { value: number; label: string; to: string; tone?: "good"; className?: string }) {
  return (
    <Link to={to} className={cn("flex flex-col rounded-xl bg-surface px-3 py-3 shadow-(--shadow-border) transition-shadow hover:shadow-(--shadow-border-hover)", className)}>
      <span className={cn("font-display text-2xl font-medium tabular", tone === "good" && value ? "text-good" : value ? "" : "text-subtle")}>{value}</span>
      <span className="mt-0.5 text-xs leading-snug text-muted">{label}</span>
    </Link>
  );
}
