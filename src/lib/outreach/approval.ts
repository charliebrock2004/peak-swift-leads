/**
 * What pressing Approve should do.
 *
 * This used to live inside the `setEmailDecision` handler, which meant it could
 * not be unit-tested at all — and that is precisely how a bug shipped in which
 * every draft containing the word "slow" was silently refused. The rules are
 * the same rules; what changes is that they are now reachable by a test.
 *
 * Pure: no database, no network. The caller loads the email and the lead and
 * writes the status; this decides, and explains itself when it refuses.
 *
 * Approving is the moment a person says "send this", so it re-checks rather
 * than trusts: eligibility, suppression, quality and terminal status are all
 * examined again here even though generation checked them earlier. Nothing here
 * sends anything — the furthest it goes is choosing a status to store.
 */
import { checkEligibility, type EligibilityContext } from "./eligibility.ts";
import { checkEmailQuality } from "./quality.ts";
import type { OutreachEmail, OutreachLead } from "./types.ts";

export type ApprovalDecision = "approve" | "queue" | "skip";

export type ApprovalOutcome =
  /** Store this status. `queued` is the one the send batch picks up. */
  | { action: "store"; status: "approved" | "queued" | "skipped" }
  /** Change nothing, and tell the person why in these words. */
  | { action: "refuse"; reason: string };

/**
 * Statuses that can never be walked back.
 *
 * A sent email is a thing that happened to somebody's inbox. Re-approving one
 * would mean sending it twice, and "sending" is mid-flight, so touching it
 * would race the sender.
 */
const TERMINAL: readonly string[] = ["sent", "replied", "sending"];

/**
 * Decide one email.
 *
 * `email` may be null because the id came from a browser that has since gone
 * stale — a refusal, never a silent skip. A silent skip was the second half of
 * the approve bug: the server answered `changed: 0, refused: []`, so the UI had
 * nothing to show and the button appeared to do nothing at all.
 */
export function decideApproval(input: {
  decision: ApprovalDecision;
  email: OutreachEmail | null;
  lead: OutreachLead | null;
  context: EligibilityContext;
  suppressed: ReadonlySet<string>;
}): ApprovalOutcome {
  const { decision, email, lead } = input;

  if (!email) {
    return { action: "refuse", reason: "that email no longer exists — reload and try again" };
  }
  if (TERMINAL.includes(email.status)) {
    return {
      action: "refuse",
      reason: `${email.businessName}: already ${email.status === "sending" ? "being sent" : email.status}`,
    };
  }

  // Skipping is always allowed on a live email: choosing not to contact someone
  // never needs to pass a check.
  if (decision === "skip") return { action: "store", status: "skipped" };

  if (!lead) return { action: "refuse", reason: `${email.businessName}: the lead is gone` };

  const eligibility = checkEligibility(lead, input.context, email.kind);
  if (!eligibility.eligible) {
    return { action: "refuse", reason: `${email.businessName}: ${eligibility.reasons[0]}` };
  }

  const verdict = checkEmailQuality({
    subject: email.subject,
    body: email.body,
    recipient: email.recipient,
    lead,
    suppressed: input.suppressed,
  });
  if (!verdict.ok) {
    return { action: "refuse", reason: `${email.businessName}: ${verdict.problems[0]!.message}` };
  }

  // Approving an already-approved email is a no-op that still reports success:
  // a double tap, or two tabs, must not read as a failure.
  return { action: "store", status: decision === "queue" ? "queued" : "approved" };
}

/** Statuses the send batch will pick up. The queue's definition of "ready". */
export const READY_TO_SEND: readonly string[] = ["queued"];

/** Is this email waiting to be sent? */
export function isReadyToSend(email: Pick<OutreachEmail, "status">): boolean {
  return READY_TO_SEND.includes(email.status);
}

/** How many emails are ready. The number under the Send button. */
export function readyCount(emails: readonly Pick<OutreachEmail, "status">[]): number {
  return emails.filter(isReadyToSend).length;
}
