/**
 * Sending, as something you watch happen.
 *
 * Confirm → one email at a time, each its own server call → a result that
 * names every failure and why. Emails leave only when Gmail confirms them (the
 * send engine records nothing as sent otherwise), so "10 sent" here is ten
 * Gmail message ids, not ten requests.
 *
 * Nothing runs in the background. If the tab closes mid-way, the emails not yet
 * sent stay approved for next time, and anything whose answer was lost is
 * checked against Gmail the next time Send opens.
 */
import { useEffect, useRef, useState } from "react";
import { Check, CircleSlash, Clock, Loader2, RotateCcw, Send, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProgressBar } from "./ui";
import { retryFailedEmails, sendEmail, setEmailDecision } from "@/lib/outreach/server";
import { hasRealPersonalisation } from "@/lib/outreach/evidence";
import { parseEvidenceSummary } from "@/lib/outreach/evidence";
import type { OutreachEmail } from "@/lib/outreach/types";
import { friendlyServerError } from "@/lib/server-errors";
import { cn } from "@/lib/utils";
import { plural } from "@/components/app/format";

type RowStatus = "pending" | "sending" | "sent" | "failed" | "held" | "blocked" | "skipped" | "stopped";
type Row = { id: string; businessName: string; recipient: string; status: RowStatus; reason: string; retryable: boolean; note?: string };

function personalised(email: OutreachEmail): boolean {
  const facts = parseEvidenceSummary(email.personalisationEvidence);
  return hasRealPersonalisation(
    facts.map((fact) => ({
      kind: fact.kind as never,
      text: fact.text,
      source: fact.source,
      strength: fact.kind === "TRADE_AND_PLACE" || fact.kind === "ESTABLISHED" ? "CONTEXT" : "STRONG",
    })),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function SendSession({
  open,
  emails,
  delaySeconds,
  remaining,
  onClose,
  onChanged,
}: {
  open: boolean;
  emails: OutreachEmail[];
  delaySeconds: number;
  /** How many more may go today. */
  remaining: number;
  onClose: () => void;
  /** Refresh the screen's data. */
  onChanged: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<"confirm" | "sending" | "done">("confirm");
  const [rows, setRows] = useState<Row[]>([]);
  const [countdown, setCountdown] = useState(0);
  const [stopRequested, setStopRequested] = useState(false);
  const stop = useRef(false);

  useEffect(() => {
    if (!open) return;
    setPhase("confirm");
    setStopRequested(false);
    stop.current = false;
    setRows(
      emails.map((email) => ({
        id: email.id,
        businessName: email.businessName,
        recipient: email.recipient,
        status: "pending",
        reason: "",
        retryable: false,
      })),
    );
    // Only when the dialog opens; the list is fixed for the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the phone awake and warn before leaving while emails are going out.
  useEffect(() => {
    if (phase !== "sending") return;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } };
    void nav.wakeLock?.request("screen").then((value) => (lock = value)).catch(() => undefined);
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
      void lock?.release().catch(() => undefined);
    };
  }, [phase]);

  const update = (id: string, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const sendable = Math.min(emails.length, remaining);
  const missingEvidence = emails.filter((email) => !email.personalisationEvidence.trim()).length;
  const personalisedCount = emails.filter(personalised).length;
  const minutes = Math.ceil(((Math.max(0, sendable - 1) * delaySeconds) + sendable * 3) / 60);

  async function run(targets: Row[]) {
    setPhase("sending");
    const byId = new Map(emails.map((email) => [email.id, email]));
    let haltAll: { status: RowStatus; reason: string } | null = null;
    for (const [index, row] of targets.entries()) {
      if (haltAll) {
        update(row.id, haltAll);
        continue;
      }
      if (stop.current) {
        update(row.id, { status: "stopped", reason: "Not sent — you stopped the batch. Still approved." });
        continue;
      }
      update(row.id, { status: "sending", reason: "" });
      try {
        const email = byId.get(row.id);
        if (email?.status === "draft") {
          const approved = await setEmailDecision({ data: { ids: [row.id], decision: "queue" } });
          if (!approved.ok || approved.changed === 0) {
            const why = approved.ok ? (approved.refused[0] ?? "could not be approved").replace(`${row.businessName}: `, "") : approved.error;
            update(row.id, { status: "blocked", reason: `Blocked — ${why}` });
            continue;
          }
        }
        const result = await sendEmail({ data: { id: row.id } });
        if (!result.ok) {
          update(row.id, { status: "failed", reason: result.error, retryable: true });
          continue;
        }
        const outcome = result.outcome;
        switch (outcome.status) {
          case "sent":
            update(row.id, { status: "sent", reason: outcome.recovered ? "Confirmed in Gmail after the answer was lost." : "" });
            break;
          case "sent_unrecorded":
            update(row.id, { status: "sent", reason: "", note: outcome.reason });
            break;
          case "already_sent":
            update(row.id, { status: "sent", reason: outcome.reason });
            break;
          case "held":
            update(row.id, { status: "held", reason: outcome.reason });
            if (/today's limit/.test(outcome.reason)) haltAll = { status: "held", reason: outcome.reason };
            break;
          case "not_sent":
            update(row.id, { status: "stopped", reason: outcome.reason });
            haltAll = { status: "stopped", reason: `Not sent — ${outcome.reason}` };
            break;
          case "blocked":
            update(row.id, { status: "blocked", reason: outcome.reason });
            break;
          case "failed":
            update(row.id, { status: "failed", reason: outcome.reason, retryable: outcome.retryable });
            break;
          default:
            update(row.id, { status: "skipped", reason: outcome.reason });
        }
      } catch (error) {
        update(row.id, {
          status: "failed",
          reason: `${friendlyServerError(error)} It will be checked against Gmail before any retry.`,
          retryable: true,
        });
      }
      const more = targets.slice(index + 1).length > 0;
      if (more && !haltAll && !stop.current) {
        for (let left = delaySeconds; left > 0; left -= 1) {
          if (stop.current) break;
          setCountdown(left);
          await sleep(1000);
        }
        setCountdown(0);
      }
    }
    setPhase("done");
    await onChanged();
  }

  async function retry() {
    const failed = rows.filter((row) => row.status === "failed" && row.retryable);
    if (failed.length === 0) return;
    stop.current = false;
    setStopRequested(false);
    setPhase("sending");
    const result = await retryFailedEmails({ data: { ids: failed.map((row) => row.id) } }).catch((error: unknown) => ({
      ok: false as const,
      error: friendlyServerError(error),
    }));
    if (!result.ok) {
      for (const row of failed) update(row.id, { reason: result.error });
      setPhase("done");
      return;
    }
    const again: Row[] = [];
    for (const item of result.results) {
      if (item.result === "requeued") {
        const row = failed.find((entry) => entry.id === item.emailId);
        if (row) again.push(row);
      } else if (item.result === "already_sent") {
        update(item.emailId, { status: "sent", reason: item.reason, retryable: false });
      } else {
        update(item.emailId, { reason: item.reason, retryable: false });
      }
    }
    await run(again);
  }

  const done = rows.filter((row) => row.status !== "pending" && row.status !== "sending").length;
  const sent = rows.filter((row) => row.status === "sent").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const others = rows.length - sent - failed;
  const current = rows.findIndex((row) => row.status === "sending");

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && phase !== "sending" ? onClose() : undefined)}>
      <DialogContent className="max-w-lg" onInteractOutside={(event) => phase === "sending" && event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>
            {phase === "confirm"
              ? `You're about to send ${plural(sendable, "email")}`
              : phase === "sending"
                ? current >= 0
                  ? `Sending ${current + 1} of ${rows.length}`
                  : countdown > 0
                    ? `Next email in ${countdown}s`
                    : "Sending…"
                : `${sent} sent · ${failed} failed${others ? ` · ${others} not sent` : ""}`}
          </DialogTitle>
          <DialogDescription>
            {phase === "confirm"
              ? `From your Gmail, one at a time with a ${delaySeconds}-second pause — about ${minutes} minute${minutes === 1 ? "" : "s"}. Keep this screen open.`
              : phase === "sending"
                ? "Each email is only counted once Gmail confirms it. Keep this screen open."
                : failed
                  ? "Failed emails can be retried — Gmail is checked first, so nothing is sent twice."
                  : sent === 0
                    ? "Nothing was sent. Each email below says why; fix that and send again."
                    : "Replies will appear in Replies. Follow-ups are never sent without you."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 overflow-y-auto px-5 pb-4">
          {phase === "confirm" ? (
            <div className="grid grid-cols-2 gap-2 text-sm">
              <Fact label="Recipients" value={sendable} />
              <Fact label="Personalised" value={personalisedCount} />
              <Fact label="Blocked" value={0} />
              <Fact label="Missing evidence" value={missingEvidence} warn={missingEvidence > 0} />
              {emails.length > sendable ? (
                <p className="col-span-2 text-xs text-warn">
                  {plural(emails.length - sendable, "email")} will wait for tomorrow — today's limit allows {remaining} more.
                </p>
              ) : null}
            </div>
          ) : (
            <ProgressBar value={done} max={rows.length} />
          )}

          <ul className="flex max-h-[45dvh] flex-col divide-y divide-border overflow-y-auto rounded-lg shadow-(--shadow-border)">
            {rows.slice(0, phase === "confirm" ? sendable : rows.length).map((row) => (
              <li key={row.id} className="flex items-start gap-3 px-3 py-2.5">
                <StatusIcon status={row.status} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{row.businessName}</p>
                  <p className="truncate text-xs text-muted">{row.recipient}</p>
                  {row.reason ? <p className={cn("mt-0.5 text-xs", row.status === "sent" ? "text-muted" : "text-warn")}>{row.reason}</p> : null}
                  {row.note ? <p className="mt-0.5 text-xs text-warn">{row.note}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter>
          {phase === "confirm" ? (
            <>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={sendable === 0} onClick={() => void run(rows.slice(0, sendable))}>
                <Send />
                Send {plural(sendable, "email")}
              </Button>
            </>
          ) : phase === "sending" ? (
            <Button
              variant="secondary"
              disabled={stopRequested}
              onClick={() => {
                stop.current = true;
                setStopRequested(true);
              }}
            >
              <X />
              {stopRequested ? "Stopping after this one…" : "Stop"}
            </Button>
          ) : (
            <>
              {rows.some((row) => row.status === "failed" && row.retryable) ? (
                <Button variant="secondary" onClick={() => void retry()}>
                  <RotateCcw />
                  Retry {rows.filter((row) => row.status === "failed" && row.retryable).length} failed
                </Button>
              ) : null}
              <Button onClick={onClose}>Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Fact({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2">
      <p className={cn("font-display text-xl tabular", warn ? "text-warn" : "text-fg")}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

function StatusIcon({ status }: { status: RowStatus }) {
  const base = "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full";
  switch (status) {
    case "sending":
      return <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-fg" />;
    case "sent":
      return (
        <span className={cn(base, "bg-good/15 text-good")}>
          <Check className="size-3.5" />
        </span>
      );
    case "failed":
      return (
        <span className={cn(base, "bg-bad/15 text-bad")}>
          <TriangleAlert className="size-3" />
        </span>
      );
    case "held":
    case "stopped":
      return (
        <span className={cn(base, "bg-warn/15 text-warn")}>
          <Clock className="size-3" />
        </span>
      );
    case "blocked":
    case "skipped":
      return (
        <span className={cn(base, "bg-surface-2 text-muted")}>
          <CircleSlash className="size-3" />
        </span>
      );
    default:
      return <span className={cn(base, "border border-border")} />;
  }
}
