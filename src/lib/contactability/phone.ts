/**
 * Phone numbers, and whether one may be rung for marketing.
 *
 * UK PECR: a live marketing call must not go to a number registered with the
 * TPS (individuals, including sole traders) or the CTPS (corporate bodies)
 * unless that person has said they don't object to your calls. The ICO says
 * B2B callers should screen against BOTH, because a sole trader can be on the
 * TPS and a company on the CTPS. Screening goes stale, so it is only trusted
 * for `SCREENING_VALID_DAYS`.
 *
 * Reference: https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/telephone-marketing/
 *
 * There is no public TPS/CTPS API: screening is a subscription service. So an
 * unscreened number is never presented as safe — it is CALL STATUS UNKNOWN
 * until a screening result (from your TPS service) is recorded against it.
 *
 * Client-safe and pure.
 */

export const SCREENING_VALID_DAYS = 28;

export type PhoneType = "mobile" | "landline" | "non_geographic" | "freephone" | "premium" | "personal" | "other";

export const PHONE_TYPE_LABEL: Record<PhoneType, string> = {
  mobile: "Mobile",
  landline: "Landline",
  non_geographic: "Non-geographic",
  freephone: "Freephone",
  premium: "Premium rate",
  personal: "Personal number",
  other: "Other",
};

export type NormalizedPhone = {
  /** +441764123456 */
  e164: string;
  /** 01764 123456 — for display and for typing into a phone. */
  national: string;
  type: PhoneType;
};

function typeOf(nsn: string): PhoneType {
  if (/^7[1-57-9]/.test(nsn)) return "mobile";
  if (/^70/.test(nsn)) return "personal";
  if (/^[12]/.test(nsn)) return "landline";
  if (/^80[08]/.test(nsn)) return "freephone";
  if (/^(3|8[47]|5[56])/.test(nsn)) return "non_geographic";
  if (/^9/.test(nsn)) return "premium";
  return "other";
}

function nationalFormat(nsn: string): string {
  const national = `0${nsn}`;
  // 020 / 023 / 024 / 028 / 029: 3 + 4 + 4
  if (/^2/.test(nsn)) return `${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}`;
  // Mobiles, non-geographic, freephone: 5 + 6
  if (/^[3579]|^8/.test(nsn)) return `${national.slice(0, 5)} ${national.slice(5)}`;
  // 011x / 01x1: 4 + 3 + 4
  if (/^1\d1|^11/.test(nsn)) return `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`;
  // Other geographic: 5 + rest
  return `${national.slice(0, 5)} ${national.slice(5)}`;
}

/**
 * A UK number in E.164, or null when it is not one.
 *
 * Accepts the ways numbers are written on listings and websites: spaces,
 * brackets, dashes, "+44 (0)", "0044", and a trailing extension.
 */
export function normalizeUkPhone(raw: string): NormalizedPhone | null {
  let value = (raw ?? "").trim();
  if (!value) return null;
  value = value.replace(/\s*(ext\.?|extension|x)\s*\d+\s*$/i, "");
  value = value.replace(/\(0\)/g, "");
  let digits = value.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `44${digits.slice(1)}`;
  if (!digits.startsWith("44") || /\+/.test(digits)) return null;
  let nsn = digits.slice(2);
  if (nsn.startsWith("0")) nsn = nsn.slice(1);
  // UK national significant numbers are 10 digits (9 for a few old areas).
  if (!/^\d{9,10}$/.test(nsn) || !/^[1-9]/.test(nsn)) return null;
  if (/^7/.test(nsn) && nsn.length !== 10) return null;
  return { e164: `+44${nsn}`, national: nationalFormat(nsn), type: typeOf(nsn) };
}

export type ScreeningResult = "unchecked" | "clear" | "registered";

export type PhoneScreening = {
  tps: ScreeningResult;
  ctps: ScreeningResult;
  /** ISO timestamp of the screening. */
  checkedAt: string;
  method?: string;
};

export type DoNotCall = { reason: string; source: "internal" | "objection"; createdAt?: string };

export const CALL_STATUSES = ["ELIGIBLE", "BLOCKED", "UNKNOWN"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
  ELIGIBLE: "OK to call",
  BLOCKED: "Do not call",
  UNKNOWN: "Screen first",
};

export type CallContactability = {
  status: CallStatus;
  /** Why, in order. Always at least one. */
  reasons: string[];
  phone: NormalizedPhone | null;
  /** True when a screening would change the answer (unscreened or stale). */
  needsScreening: boolean;
};

export type CallInput = {
  phone: string;
  screening?: PhoneScreening | null;
  doNotCall?: DoNotCall | null;
  callResult?: string;
  called?: string;
  unsubscribed?: string;
  outreachStatus?: string;
};

/** Outcomes that mean they asked you to ring — a call at their request, not unsolicited. */
const REQUESTED_CALL = new Set(["Callback", "Interested", "Booked", "Won"]);

export function callContactability(input: CallInput, now: Date = new Date()): CallContactability {
  const phone = normalizeUkPhone(input.phone);
  const blocked = (reason: string): CallContactability => ({ status: "BLOCKED", reasons: [reason], phone, needsScreening: false });

  if (!input.phone.trim()) return blocked("No phone number");
  if (!phone) return blocked("Not a valid UK phone number");
  if (phone.type === "premium") return blocked("Premium-rate number");
  if (input.doNotCall) {
    return blocked(
      input.doNotCall.source === "objection"
        ? `They objected to calls${input.doNotCall.reason ? `: ${input.doNotCall.reason}` : ""}`
        : `On your do-not-call list${input.doNotCall.reason ? `: ${input.doNotCall.reason}` : ""}`,
    );
  }
  if (input.callResult === "Not Interested" || input.called === "Not Interested") return blocked("Marked Not Interested");
  if (input.callResult === "Wrong Number") return blocked("Marked wrong number");
  if ((input.unsubscribed ?? "").trim() || (input.outreachStatus ?? "").trim().toLowerCase() === "unsubscribed") {
    return blocked("Asked not to be contacted");
  }

  const screening = input.screening;
  if (screening?.tps === "registered") return blocked("Registered with the TPS");
  if (screening?.ctps === "registered") return blocked("Registered with the CTPS");

  if (input.callResult && REQUESTED_CALL.has(input.callResult)) {
    return { status: "ELIGIBLE", reasons: ["They asked you to call — not an unsolicited call"], phone, needsScreening: false };
  }

  const at = Date.parse(screening?.checkedAt ?? "");
  const age = Number.isFinite(at) ? Math.floor((now.getTime() - at) / 86_400_000) : null;
  const bothClear = screening?.tps === "clear" && screening?.ctps === "clear";
  if (bothClear && age !== null && age <= SCREENING_VALID_DAYS) {
    const date = new Date(at).toISOString().slice(0, 10);
    return { status: "ELIGIBLE", reasons: [`Screened clear of TPS and CTPS on ${date}`], phone, needsScreening: false };
  }

  const reasons: string[] = [];
  if (!screening || (screening.tps === "unchecked" && screening.ctps === "unchecked")) reasons.push("Not screened against TPS and CTPS");
  else if (screening.tps === "unchecked") reasons.push("Not screened against the TPS");
  else if (screening.ctps === "unchecked") reasons.push("Not screened against the CTPS");
  else reasons.push(`Screened ${age ?? "?"} days ago — screening is valid for ${SCREENING_VALID_DAYS} days`);
  return { status: "UNKNOWN", reasons, phone, needsScreening: true };
}
