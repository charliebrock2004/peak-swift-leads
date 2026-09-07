import { useState } from "react";
import { CheckCircle2, Link2, Loader2, Send, TriangleAlert, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OutreachActions } from "@/components/outreach/outreach-panel";
import type { OutreachState } from "@/lib/outreach/server";
import type { OutreachSettings, OutreachTemplate } from "@/lib/outreach/types";
import { leftoverVariables, TEMPLATE_VARIABLES } from "@/lib/outreach/templates";
import { cn } from "@/lib/utils";

/**
 * The Gmail connection, the sending controls, and the templates.
 *
 * The connection panel says exactly one true thing at a time: which account is
 * attached, whether it is healthy, and what to do if it is not. Nothing here
 * ever shows a token — the browser is never given one.
 */
export function OutreachSettingsTab({
  state,
  busy,
  actions,
}: {
  state: OutreachState;
  busy: string;
  actions: OutreachActions;
}) {
  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState("");
  const [settings, setSettings] = useState<OutreachSettings>(state.settings);
  const [openTemplate, setOpenTemplate] = useState<string | null>(null);

  const connection = state.connection;

  async function sendTest() {
    setTestResult("");
    const result = await actions.sendTest(testTo.trim());
    if (result && result.ok) setTestResult(`Sent to ${result.to}.`);
  }

  function patch(next: Partial<OutreachSettings>) {
    setSettings((current) => ({ ...current, ...next }));
  }

  return (
    <section className="flex flex-col gap-6">
      {/* ── Gmail ─────────────────────────────────────────────────────────── */}
      <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
        <h3 className="font-display text-lg font-medium">Email</h3>

        {!connection.configured ? (
          <div className="mt-3 rounded-md bg-warm-lead/10 px-3 py-3">
            <p className="text-sm text-warm-lead">Google OAuth is not set up on the server yet.</p>
            <p className="mt-2 text-sm text-muted">
              Add <code className="text-fg">GOOGLE_CLIENT_ID</code> and{" "}
              <code className="text-fg">GOOGLE_CLIENT_SECRET</code> to the deployment&apos;s environment
              variables, then reload this page. The steps are in the README.
            </p>
          </div>
        ) : null}

        <dl className="mt-3 flex flex-col gap-2 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">Connected account</dt>
            <dd className="min-w-0 truncate text-right font-medium">{connection.email || "—"}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">Status</dt>
            <dd
              className={cn(
                "flex items-center gap-1.5 font-medium",
                connection.status === "connected" && "text-fg",
                connection.status === "needs_attention" && "text-warm-lead",
                connection.status === "disconnected" && "text-muted",
              )}
            >
              {connection.status === "connected" ? <CheckCircle2 className="size-4" /> : null}
              {connection.status === "needs_attention" ? <TriangleAlert className="size-4" /> : null}
              {connection.status === "connected"
                ? "Connected"
                : connection.status === "needs_attention"
                  ? "Needs attention"
                  : "Not connected"}
            </dd>
          </div>
        </dl>

        {connection.lastError ? <p className="mt-2 text-sm text-hot">{connection.lastError}</p> : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            className="h-11"
            disabled={busy !== "" || !connection.configured}
            onClick={() => void actions.connectGmail()}
          >
            {busy === "connect" ? <Loader2 className="animate-spin" /> : <Link2 />}
            {connection.status === "connected" ? "Reconnect Gmail" : "Connect Gmail"}
          </Button>
          <Button
            variant="secondary"
            className="h-11"
            disabled={busy !== "" || connection.status === "disconnected"}
            onClick={() => void actions.disconnectGmail()}
          >
            {busy === "disconnect" ? <Loader2 className="animate-spin" /> : <Unlink />}
            Disconnect
          </Button>
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <p className="text-xs font-medium text-muted">Send a test email</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Input
              className="h-11 bg-bg"
              value={testTo}
              onChange={(event) => setTestTo(event.target.value)}
              placeholder={connection.email || "you@example.com"}
              aria-label="Test recipient"
              inputMode="email"
            />
            <Button
              variant="secondary"
              className="h-11 shrink-0"
              disabled={busy !== "" || connection.status !== "connected"}
              onClick={() => void sendTest()}
            >
              {busy === "test" ? <Loader2 className="animate-spin" /> : <Send />}
              Send test
            </Button>
          </div>
          <p className="mt-2 text-xs text-subtle">
            Goes to your own address if you leave it blank. No prospect is contacted.
          </p>
          {testResult ? <p className="mt-2 text-sm text-fg">{testResult}</p> : null}
        </div>
      </div>

      {/* ── Sending controls ──────────────────────────────────────────────── */}
      <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
        <h3 className="font-display text-lg font-medium">Sending</h3>
        <p className="mt-1 text-sm text-muted">
          Conservative by default. The daily limit is counted from what actually went out, so it cannot drift.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <NumberField
            label="Daily limit"
            value={settings.dailyLimit}
            min={0}
            max={200}
            onChange={(value) => patch({ dailyLimit: value })}
          />
          <NumberField
            label="Emails per batch"
            value={settings.batchSize}
            min={1}
            max={25}
            onChange={(value) => patch({ batchSize: value })}
          />
          <NumberField
            label="Delay between emails (seconds)"
            value={settings.delaySeconds}
            min={5}
            max={600}
            onChange={(value) => patch({ delaySeconds: value })}
          />
          <NumberField
            label="Maximum follow-ups"
            value={settings.maxFollowUps}
            min={0}
            max={2}
            onChange={(value) => patch({ maxFollowUps: value })}
          />
          <NumberField
            label="Follow-up 1 after (days)"
            value={settings.followUp1Days}
            min={1}
            max={60}
            onChange={(value) => patch({ followUp1Days: value })}
          />
          <NumberField
            label="Follow-up 2 after (days)"
            value={settings.followUp2Days}
            min={1}
            max={90}
            onChange={(value) => patch({ followUp2Days: value })}
          />
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <Toggle
            label="Follow-ups"
            hint="Off unless you want them. Never sent after a reply, an unsubscribe, a booking or a win."
            checked={settings.followUpsOn}
            onChange={(value) => patch({ followUpsOn: value })}
          />
          <Toggle
            label="Automatic sending"
            hint="Send approved batches without pressing Send. Everything still passes every check."
            checked={settings.autoSend}
            onChange={(value) => patch({ autoSend: value })}
          />
          <Toggle
            label="Include low-opportunity leads"
            hint="Off by default. High and medium opportunity are the ones worth your Gmail reputation."
            checked={settings.includeLow}
            onChange={(value) => patch({ includeLow: value })}
          />
        </div>

        <Button
          className="mt-4 h-11"
          disabled={busy !== ""}
          onClick={() => void actions.saveSettings(settings)}
        >
          {busy === "settings" ? <Loader2 className="animate-spin" /> : null}
          Save settings
        </Button>
      </div>

      {/* ── Templates ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl bg-surface px-4 py-4 shadow-(--shadow-border)">
        <h3 className="font-display text-lg font-medium">Templates</h3>
        <p className="mt-1 text-sm text-muted">
          Used when you pick one instead of AI, and whenever an AI draft is rejected. Variables:{" "}
          {TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(" ")}
        </p>
        <ul className="mt-3 flex flex-col gap-2">
          {state.templates.map((template) => (
            <TemplateEditor
              key={template.id}
              template={template}
              open={openTemplate === template.id}
              busy={busy}
              onToggle={() => setOpenTemplate(openTemplate === template.id ? null : template.id)}
              onSave={(next) => void actions.saveTemplate(next)}
            />
          ))}
        </ul>
      </div>

      <p className="text-xs text-subtle">
        Outreach only ever uses business contact details that were found published on the business&apos;s own
        website. Addresses are never guessed, anything that looks like a sole trader is held for you to
        check, and every email says who it is from and how to stop them.
      </p>
    </section>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      <Input
        type="number"
        className="h-11 bg-bg"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        className="mt-0.5 size-5 shrink-0 accent-[var(--color-accent)]"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-subtle">{hint}</span>
      </span>
    </label>
  );
}

function TemplateEditor({
  template,
  open,
  busy,
  onToggle,
  onSave,
}: {
  template: OutreachTemplate;
  open: boolean;
  busy: string;
  onToggle: () => void;
  onSave: (template: OutreachTemplate) => void;
}) {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [signature, setSignature] = useState(template.signature);

  const unknown = [...leftoverVariables(subject), ...leftoverVariables(body)].filter(
    (name) => !(TEMPLATE_VARIABLES as readonly string[]).includes(name),
  );

  return (
    <li className="rounded-md bg-bg px-3 py-2.5 shadow-(--shadow-border)">
      <button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={onToggle}>
        <span className="min-w-0">
          <span className="block text-sm font-medium">{template.name}</span>
          <span className="block truncate text-xs text-muted">{subject}</span>
        </span>
        <span className="shrink-0 text-xs text-subtle">{open ? "Close" : "Edit"}</span>
      </button>

      {open ? (
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Subject</span>
            <Input className="h-11 bg-surface" value={subject} onChange={(event) => setSubject(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Body</span>
            <textarea
              rows={12}
              className="w-full resize-y rounded-md bg-surface px-3 py-2 text-sm text-fg shadow-(--shadow-border) outline-none"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted">Signature</span>
            <textarea
              rows={2}
              className="w-full resize-y rounded-md bg-surface px-3 py-2 text-sm text-fg shadow-(--shadow-border) outline-none"
              value={signature}
              onChange={(event) => setSignature(event.target.value)}
            />
          </label>
          {unknown.length > 0 ? (
            <p className="text-xs text-hot">
              Unknown variable{unknown.length === 1 ? "" : "s"}: {[...new Set(unknown)].map((n) => `{{${n}}}`).join(", ")} —
              an email containing these will be refused.
            </p>
          ) : null}
          <Button
            size="sm"
            className="self-start"
            disabled={busy !== ""}
            onClick={() => onSave({ ...template, subject, body, signature })}
          >
            Save template
          </Button>
        </div>
      ) : null}
    </li>
  );
}
