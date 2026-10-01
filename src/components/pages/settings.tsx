import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Activity,
  CheckCircle2,
  CircleDashed,
  FlaskConical,
  Link2,
  Loader2,
  LogOut,
  Send,
  TriangleAlert,
  Unlink,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Page } from "@/components/app/app-shell";

import { WithState } from "@/components/app/setup-gate";
import { Badge, Card, Field, PageHeader, Segmented } from "@/components/app/ui";
import { EmailDiscoveryTest, ValidationBatch } from "@/components/outreach/email-discovery-test";
import { signOut } from "@/lib/auth/client";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { OAUTH_STATE_KEY } from "@/lib/outreach/oauth-state";
import { fromName, profileSignature, type BusinessProfile } from "@/lib/outreach/profile";
import {
  checkGmailHealth,
  disconnectGmail,
  runPipelineTest,
  saveBusinessProfile,
  saveOutreachSettings,
  saveOutreachTemplate,
  sendTestEmail,
  startGmailConnect,
  unsubscribeLead,
  type HealthCheck,
  type OutreachState,
} from "@/lib/outreach/server";
import { TEMPLATE_VARIABLES } from "@/lib/outreach/templates";
import type { OutreachSettings, OutreachTemplate } from "@/lib/outreach/types";
import { friendlyServerError } from "@/lib/server-errors";
import { cn } from "@/lib/utils";
import { useAppData } from "@/components/app/app-data";
import { relativeTime } from "@/components/app/format";
import { missingAdvice, missingNames, whereRunning } from "@/lib/outreach/oauth-setup";
import { senderAdvice } from "@/lib/outreach/sender-advice";

const SECTIONS = [
  { id: "gmail", label: "Gmail" },
  { id: "profile", label: "Business" },
  { id: "sending", label: "Sending" },
  { id: "follow-ups", label: "Follow-ups" },
  { id: "ai", label: "AI" },
  { id: "discovery", label: "Discovery" },
  { id: "templates", label: "Templates" },
  { id: "compliance", label: "Compliance" },
  { id: "account", label: "Account" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

export function SettingsPage() {
  return (
    <Page wide>
      <WithState>{(state) => <Settings state={state} />}</WithState>
    </Page>
  );
}

function Settings({ state }: { state: OutreachState }) {
  const search = useSearch({ from: "/_app/settings" });
  const navigate = useNavigate();
  const section: Section = (SECTIONS.some((item) => item.id === search.section) ? search.section : "gmail") as Section;
  const go = (next: Section) => void navigate({ to: "/settings", search: { section: next }, replace: true });
  return (
    <>
      <PageHeader eyebrow="Settings" title="Settings" />
      <div className="flex flex-col gap-6 md:flex-row">
        <nav className="hidden w-44 shrink-0 flex-col gap-0.5 md:flex" aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => go(item.id)}
              className={cn(
                "h-9 rounded-md px-3 text-left text-sm",
                section === item.id ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface hover:text-fg",
              )}
              aria-current={section === item.id ? "page" : undefined}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <Segmented className="md:hidden" label="Settings sections" value={section} onChange={go} options={SECTIONS} />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {section === "gmail" ? <GmailSection state={state} /> : null}
          {section === "profile" ? <ProfileSection state={state} /> : null}
          {section === "sending" ? <SendingSection state={state} /> : null}
          {section === "follow-ups" ? <FollowUpSection state={state} /> : null}
          {section === "ai" ? <AiSection state={state} /> : null}
          {section === "discovery" ? <DiscoverySection state={state} /> : null}
          {section === "templates" ? <TemplatesSection state={state} /> : null}
          {section === "compliance" ? <ComplianceSection state={state} /> : null}
          {section === "account" ? <AccountSection /> : null}
        </div>
      </div>
    </>
  );
}

function Panel({ title, description, children, action }: { title: string; description?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-medium">{title}</h2>
          {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </Card>
  );
}

function useSaveSettings() {
  const { reload } = useAppData();
  const [saving, setSaving] = useState(false);
  const save = async (patch: Partial<OutreachSettings>, message = "Saved.") => {
    setSaving(true);
    try {
      const result = await saveOutreachSettings({ data: patch });
      if (!result.ok) toast(result.error);
      else toast(message);
      await reload();
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setSaving(false);
    }
  };
  return { save, saving };
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

function HealthIcon({ level }: { level: HealthCheck["level"] }) {
  if (level === "ok") return <CheckCircle2 className="size-4 shrink-0 text-good" />;
  if (level === "warn") return <TriangleAlert className="size-4 shrink-0 text-warn" />;
  if (level === "fail") return <XCircle className="size-4 shrink-0 text-bad" />;
  return <CircleDashed className="size-4 shrink-0 text-subtle" />;
}

function GmailSection({ state }: { state: OutreachState }) {
  const { reload } = useAppData();
  const { save } = useSaveSettings();
  const connection = state.connection;
  const [busy, setBusy] = useState("");
  const [health, setHealth] = useState<{ checks: HealthCheck[]; healthy: boolean; checkedAt: string } | null>(() => {
    try {
      return connection.lastHealth ? (JSON.parse(connection.lastHealth) as { checks: HealthCheck[]; healthy: boolean; checkedAt: string }) : null;
    } catch {
      return null;
    }
  });
  const [testTo, setTestTo] = useState("");
  const [testAddress, setTestAddress] = useState(state.settings.testRecipient ?? "");
  const [pipeline, setPipeline] = useState<{ passed: boolean; steps: { step: string; ok: boolean; detail: string }[] } | null>(null);

  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    try {
      await task();
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setBusy("");
    }
  };

  const connect = (resumed = false) =>
    run("connect", async () => {
      const started = await startGmailConnect({ data: { origin: window.location.origin } });
      if (!started.ok) {
        toast(started.error);
        return;
      }
      if ("switchTo" in started) {
        // Google will send the browser back to one fixed address, so the flow
        // has to start there. Never bounce twice: that would mean the server and
        // this tab disagree about where "there" is.
        if (resumed) {
          toast(`Could not continue on ${new URL(started.switchTo).host}. Open that address and press Connect Gmail there.`);
          return;
        }
        toast(`Continuing on ${new URL(started.switchTo).host}, the address Google returns to…`);
        window.location.href = started.switchTo;
        return;
      }
      try {
        window.sessionStorage.setItem(OAUTH_STATE_KEY, started.state);
      } catch {
        toast("This browser is blocking session storage, which the Google sign-in needs.");
        return;
      }
      window.location.href = started.url;
    });

  const callback = connection.redirectUriOverride || (typeof window === "undefined" ? "" : `${window.location.origin}/oauth/gmail`);

  // Arriving here from Connect Gmail on another address of this deployment:
  // carry on with the flow once, then drop the flag so a reload does not repeat it.
  const search = useSearch({ from: "/_app/settings" });
  const navigate = useNavigate();
  const resumed = useRef(false);
  useEffect(() => {
    if (search.connect !== "1" || resumed.current) return;
    resumed.current = true;
    void navigate({ to: "/settings", search: { section: "gmail" }, replace: true });
    if (connection.configured) void connect(true);
    // Once per arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.connect]);

  return (
    <>
      <Panel
        title="Gmail"
        description="Emails are sent from your own Gmail account through Google's API. Tokens never reach the browser and are encrypted where they are stored."
        action={
          <Badge tone={connection.status === "connected" ? "good" : connection.status === "needs_attention" ? "bad" : "neutral"}>
            {connection.status === "connected" ? "Connected" : connection.status === "needs_attention" ? "Needs attention" : "Not connected"}
          </Badge>
        }
      >
        {!connection.configured ? (
          <div className="rounded-lg bg-warn/10 px-4 py-3 text-sm">
            <p className="font-medium text-warn">
              {connection.setup?.missing.length
                ? `${missingNames(connection.setup)} ${connection.setup.missing.length > 1 ? "are" : "is"} not visible to this build`
                : "Google sign-in is not set up on this deployment"}
            </p>
            {connection.setup?.missing.length ? <p className="mt-1.5 text-muted">{missingAdvice(connection.setup)}</p> : null}
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
              <li>In Google Cloud, create an OAuth client (Web application) and enable the Gmail API.</li>
              <li>
                Add this exact redirect URI: <code className="text-fg">{callback}</code>
              </li>
              <li>
                Set <code className="text-fg">GOOGLE_CLIENT_ID</code> and <code className="text-fg">GOOGLE_CLIENT_SECRET</code> in the deployment's
                environment variables and redeploy.
              </li>
            </ol>
          </div>
        ) : null}
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Account</dt>
            <dd className="mt-0.5 truncate font-medium">{connection.email || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Last successful send</dt>
            <dd className="mt-0.5">{connection.lastSendAt ? relativeTime(connection.lastSendAt) : "Never"}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Connected</dt>
            <dd className="mt-0.5">{connection.connectedAt ? new Date(connection.connectedAt).toLocaleDateString("en-GB") : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Sent today</dt>
            <dd className="mt-0.5 tabular">
              {state.allowance.sent} of {state.allowance.limit}
            </dd>
          </div>
        </dl>
        {connection.lastError ? <p className="rounded-md bg-bad/10 px-3 py-2 text-sm text-bad">{connection.lastError}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button disabled={Boolean(busy) || !connection.configured} onClick={() => void connect()}>
            {busy === "connect" ? <Loader2 className="animate-spin" /> : <Link2 />}
            {connection.status === "disconnected" ? "Connect Gmail" : "Reconnect"}
          </Button>
          <Button
            variant="secondary"
            disabled={Boolean(busy) || connection.status === "disconnected"}
            onClick={() =>
              void run("health", async () => {
                const result = await checkGmailHealth();
                if (result.ok) setHealth(result);
                await reload();
              })
            }
          >
            {busy === "health" ? <Loader2 className="animate-spin" /> : <Activity />}
            Check connection
          </Button>
          <Button
            variant="ghost"
            disabled={Boolean(busy) || connection.status === "disconnected"}
            onClick={() => {
              if (!window.confirm("Disconnect Gmail? Nothing can be sent until you connect again.")) return;
              void run("disconnect", async () => {
                await disconnectGmail();
                await reload();
                toast("Disconnected.");
              });
            }}
          >
            <Unlink />
            Disconnect
          </Button>
        </div>
        {connection.status === "connected" && senderAdvice(connection.email).kind === "consumer" ? (
          <p className="rounded-lg bg-warn/10 px-3.5 py-2.5 text-sm text-muted">{senderAdvice(connection.email).advice}</p>
        ) : null}
        {connection.intendedSender && connection.status !== "connected" ? (
          <p className="text-xs text-subtle">
            Connect <span className="text-muted">{connection.intendedSender}</span> — Google will offer that account, and any other is refused.
          </p>
        ) : null}
        {connection.setup?.environment ? (
          <p className="text-xs text-subtle">
            You are on {whereRunning(connection.setup)}.
            {` Connect Gmail sends Google exactly ${callback}`}
            {typeof window !== "undefined" && callback && !callback.startsWith(`${window.location.origin}/`) ? `, and continues on ${new URL(callback).host} first.` : "."}
          </p>
        ) : null}
        {connection.configured && connection.clientMasked ? (
          <p className="text-xs text-subtle">
            OAuth client <code className="text-muted">{connection.clientMasked}</code>
            {connection.clientProject ? ` (Google Cloud project ${connection.clientProject})` : ""} · redirect URI{" "}
            <code className="text-muted">{callback}</code>. Both must match Google Cloud exactly.
          </p>
        ) : null}
      </Panel>

      {health ? (
        <Panel
          title={health.healthy ? "Connection healthy" : "Connection problems"}
          description={`Checked ${relativeTime(health.checkedAt)}. The check refreshes the token and reads the mailbox profile — it never sends.`}
        >
          <ul className="flex flex-col divide-y divide-border">
            {health.checks.map((check) => (
              <li key={check.id} className="flex items-start gap-3 py-2.5">
                <HealthIcon level={check.level} />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{check.label}</p>
                  <p className="text-sm text-muted">{check.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="Send a test email" description="Proves the path from here to an inbox. No prospect is contacted.">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={testTo} onChange={(event) => setTestTo(event.target.value)} placeholder={connection.email || "you@example.com"} inputMode="email" aria-label="Test recipient" />
          <Button
            variant="secondary"
            className="shrink-0"
            disabled={Boolean(busy) || connection.status !== "connected"}
            onClick={() =>
              void run("test", async () => {
                const result = await sendTestEmail({ data: { to: testTo.trim() } });
                toast(result.ok ? `Sent to ${result.to} — Gmail message ${result.messageId}.` : result.error);
                await reload();
              })
            }
          >
            {busy === "test" ? <Loader2 className="animate-spin" /> : <Send />}
            Send test
          </Button>
        </div>
      </Panel>

      <Panel
        title="End-to-end test"
        description="Runs the real pipeline once — a test prospect, the real email writer, the quality gate, approval, Gmail, and Gmail confirming it is in Sent — to your own test address. It can never email a real prospect."
      >
        <Field label="Test address" hint="Only this address (or your connected Gmail account) can receive the end-to-end test.">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={testAddress} onChange={(event) => setTestAddress(event.target.value)} placeholder={connection.email || "you@example.com"} inputMode="email" />
            <Button variant="secondary" className="shrink-0" onClick={() => void save({ testRecipient: testAddress.trim() }, "Test address saved.")}>
              Save
            </Button>
          </div>
        </Field>
        <Button
          className="self-start"
          disabled={Boolean(busy) || connection.status !== "connected"}
          onClick={() =>
            void run("pipeline", async () => {
              const result = await runPipelineTest({ data: { to: testAddress.trim() } });
              if (!result.ok) {
                toast(result.error);
                return;
              }
              setPipeline({ passed: result.passed, steps: result.steps });
              await reload();
            })
          }
        >
          {busy === "pipeline" ? <Loader2 className="animate-spin" /> : <FlaskConical />}
          Run end-to-end test
        </Button>
        {pipeline ? (
          <ol className="flex flex-col divide-y divide-border rounded-lg shadow-(--shadow-border)">
            {pipeline.steps.map((step, index) => (
              <li key={step.step} className="flex items-start gap-3 px-3 py-2.5">
                {step.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-bad" />}
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {index + 1}. {step.step}
                  </p>
                  <p className="text-sm break-words text-muted">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </Panel>
    </>
  );
}

// ── Business profile ──────────────────────────────────────────────────────────

const PROFILE_FIELDS: { key: keyof BusinessProfile; label: string; hint?: string; multiline?: boolean; wide?: boolean; placeholder?: string }[] = [
  { key: "businessName", label: "Business name", placeholder: "Peak Swift Studio" },
  { key: "senderName", label: "Your name", hint: "How you sign off. First name is enough.", placeholder: "Charlie" },
  { key: "senderEmail", label: "Sending email", hint: "The Gmail you expect to send from — the health check compares it.", placeholder: "you@gmail.com" },
  { key: "website", label: "Your website", placeholder: "peakswift.studio" },
  { key: "portfolioUrl", label: "Portfolio link", hint: "Optional. The AI may link it once." },
  { key: "location", label: "Based in", placeholder: "Perth" },
  { key: "areasServed", label: "Areas you work in", placeholder: "Perthshire, Stirling and Fife" },
  { key: "services", label: "What you offer", multiline: true, hint: "In your own words — given to the AI as-is." },
  { key: "tone", label: "Tone", hint: "How the emails should sound." },
  { key: "cta", label: "Call to action", hint: "The low-pressure next step every email ends on." },
  { key: "signature", label: "Signature", multiline: true, hint: "Leave empty for your name, business and website." },
  { key: "optOutLine", label: "Opt-out sentence", wide: true, hint: "Must give people a way to stop hearing from you, or the standard one is used." },
  { key: "businessAddress", label: "Business address", wide: true, hint: "Optional. For your records and your signature if you add it there." },
];

/** Who you sell to: what Find searches, how prospects are scored, which channels you use. */
const ICP_FIELDS: typeof PROFILE_FIELDS = [
  { key: "targetAreas", label: "Where you look for work", hint: "Towns or regions, comma-separated. Find starts here.", placeholder: "Perth, Crieff, Pitlochry" },
  { key: "targetTrades", label: "Businesses you want", hint: "Trades Find searches by default.", placeholder: "Joiner, Roofer, Builder" },
  { key: "preferredTrades", label: "Best-fit trades", hint: "Scored as high value.", placeholder: "Roofer, Kitchen fitter" },
  { key: "excludedTrades", label: "Never these", hint: "Scored out and never queued.", placeholder: "Takeaway, Pub" },
  { key: "typicalProject", label: "Typical job (£)", hint: "Compared with your won jobs in Insights.", placeholder: "2500" },
  { key: "minimumProject", label: "Smallest job you take (£)", hint: "Trades that rarely spend this much score lower.", placeholder: "1000" },
  { key: "examples", label: "Past work you can mention", multiline: true, hint: "One per line. The AI may mention one, exactly as written.", placeholder: "Booking site for a Perth roofer — enquiries up in the first month" },
];

function ProfileSection({ state }: { state: OutreachState }) {
  const { reload } = useAppData();
  const [profile, setProfile] = useState<BusinessProfile>(state.profile);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const save = async () => {
    setSaving(true);
    try {
      const result = await saveBusinessProfile({ data: profile });
      if (!result.ok) {
        toast(result.error);
        return;
      }
      setProblems(Object.fromEntries(result.problems.map((problem) => [problem.field, problem.message])));
      setProfile(result.profile);
      toast(result.problems.length ? "Saved — check the highlighted fields." : "Profile saved. New emails use it straight away.");
      await reload();
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel
      title="Business profile"
      description="Who the emails come from and what you offer. The AI, the templates, the sign-off and the From name all use it, and the quality gate checks each email names your business."
    >
      {[PROFILE_FIELDS, ICP_FIELDS].map((fields, index) => (
        <div key={index} className="flex flex-col gap-3">
          {index === 1 ? (
            <div>
              <p className="text-sm font-medium">Who you sell to</p>
              <p className="text-xs text-muted">Find, scoring, Today and Insights all read this.</p>
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <div key={field.key} className={field.multiline || field.wide ? "sm:col-span-2" : ""}>
                <Field label={field.label} hint={problems[field.key] ? <span className="text-warn">{problems[field.key]}</span> : field.hint} htmlFor={`p-${field.key}`}>
                  {field.multiline ? (
                    <textarea
                      id={`p-${field.key}`}
                      value={profile[field.key]}
                      rows={3}
                      onChange={(event) => setProfile({ ...profile, [field.key]: event.target.value })}
                      placeholder={field.placeholder}
                      className="w-full rounded-md bg-surface px-3 py-2 text-sm shadow-(--shadow-border) outline-none focus-visible:shadow-(--shadow-focus)"
                    />
                  ) : (
                    <Input id={`p-${field.key}`} value={profile[field.key]} placeholder={field.placeholder} onChange={(event) => setProfile({ ...profile, [field.key]: event.target.value })} />
                  )}
                </Field>
              </div>
            ))}
            {index === 1 ? (
              <div className="sm:col-span-2">
                <Field label="How you make first contact" hint="A channel you don't use is never suggested. Callbacks people ask for are always kept." htmlFor="p-contactMethods">
                  <Segmented
                    label="How you make first contact"
                    value={(profile.contactMethods || "both") as "email" | "phone" | "both"}
                    onChange={(value) => setProfile({ ...profile, contactMethods: value })}
                    options={[
                      { id: "both", label: "Email and phone" },
                      { id: "email", label: "Email only" },
                      { id: "phone", label: "Phone only" },
                    ]}
                  />
                </Field>
              </div>
            ) : null}
          </div>
        </div>
      ))}
      <div className="rounded-lg bg-surface-2 px-4 py-3 text-sm">
        <p className="text-xs text-subtle">Emails arrive as</p>
        <p className="mt-0.5 font-medium">
          {fromName(profile)} &lt;{state.connection.email || profile.senderEmail || "your Gmail"}&gt;
        </p>
        <p className="mt-2 text-xs text-subtle">Signed</p>
        <p className="email-preview mt-0.5 text-muted">{profileSignature(profile)}</p>
      </div>
      <Button className="self-start" disabled={saving} onClick={() => void save()}>
        {saving ? <Loader2 className="animate-spin" /> : null}
        Save profile
      </Button>
    </Panel>
  );
}

// ── Sending, follow-ups, AI, discovery ───────────────────────────────────────

function NumberInput({ label, value, min, max, onChange, hint }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <Input type="number" min={min} max={max} value={value} onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value) || 0)))} className="tabular" />
    </Field>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (value: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-subtle">{hint}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-surface-2 shadow-(--shadow-border)")}
      >
        <span className={cn("absolute top-0.5 size-5 rounded-full transition-transform", checked ? "left-0.5 translate-x-5 bg-accent-fg" : "left-0.5 bg-muted")} />
      </button>
    </label>
  );
}

function SendingSection({ state }: { state: OutreachState }) {
  const { save, saving } = useSaveSettings();
  const [settings, setSettings] = useState(state.settings);
  return (
    <Panel title="Sending" description="The daily limit is counted from what Gmail actually accepted today, so it cannot drift. Each campaign also has its own daily limit; the smaller wins.">
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberInput label="Daily limit (all campaigns)" value={settings.dailyLimit} min={0} max={30} hint="Up to 30 a day." onChange={(dailyLimit) => setSettings({ ...settings, dailyLimit })} />
        <NumberInput
          label="Pause between emails (seconds)"
          value={settings.delaySeconds}
          min={5}
          max={600}
          hint="Spacing emails out keeps sending human-paced."
          onChange={(delaySeconds) => setSettings({ ...settings, delaySeconds })}
        />
      </div>
      <Toggle
        label="Include low-opportunity prospects"
        hint="Off by default: a business with little website problem to write about is usually a wasted email."
        checked={settings.includeLow}
        onChange={(includeLow) => setSettings({ ...settings, includeLow })}
      />
      <Toggle
        label="Treat “Ltd” in a business name as a company until checked"
        hint="Only a registered company may use Ltd, Limited, PLC or LLP, so it is reasonable evidence — but weaker than the register. Off holds every business until Companies House confirms it. Not legal advice: see the ICO's B2B marketing guidance."
        checked={settings.contactRules?.trustCompanySuffix ?? true}
        onChange={(trustCompanySuffix) =>
          setSettings({ ...settings, contactRules: { companyStatusMaxAgeDays: 180, ...settings.contactRules, trustCompanySuffix } })
        }
      />
      <Button className="self-start" disabled={saving} onClick={() => void save(settings)}>
        Save
      </Button>
    </Panel>
  );
}

function FollowUpSection({ state }: { state: OutreachState }) {
  const { save, saving } = useSaveSettings();
  const [settings, setSettings] = useState(state.settings);
  const second = settings.followUp1Days + settings.followUp2Days;
  return (
    <Panel
      title="Follow-ups"
      description="A short, polite follow-up if nobody replies. You still read and send each one — nothing goes out on its own."
    >
      <Toggle label="Suggest follow-ups" checked={settings.followUpsOn} onChange={(followUpsOn) => setSettings({ ...settings, followUpsOn })} />
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberInput label="First, days after the email" value={settings.followUp1Days} min={1} max={60} onChange={(followUp1Days) => setSettings({ ...settings, followUp1Days })} />
        <NumberInput label="Final, days after the first" value={settings.followUp2Days} min={1} max={90} onChange={(followUp2Days) => setSettings({ ...settings, followUp2Days })} />
        <NumberInput label="Most follow-ups" value={settings.maxFollowUps} min={0} max={2} onChange={(maxFollowUps) => setSettings({ ...settings, maxFollowUps })} />
      </div>
      <p className="text-sm text-muted tabular">
        Schedule: day 0 — first email
        {settings.maxFollowUps >= 1 ? ` · day ${settings.followUp1Days} — follow-up` : ""}
        {settings.maxFollowUps >= 2 ? ` · day ${second} — final follow-up` : ""}.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
        <li>Never after a reply, an unsubscribe or a bounce.</li>
        <li>Never once they are interested, booked, won or said no — by email or on the phone.</li>
        <li>Never more than the number above, and always within your daily limits.</li>
      </ul>
      <Button className="self-start" disabled={saving} onClick={() => void save(settings)}>
        Save
      </Button>
    </Panel>
  );
}

function AiSection({ state }: { state: OutreachState }) {
  const { save, saving } = useSaveSettings();
  const [mode, setMode] = useState(state.settings.defaultMode || "ai");
  const [budget, setBudget] = useState(state.settings.aiDailyBudget ?? 150);
  return (
    <Panel
      title="AI writing"
      description="The AI is only given facts that were actually found, and every draft passes the quality gate — anything invented, flattering or unsupported is thrown away and a template used instead."
      action={<Badge tone={state.aiAvailable ? "good" : "warn"}>{state.aiAvailable ? "Configured" : "Not configured"}</Badge>}
    >
      {!state.aiAvailable ? (
        <p className="text-sm text-muted">
          Set <code className="text-fg">XAI_API_KEY</code> on the deployment to have emails written from each prospect's evidence. Until then, templates are
          used and every draft says so.
        </p>
      ) : null}
      <Field label="Write emails with">
        <div className="flex flex-wrap gap-1.5">
          {[{ id: "ai", label: "AI, from the evidence" }, ...state.templates.filter((template) => !template.kind.startsWith("follow")).map((template) => ({ id: template.id, label: `Template: ${template.name}` }))].map(
            (option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setMode(option.id)}
                className={cn("h-9 rounded-full px-3.5 text-sm", mode === option.id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg")}
              >
                {option.label}
              </button>
            ),
          )}
        </div>
      </Field>
      <NumberInput label="AI drafts per day" value={budget} min={0} max={1000} hint={`${state.usage.ai} used today. Past this, templates are used.`} onChange={setBudget} />
      <Button className="self-start" disabled={saving} onClick={() => void save({ defaultMode: mode, aiDailyBudget: budget })}>
        Save
      </Button>
    </Panel>
  );
}

function DiscoverySection({ state }: { state: OutreachState }) {
  const { save, saving } = useSaveSettings();
  const [budget, setBudget] = useState(state.settings.searchDailyBudget ?? 300);
  const [tool, setTool] = useState<"" | "one" | "batch">("");
  return (
    <>
      <Panel
        title="Discovery"
        description="Businesses come from Companies House and OpenStreetMap. Websites are only attached when a page carries the business's own details, and emails only when they are published — never guessed."
        action={<Badge tone={state.searchProvider ? "good" : "warn"}>{state.searchProvider ? `Search: ${state.searchProvider}` : "No search key"}</Badge>}
      >
        {!state.searchProvider ? (
          <p className="text-sm text-muted">
            Without a web-search key, websites can only come from listings and domain checks, so many businesses show "no website" that do have one. Set{" "}
            <code className="text-fg">TAVILY_API_KEY</code> (or <code className="text-fg">BRAVE_SEARCH_API_KEY</code>) on the deployment.
          </p>
        ) : null}
        <NumberInput
          label="Web searches per day"
          value={budget}
          min={0}
          max={2000}
          hint={`${state.usage.search} used today. Each costs one search credit; a business without a listed website uses up to six.`}
          onChange={setBudget}
        />
        <Button className="self-start" disabled={saving} onClick={() => void save({ searchDailyBudget: budget })}>
          Save
        </Button>
      </Panel>
      <Panel title="Diagnostics" description="Look up one business, or check a batch against what you know is right.">
        <Segmented
          label="Tool"
          value={tool}
          onChange={setTool}
          options={[
            { id: "one", label: "Test one business" },
            { id: "batch", label: "Validation batch" },
          ]}
        />
        {tool === "one" ? <EmailDiscoveryTest /> : null}
        {tool === "batch" ? <ValidationBatch /> : null}
      </Panel>
    </>
  );
}

function TemplatesSection({ state }: { state: OutreachState }) {
  const { reload } = useAppData();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel
      title="Templates"
      description={
        <>
          Used when AI is off, out of budget, or its draft fails the quality gate. Variables:{" "}
          {TEMPLATE_VARIABLES.map((variable) => (
            <code key={variable} className="mr-1 text-xs text-fg">{`{{${variable}}}`}</code>
          ))}
        </>
      }
    >
      <div className="flex flex-col divide-y divide-border rounded-lg shadow-(--shadow-border)">
        {state.templates.map((template) => (
          <TemplateEditor
            key={template.id}
            template={template}
            open={open === template.id}
            onToggle={() => setOpen(open === template.id ? null : template.id)}
            onSaved={reload}
          />
        ))}
      </div>
    </Panel>
  );
}

function TemplateEditor({ template, open, onToggle, onSaved }: { template: OutreachTemplate; open: boolean; onToggle: () => void; onSaved: () => Promise<void> }) {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [signature, setSignature] = useState(template.signature);
  const [saving, setSaving] = useState(false);
  return (
    <div>
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between px-4 py-3 text-left">
        <span className="text-sm font-medium">{template.name}</span>
        <span className="text-xs text-subtle">{open ? "Close" : "Edit"}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-2 px-4 pb-4">
          <Input value={subject} onChange={(event) => setSubject(event.target.value)} aria-label="Subject" />
          <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={12} aria-label="Body" className="email-preview w-full rounded-md bg-surface p-3 shadow-(--shadow-border) outline-none" />
          <textarea value={signature} onChange={(event) => setSignature(event.target.value)} rows={3} aria-label="Signature" className="email-preview w-full rounded-md bg-surface p-3 shadow-(--shadow-border) outline-none" />
          <Button
            size="sm"
            className="self-start"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              const result = await saveOutreachTemplate({ data: { ...template, subject, body, signature } }).catch((error: unknown) => ({ ok: false as const, error: friendlyServerError(error) }));
              toast(result.ok ? "Template saved." : result.error);
              await onSaved();
              setSaving(false);
            }}
          >
            Save template
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ComplianceSection({ state }: { state: OutreachState }) {
  const { reload } = useAppData();
  const [address, setAddress] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <>
      <Panel title="How Peak Swift keeps outreach clean" description="These rules are enforced on the server, checked again the moment before Gmail, and several by the database itself.">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
          <li>Only emails a business published — on its own site, structured data or a listing that is provably theirs. Never guessed.</li>
          <li>Every email names the business and your studio, says how to opt out, and contains no claim the evidence doesn't support.</li>
          <li>Sole traders and personal mailboxes are held for you to look at: UK rules treat them like individuals.</li>
          <li>One first email per address, ever — a database constraint, across every campaign.</li>
          <li>Anyone who asks to stop, or whose address bounces, is suppressed permanently — even if they are imported again.</li>
          <li>Nothing is sent without you pressing Send, and replies are never answered automatically.</li>
        </ul>
      </Panel>
      <Panel title={`Suppression list (${state.suppression.length})`} description="Addresses that will never be emailed again.">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="name@business.co.uk" inputMode="email" aria-label="Address to suppress" />
          <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason (optional)" aria-label="Reason" />
          <Button
            variant="secondary"
            className="shrink-0"
            disabled={saving || !address.includes("@")}
            onClick={async () => {
              setSaving(true);
              const result = await unsubscribeLead({ data: { email: address.trim(), reason: reason.trim() || "Added by hand" } }).catch((error: unknown) => ({
                ok: false as const,
                error: friendlyServerError(error),
              }));
              toast(result.ok ? `${address.trim()} will never be emailed.` : result.error);
              setAddress("");
              setReason("");
              await reload();
              setSaving(false);
            }}
          >
            Suppress
          </Button>
        </div>
        {state.suppression.length ? (
          <ul className="flex max-h-96 flex-col divide-y divide-border overflow-y-auto rounded-lg shadow-(--shadow-border)">
            {state.suppression.map((entry) => (
              <li key={entry.email} className="px-3 py-2">
                <p className="truncate text-sm">{entry.email}</p>
                <p className="truncate text-xs text-subtle">
                  {entry.reason}
                  {entry.businessName ? ` · ${entry.businessName}` : ""} · {relativeTime(entry.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </>
  );
}

function AccountSection() {
  const user = useCurrentUser();
  return (
    <Panel title="Account" description="Only the owner account can use outreach, sync or search on this deployment.">
      <p className="text-sm">
        Signed in as <span className="font-medium">{user?.primaryEmail || user?.displayName || "—"}</span>
        {user?.isDevFallback ? <span className="text-subtle"> (local development)</span> : null}
      </p>
      {user && !user.isDevFallback ? (
        <Button variant="secondary" className="self-start" onClick={() => void signOut("/login")}>
          <LogOut />
          Sign out
        </Button>
      ) : null}
    </Panel>
  );
}
