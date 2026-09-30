/**
 * Why a prospect cannot be emailed, as a sentence that says what to do.
 *
 * Shared by the send engine (the reason stored on a blocked email) and every
 * screen that explains a refusal, so the words never disagree. Pure.
 */
/** The actionable sentence for each eligibility refusal. */
export function blockedSentence(reason: string): string {
  switch (reason) {
    case "no-email":
      return "there is no public email address for this business";
    case "invalid-email":
      return "the email address does not look valid";
    case "low-confidence":
      return "the public email could not be verified (confidence too low)";
    case "guessed-email":
      return "the email address was guessed, not found published";
    case "unsubscribed":
      return "this business asked not to be contacted";
    case "suppressed":
      return "this recipient has previously opted out (suppression list)";
    case "already-contacted":
      return "this business has already been emailed";
    case "not-interested":
      return "this business is marked Not Interested";
    case "booked":
      return "this business is already booked";
    case "won":
      return "this business is already a customer";
    case "replied":
      return "they have replied — answer them from Gmail instead";
    case "no-opportunity":
      return "their website is already good, so there is nothing honest to offer";
    case "low-opportunity":
      return "the opportunity is too low (turn on 'Include low opportunity' to allow it)";
    case "manual-review":
      return "it isn't confirmed as a company (sole traders need consent for email) — check it on Companies House, or call instead";
    case "individual-subscriber":
      return "it looks like a sole trader or partnership, who needs to have consented to email — call instead";
    case "personal-mailbox":
      return "the address is a personal mailbox, so its holder is an individual subscriber — call instead";
    case "undeliverable":
      return "the email verifier says this mailbox does not exist";
    default:
      return reason;
  }
}

