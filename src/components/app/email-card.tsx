import { useState } from "react";
import { Check, ChevronDown, Loader2, Pencil, RefreshCw, Send, SkipForward, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, Card } from "./ui";
import { ProspectFacts, ScoreHeader, WhyThisProspect } from "./prospect-facts";
import { parseEvidenceSummary } from "@/lib/outreach/evidence";
import { ANGLE_LABEL, type Angle } from "@/lib/outreach/angles";
import type { LeadEvidence } from "@/lib/outreach/evidence-record";
import type { OutreachEmail, OutreachLead } from "@/lib/outreach/types";
import { cn } from "@/lib/utils";

export type CardActions = {
  save: (id: string, subject: string, body: string) => Promise<void>;
  regenerate: (email: OutreachEmail) => Promise<void>;
  approve: (id: string) => Promise<void>;
  skip: (id: string) => Promise<void>;
  sendNow: (email: OutreachEmail) => void;
};

function statusBadge(email: OutreachEmail, blocked: string) {
  if (blocked) return <Badge tone="bad">Blocked</Badge>;
  if (email.status === "approved" || email.status === "queued") return <Badge tone="good">Approved</Badge>;
  if (email.status === "failed") return <Badge tone="bad">Failed</Badge>;
  return <Badge>Draft</Badge>;
}

function writtenBy(email: OutreachEmail): string {
  if (email.generatedBy === "ai") return "Written by AI from the evidence below";
  if (email.generatedBy === "manual") return "Edited by you";
  if (email.generatedBy.startsWith("template:")) return `Template: ${email.generatedBy.slice(9).replace(/-/g, " ")}`;
  return email.generatedBy;
}

export function EmailCard({
  email,
  lead,
  evidence,
  blocked,
  selected,
  onToggle,
  busy,
  actions,
}: {
  email: OutreachEmail;
  lead?: OutreachLead;
  evidence?: LeadEvidence;
  /** Why it cannot be sent, in words — empty when it can. */
  blocked: string;
  selected: boolean;
  onToggle: () => void;
  /** Which action is running on this card, if any. */
  busy: string;
  actions: CardActions;
}) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(email.subject);
  const [body, setBody] = useState(email.body);
  const [showWhy, setShowWhy] = useState(false);
  const approved = email.status === "approved" || email.status === "queued";
  const facts = parseEvidenceSummary(email.personalisationEvidence);

  return (
    <Card as="article" className={cn("overflow-hidden", selected && !blocked ? "shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-accent)_45%,transparent)]" : "")}>
      <header className="flex items-start gap-3 px-4 pt-4 md:px-5">
        <input
          type="checkbox"
          checked={selected}
          disabled={Boolean(blocked)}
          onChange={onToggle}
          className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]"
          aria-label={`Include ${email.businessName} in this send`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate font-medium">{email.businessName}</h3>
            {statusBadge(email, blocked)}
            {email.kind !== "initial" ? <Badge tone="info">{email.kind === "follow-up-1" ? "Follow-up" : "Final follow-up"}</Badge> : null}
          </div>
          <p className="mt-0.5 text-sm text-muted">{[lead?.town, lead?.trade].filter(Boolean).join(" · ") || email.recipient}</p>
        </div>
        {lead ? <ScoreHeader lead={lead} /> : null}
      </header>

      {lead ? (
        <div className="flex flex-col gap-3 px-4 pt-3.5 md:px-5">
          <ProspectFacts lead={lead} evidence={evidence} />
          <div>
            <p className="mb-1.5 text-xs font-medium text-subtle">Why this prospect</p>
            <WhyThisProspect lead={lead} />
          </div>
        </div>
      ) : null}

      {blocked ? (
        <div className="mx-4 mt-3.5 flex items-start gap-2 rounded-md bg-bad/10 px-3 py-2.5 text-sm text-bad md:mx-5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>Blocked — {blocked}</span>
        </div>
      ) : null}

      <div className="mx-4 mt-3.5 rounded-lg bg-bg/60 px-3.5 py-3 shadow-(--shadow-border) md:mx-5">
        {editing ? (
          <div className="flex flex-col gap-2">
            <Input value={subject} onChange={(event) => setSubject(event.target.value)} aria-label="Subject" />
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={Math.min(18, Math.max(8, body.split("\n").length + 1))}
              className="email-preview w-full rounded-md bg-surface p-3 text-fg shadow-(--shadow-border) outline-none focus-visible:shadow-(--shadow-focus)"
              aria-label="Email body"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setSubject(email.subject);
                  setBody(email.body);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy === "save"}
                onClick={async () => {
                  await actions.save(email.id, subject, body);
                  setEditing(false);
                }}
              >
                {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />}
                Save
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs text-subtle">
              To <span className="text-muted">{email.recipient}</span>
            </p>
            <p className="mt-1 font-medium">{email.subject}</p>
            <p className="email-preview mt-2 text-fg/90">{email.body}</p>
          </>
        )}
      </div>

      <div className="px-4 pt-3 md:px-5">
        <button type="button" onClick={() => setShowWhy((open) => !open)} className="flex items-center gap-1 text-xs text-muted hover:text-fg">
          <Sparkles className="size-3.5" />
          Why this email was written
          <ChevronDown className={cn("size-3.5 transition-transform", showWhy ? "rotate-180" : "")} />
        </button>
        {showWhy ? (
          <div className="rise-in mt-2 rounded-md bg-surface-2 px-3 py-2.5 text-sm">
            <p className="text-xs text-subtle">{writtenBy(email)}</p>
            {email.angle ? (
              <p className="mt-1 text-xs text-muted">
                <span className="text-subtle">Leads with: </span>
                {ANGLE_LABEL[email.angle as Angle] ?? email.angle}
              </p>
            ) : null}
            {facts.length > 0 ? (
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted">
                {facts.map((fact) => (
                  <li key={`${fact.kind}-${fact.text}`}>
                    {fact.text} <span className="text-subtle">({fact.source})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-muted">No evidence was recorded for this older draft.</p>
            )}
            {email.personalisationNote ? (
              <p className="mt-2 text-muted">
                <span className="text-subtle">Personalisation: </span>
                {email.personalisationNote}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <footer className="mt-3.5 flex flex-wrap gap-2 border-t border-border px-4 py-3 md:px-5">
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)} disabled={editing}>
          <Pencil />
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void actions.regenerate(email)} disabled={busy === "regenerate"}>
          {busy === "regenerate" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Regenerate
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void actions.skip(email.id)} disabled={busy === "skip"}>
          <SkipForward />
          Skip
        </Button>
        <div className="ml-auto flex gap-2">
          {!approved ? (
            <Button variant="secondary" size="sm" disabled={Boolean(blocked) || busy === "approve"} onClick={() => void actions.approve(email.id)}>
              {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />}
              Approve
            </Button>
          ) : null}
          <Button size="sm" disabled={Boolean(blocked)} onClick={() => actions.sendNow(email)}>
            <Send />
            Send
          </Button>
        </div>
      </footer>
    </Card>
  );
}
