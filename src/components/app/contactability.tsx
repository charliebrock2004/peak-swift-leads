/**
 * Who a business is, legally, and whether it may be emailed or rung — as
 * compact UI pieces shared by Prospects, Calls and the business view.
 *
 * Every verdict shown here is computed by the same pure rules the server's send
 * gate enforces (contactability/*), so the screen can never say "OK" where the
 * server would refuse.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Building2, Check, Loader2, Search, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "./ui";
import { LEGAL_FORM_LABEL, type LegalFormResult } from "@/lib/contactability/legal-form";
import { CALL_STATUS_LABEL, type CallContactability } from "@/lib/contactability/phone";
import { checkCompany, confirmCompany, setLegalForm } from "@/lib/contactability/server";
import type { CandidateSummary } from "@/lib/contactability/company-match";
import { friendlyServerError } from "@/lib/server-errors";

export function LegalFormBadge({ legal }: { legal: LegalFormResult }) {
  const tone = legal.form === "CORPORATE" ? (legal.confidence === "high" ? "good" : "neutral") : legal.form === "INDIVIDUAL" ? "info" : "warn";
  return (
    <Badge tone={tone}>
      {legal.form === "INDIVIDUAL" ? <User className="size-3" /> : <Building2 className="size-3" />}
      {LEGAL_FORM_LABEL[legal.form]}
      {legal.form === "CORPORATE" && legal.confidence !== "high" ? <span className="text-subtle">· unconfirmed</span> : null}
    </Badge>
  );
}

export function CallStatusBadge({ call }: { call: CallContactability }) {
  const tone = call.status === "ELIGIBLE" ? "good" : call.status === "BLOCKED" ? "bad" : "warn";
  return <Badge tone={tone}>{CALL_STATUS_LABEL[call.status]}</Badge>;
}

/**
 * The legal form, why, and what to do about it: check Companies House, pick
 * the right company from candidates, or record your own ruling (with how you
 * know). Nothing here makes a business emailable that the rules refuse — a
 * ruling is recorded as yours, with your reason, and can be cleared.
 */
export function LegalFormPanel({
  leadId,
  businessName,
  legal,
  onChanged,
  compact = false,
}: {
  leadId: string;
  businessName: string;
  legal: LegalFormResult;
  onChanged: () => void | Promise<void>;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState("");
  const [candidates, setCandidates] = useState<CandidateSummary[] | null>(null);
  const [ruling, setRuling] = useState<"" | "CORPORATE" | "INDIVIDUAL">("");
  const [note, setNote] = useState("");

  const stop = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const check = async () => {
    setBusy("check");
    try {
      const result = await checkCompany({ data: { leadId } });
      if (!result.success) return void toast(result.error);
      const outcome = result.outcome;
      if (outcome.status === "confirmed") {
        toast(`${businessName}: ${outcome.legalName} (${outcome.companyNumber}), ${outcome.companyStatus || "status unknown"}.`);
        setCandidates(null);
        await onChanged();
      } else if (outcome.status === "no-match") {
        toast(`${businessName}: no matching company on Companies House. That suggests — but does not prove — a sole trader.`);
        await onChanged();
      } else if (outcome.status === "ambiguous") {
        setCandidates(outcome.candidates);
      } else {
        toast(outcome.error);
      }
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setBusy("");
    }
  };

  const confirm = async (companyNumber: string) => {
    setBusy(companyNumber);
    try {
      const result = await confirmCompany({ data: { leadId, companyNumber } });
      if (!result.success) return void toast(result.error);
      if (result.outcome.status !== "confirmed") return void toast(result.outcome.status === "error" ? result.outcome.error : "Not confirmed.");
      toast(`${businessName} linked to ${result.outcome.legalName}.`);
      setCandidates(null);
      await onChanged();
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setBusy("");
    }
  };

  const save = async (form: "" | "CORPORATE" | "INDIVIDUAL") => {
    setBusy("rule");
    try {
      const result = await setLegalForm({ data: { leadId, form, note } });
      if (!result.success) return void toast(result.error);
      toast(form ? `Recorded: ${LEGAL_FORM_LABEL[form].toLowerCase()} — your ruling.` : "Your ruling was cleared.");
      setRuling("");
      setNote("");
      await onChanged();
    } catch (error) {
      toast(friendlyServerError(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="flex flex-col gap-2" onClick={stop}>
      <div className="flex flex-wrap items-center gap-2">
        <LegalFormBadge legal={legal} />
        {!compact ? <span className="text-xs text-muted">{legal.reasons[0]?.text}</span> : null}
      </div>
      {legal.basis !== "override" && legal.form !== "CORPORATE" ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void check()}>
            {busy === "check" ? <Loader2 className="animate-spin" /> : <Search />}
            Check Companies House
          </Button>
          <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => setRuling(ruling === "CORPORATE" ? "" : "CORPORATE")}>
            It&apos;s a company
          </Button>
          <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => setRuling(ruling === "INDIVIDUAL" ? "" : "INDIVIDUAL")}>
            Sole trader
          </Button>
        </div>
      ) : null}
      {legal.basis === "override" ? (
        <button type="button" className="self-start text-xs text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => void save("")}>
          Clear your ruling
        </button>
      ) : null}
      {ruling ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <label className="text-xs text-muted" htmlFor={`note-${leadId}`}>
            {ruling === "CORPORATE"
              ? "How do you know it is a company? (e.g. its number on the register) — this is recorded as your ruling"
              : "Optional: why (e.g. they told you on the phone)"}
          </label>
          <Input id={`note-${leadId}`} value={note} onChange={(event) => setNote(event.target.value)} className="h-10" />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy === "rule" || (ruling === "CORPORATE" && note.trim().length < 3)} onClick={() => void save(ruling)}>
              <Check /> Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRuling("")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {candidates ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="text-xs text-muted">Several companies could be this business. Pick the right one — or none.</p>
          {candidates.map((candidate) => (
            <div key={candidate.companyNumber} className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium">
                  {candidate.legalName} <span className="text-subtle tabular">{candidate.companyNumber}</span>
                </p>
                <p className="text-xs text-muted">
                  {candidate.companyStatus} · {candidate.address}
                </p>
                <p className="text-xs text-subtle">{candidate.reasons.join(", ")}</p>
              </div>
              <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void confirm(candidate.companyNumber)}>
                {busy === candidate.companyNumber ? <Loader2 className="animate-spin" /> : null}
                This one
              </Button>
            </div>
          ))}
          <button type="button" className="self-start text-xs text-muted hover:text-fg" onClick={() => setCandidates(null)}>
            None of these
          </button>
        </div>
      ) : null}
    </div>
  );
}
