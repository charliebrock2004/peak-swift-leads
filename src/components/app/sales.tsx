/**
 * The pieces of the sales loop shared by the business page and call mode:
 * the call brief, the call-outcome picker (with optional dictation), the
 * timeline, tasks and the stage editor. Every write goes through
 * `salesAction`, so the server records the interaction, moves the pipeline
 * and leaves the next task.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  CalendarClock,
  Check,
  CircleDot,
  FileText,
  Globe,
  Inbox,
  Mail,
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  Plus,
  Search,
  ShieldAlert,
  StickyNote,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { callMinutes, clearCallStart } from "@/lib/sales/call-timer";
import { runSalesAction } from "@/lib/sales/client";
import type { CallBrief } from "@/lib/sales/call-brief";
import { formatPence, parsePounds } from "@/lib/sales/pipeline";
import type { TimelineEvent } from "@/lib/sales/timeline";
import { CALL_OUTCOME_LABEL, CALL_OUTCOMES, STAGE_LABEL, STAGES, TASK_LABEL, TASK_TYPES, type CallOutcome, type Opportunity, type Stage, type Task, type TaskType } from "@/lib/sales/types";
import { relativeTime } from "./format";

// ── Call brief ───────────────────────────────────────────────────────────────

export function CallBriefView({ brief, compact = false }: { brief: CallBrief; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      {brief.why.length ? (
        <div>
          <p className="text-[11px] font-medium tracking-wider text-subtle uppercase">Why call</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {brief.why.map((line) => (
              <li key={line.text}>
                <span>{line.text}</span>
                <span className="text-xs text-subtle"> · {line.source}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {brief.previous ? (
        <p className="text-muted">
          <span className="text-[11px] font-medium tracking-wider text-subtle uppercase">Last time </span>
          {brief.previous}
        </p>
      ) : null}
      <div>
        <p className="text-[11px] font-medium tracking-wider text-subtle uppercase">Opening</p>
        <p className="mt-1">{brief.opening}</p>
      </div>
      {!compact || brief.objections.length ? (
        <details className="group">
          <summary className="cursor-pointer text-[11px] font-medium tracking-wider text-subtle uppercase">If they say…</summary>
          <ul className="mt-1.5 flex flex-col gap-2">
            {brief.objections.map((item) => (
              <li key={item.objection}>
                <p className="text-muted italic">“{item.objection}”</p>
                <p>{item.response}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div>
        <p className="text-[11px] font-medium tracking-wider text-subtle uppercase">Ask</p>
        <p className="mt-1">{brief.ask}</p>
        {brief.fallback ? <p className="mt-1 text-xs text-muted">If they hesitate: {brief.fallback}</p> : null}
      </div>
      <p className="text-xs text-subtle">A starting point, not a script — say it your way. Every fact above is on record.</p>
    </div>
  );
}

// ── Dictation ────────────────────────────────────────────────────────────────

type Recognition = { start: () => void; stop: () => void; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>; resultIndex: number }) => void) | null; onend: (() => void) | null; continuous: boolean; interimResults: boolean; lang: string };

function speechRecognition(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const source = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return source.SpeechRecognition ?? source.webkitSpeechRecognition ?? null;
}

/** Speak a note instead of typing it, where the browser supports it. */
function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(Boolean(speechRecognition())), []);
  const toggle = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Ctor = speechRecognition();
    if (!Ctor) return;
    const next = new Ctor();
    next.lang = "en-GB";
    next.continuous = true;
    next.interimResults = false;
    next.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]!;
        if (result.isFinal) onText(result[0]!.transcript.trim());
      }
    };
    next.onend = () => setListening(false);
    recognition.current = next;
    next.start();
    setListening(true);
  };
  useEffect(() => () => recognition.current?.stop(), []);
  return { supported, listening, toggle };
}

// ── Call outcome ─────────────────────────────────────────────────────────────

const OUTCOME_TONE: Partial<Record<CallOutcome, "good" | "bad">> = { interested: "good", meeting_booked: "good", not_interested: "bad", wrong_number: "bad" };

/**
 * Log what happened on a call. Call back and meeting booked ask when; every
 * outcome can carry a note, typed or spoken.
 */
export function CallOutcomePicker({ leadId, onLogged, autoFocusNote = false }: { leadId: string; onLogged: (result: { outcome: CallOutcome; leadPatch: Record<string, string> }) => void; autoFocusNote?: boolean }) {
  const [outcome, setOutcome] = useState<CallOutcome | "">("");
  const [note, setNote] = useState("");
  const [when, setWhen] = useState("");
  const [minutes, setMinutes] = useState("");
  const [busy, setBusy] = useState(false);
  const dictation = useDictation((text) => setNote((current) => [current.trim(), text].filter(Boolean).join(" ")));
  const needsWhen = outcome === "call_back" || outcome === "meeting_booked";

  const choose = (value: CallOutcome) => {
    setOutcome(value);
    // The timer started when Call was tapped; the person confirms or corrects it.
    if (!minutes) setMinutes(String(callMinutes(leadId) ?? ""));
  };

  const save = async () => {
    if (!outcome) return;
    setBusy(true);
    const spent = Math.min(90, Math.max(0, Number(minutes) || 0));
    const reply = await runSalesAction({ action: "log_call", leadId, outcome, note, at: when ? new Date(when).toISOString() : "", seconds: Math.round(spent * 60) });
    setBusy(false);
    if (!reply.ok) return void toast(reply.error);
    clearCallStart();
    setMinutes("");
    const result = JSON.parse(reply.json) as { leadPatch: Record<string, string>; doNotCall: boolean; task: Task | null };
    toast(`${CALL_OUTCOME_LABEL[outcome]} — logged${result.task ? `. Next: ${result.task.title}` : ""}${result.doNotCall ? ". Number added to your do-not-call list." : ""}`);
    onLogged({ outcome, leadPatch: result.leadPatch });
    setOutcome("");
    setNote("");
    setWhen("");
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {CALL_OUTCOMES.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => choose(value)}
            className={cn(
              "h-12 rounded-lg px-2 text-sm font-medium transition-colors",
              outcome === value
                ? OUTCOME_TONE[value] === "good"
                  ? "bg-good text-bg"
                  : OUTCOME_TONE[value] === "bad"
                    ? "bg-bad text-bg"
                    : "bg-accent text-accent-fg"
                : "bg-surface-2 text-fg hover:bg-border",
            )}
          >
            {CALL_OUTCOME_LABEL[value]}
          </button>
        ))}
      </div>
      {outcome ? (
        <>
          {needsWhen ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">{outcome === "call_back" ? "When should you call back?" : "When is the meeting?"}</span>
              <Input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} className="h-11" />
            </label>
          ) : null}
          <div className="flex gap-2">
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Anything worth remembering? (optional)"
              rows={2}
              autoFocus={autoFocusNote}
              className="min-h-11 flex-1 resize-y rounded-md bg-surface px-3 py-2 text-sm shadow-(--shadow-border) outline-none"
            />
            {dictation.supported ? (
              <Button variant={dictation.listening ? "default" : "secondary"} size="icon" className="size-11 shrink-0" onClick={dictation.toggle} aria-label={dictation.listening ? "Stop dictating" : "Dictate a note"}>
                {dictation.listening ? <MicOff /> : <Mic />}
              </Button>
            ) : null}
          </div>
          {dictation.listening ? <p className="-mt-1 text-xs text-muted">Listening… your browser's speech service turns this into text.</p> : null}
          <label className="flex items-center gap-2 text-sm text-muted">
            Minutes on the call
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={90}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              placeholder="—"
              className="h-11 w-20 tabular"
            />
            <span className="hidden text-xs text-subtle sm:inline">counts toward minutes per conversation</span>
          </label>
          <Button className="h-12" disabled={busy || (outcome === "meeting_booked" && !when)} onClick={() => void save()}>
            <Check />
            Log: {CALL_OUTCOME_LABEL[outcome]}
          </Button>
        </>
      ) : null}
    </div>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────────

const TIMELINE_ICON: Record<TimelineEvent["kind"], typeof Mail> = {
  discovered: Search,
  company: FileText,
  audit: Globe,
  email: Mail,
  reply: Inbox,
  bounce: ShieldAlert,
  opt_out: ShieldAlert,
  call: Phone,
  note: StickyNote,
  meeting: CalendarClock,
  quote: FileText,
  stage: TrendingUp,
  task: Check,
  system: CircleDot,
};

export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) return <p className="text-sm text-subtle">Nothing yet.</p>;
  return (
    <ol className="flex flex-col">
      {events.map((event) => {
        const Icon = TIMELINE_ICON[event.kind] ?? MessageSquare;
        return (
          <li key={event.id} className="flex gap-3 py-2">
            <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full", event.tone === "good" ? "bg-good/12 text-good" : event.tone === "bad" ? "bg-bad/12 text-bad" : event.tone === "warn" ? "bg-warn/12 text-warn" : "bg-surface-2 text-muted")}>
              <Icon className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-sm">{event.title}</span>
                <span className="shrink-0 text-xs text-subtle" title={new Date(event.at).toLocaleString("en-GB")}>
                  {new Date(event.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                </span>
              </span>
              {event.detail ? <span className="line-clamp-3 block text-xs text-muted">{event.detail}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export function TaskList({ leadId, tasks, onChanged }: { leadId: string; tasks: Task[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<TaskType>("FOLLOW_UP");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const open = tasks.filter((task) => task.status === "open");

  const close = async (task: Task) => {
    const reply = await runSalesAction({ action: "task_status", taskId: task.id, status: "done" });
    if (!reply.ok) return void toast(reply.error);
    onChanged();
  };
  const add = async () => {
    const reply = await runSalesAction({ action: "save_task", leadId, type, title: title.trim() || TASK_LABEL[type], dueAt: due ? `${due}T10:00:00.000Z` : "" });
    if (!reply.ok) return void toast(reply.error);
    setAdding(false);
    setTitle("");
    setDue("");
    onChanged();
  };

  return (
    <div className="flex flex-col gap-2">
      {open.length === 0 && !adding ? <p className="text-sm text-subtle">No open tasks.</p> : null}
      <ul className="flex flex-col">
        {open.map((task) => {
          const overdue = task.dueAt && Date.parse(task.dueAt) < Date.now() - 86_400_000;
          return (
            <li key={task.id} className="flex items-center gap-2 py-1.5">
              <button type="button" onClick={() => void close(task)} className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border hover:border-good hover:text-good" aria-label={`Mark "${task.title}" done`}>
                <Check className="size-3.5" />
              </button>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{task.title}</span>
                <span className={cn("text-xs", overdue ? "text-warn" : "text-muted")}>
                  {TASK_LABEL[task.type]}
                  {task.dueAt ? ` · ${overdue ? "overdue · " : ""}${new Date(task.dueAt).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}` : ""}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {adding ? (
        <div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3">
          <div className="flex gap-2">
            <select value={type} onChange={(event) => setType(event.target.value as TaskType)} className="h-10 rounded-md bg-surface px-2 text-sm shadow-(--shadow-border)" aria-label="Task type">
              {TASK_TYPES.map((value) => (
                <option key={value} value={value}>
                  {TASK_LABEL[value]}
                </option>
              ))}
            </select>
            <Input type="date" value={due} onChange={(event) => setDue(event.target.value)} className="h-10 flex-1" aria-label="Due date" />
          </div>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What needs doing?" className="h-10" />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void add()}>
              Add task
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setAdding(true)}>
          <Plus /> Add a task
        </Button>
      )}
    </div>
  );
}

// ── Stage and value ──────────────────────────────────────────────────────────

export function StageEditor({ leadId, stage, opportunity, onChanged }: { leadId: string; stage: Stage; opportunity: Opportunity | null; onChanged: () => void }) {
  const [next, setNext] = useState<Stage>(stage);
  const [value, setValue] = useState(opportunity?.valuePence != null ? String(opportunity.valuePence / 100) : "");
  const [lostReason, setLostReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setNext(stage), [stage]);
  useEffect(() => setValue(opportunity?.valuePence != null ? String(opportunity.valuePence / 100) : ""), [opportunity?.valuePence]);

  const pence = value.trim() ? parsePounds(value) : null;
  const valueChanged = (pence ?? null) !== (opportunity?.valuePence ?? null);
  const badValue = value.trim() !== "" && pence === null;

  const save = async () => {
    setBusy(true);
    const reply =
      next !== stage
        ? await runSalesAction({ action: "set_stage", leadId, stage: next, valuePence: valueChanged ? pence : undefined, lostReason })
        : await runSalesAction({ action: "save_value", leadId, valuePence: pence });
    setBusy(false);
    if (!reply.ok) return void toast(reply.error);
    toast(next !== stage ? `Moved to ${STAGE_LABEL[next]}.` : "Saved.");
    onChanged();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Stage</span>
          <select value={next} onChange={(event) => setNext(event.target.value as Stage)} className="h-11 rounded-md bg-surface px-2 text-sm shadow-(--shadow-border)">
            {STAGES.map((value) => (
              <option key={value} value={value}>
                {STAGE_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Value</span>
          <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="£" inputMode="decimal" className={cn("h-11", badValue ? "ring-1 ring-bad" : "")} />
        </label>
      </div>
      {next === "LOST" && stage !== "LOST" ? <Input value={lostReason} onChange={(event) => setLostReason(event.target.value)} placeholder="Why was it lost? (helps you learn)" className="h-11" /> : null}
      {opportunity ? (
        <p className="text-xs text-muted">
          {opportunity.quoteDate ? `Quoted ${new Date(opportunity.quoteDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}
          {opportunity.wonDate ? ` · Won ${new Date(opportunity.wonDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}
          {opportunity.lostReason && stage === "LOST" ? ` · Lost: ${opportunity.lostReason}` : ""}
          {opportunity.nurtureDate && stage === "NURTURE" ? ` · Check back ${new Date(opportunity.nurtureDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}
          {opportunity.stageChangedAt ? ` · ${STAGE_LABEL[stage]} ${relativeTime(opportunity.stageChangedAt)}` : ""}
        </p>
      ) : null}
      {(next !== stage || valueChanged) && !badValue ? (
        <Button disabled={busy} onClick={() => void save()}>
          {next !== stage ? `Move to ${STAGE_LABEL[next]}${pence != null && valueChanged ? ` · ${formatPence(pence)}` : ""}` : `Save value ${pence != null ? formatPence(pence) : ""}`}
        </Button>
      ) : null}
    </div>
  );
}
