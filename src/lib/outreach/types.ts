/**
 * Outreach — the shapes everything else agrees on.
 *
 * Kept dependency-free (bar the `Lead` type) so both the browser and the server
 * functions can import it, and so the rules modules stay unit-testable without a
 * database or a network.
 */
import { DEFAULT_CONTACT_RULES, type ContactRules } from "../contactability/legal-form.ts";
import type { Lead } from "../leads.ts";
import type { OAuthSetup } from "./oauth-setup.ts";
import type { WebsiteEvidenceRecord } from "./evidence-record.ts";

/** Where one email has got to. The queue and the history are the same list. */
export const EMAIL_STATUSES = [
  /** Generated, not yet looked at. */
  "draft",
  /** You approved it; it may be queued. */
  "approved",
  /** Waiting its turn under the daily limit. */
  "queued",
  /** Handed to Gmail right now. */
  "sending",
  "sent",
  "failed",
  /** They wrote back. Follow-ups stop. */
  "replied",
  /** They asked not to be contacted. */
  "unsubscribed",
  /** You decided not to send it. */
  "skipped",
  /** Gmail sent it and the recipient's server bounced it back. */
  "bounced",
  /** A test email to your own address. Never counted as outreach. */
  "test_sent",
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** Statuses that mean an email exists in the world, or is about to. */
export const LIVE_STATUSES: readonly EmailStatus[] = [
  "approved",
  "queued",
  "sending",
  "sent",
  "replied",
];

/** Statuses that mean Gmail actually accepted it. */
export const DELIVERED_STATUSES: readonly EmailStatus[] = ["sent", "replied"];

/** Everything Gmail accepted for a prospect, including ones that later bounced. */
export const SENT_STATUSES: readonly EmailStatus[] = ["sent", "replied", "bounced"];

export const EMAIL_KINDS = ["initial", "follow-up-1", "follow-up-2"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** Why a send did not complete — see `GmailFailureKind`. Empty when it did. */
export type FailureKind = "" | "permanent" | "transient" | "auth" | "rate_limit" | "uncertain" | "blocked";

/** What kind of message came back on the thread. */
export type ReplyKind = "" | "human" | "auto_reply" | "bounce" | "unsubscribe";

/** Where a reply conversation has got to. Set by you; suggested by the classifier. */
export const REPLY_STAGES = ["new", "interested", "needs_follow_up", "booked", "won", "not_interested"] as const;
export type ReplyStage = (typeof REPLY_STAGES)[number];

export const REPLY_STAGE_LABELS: Record<ReplyStage, string> = {
  new: "New reply",
  interested: "Interested",
  needs_follow_up: "Needs follow-up",
  booked: "Booked",
  won: "Won",
  not_interested: "Not interested",
};

export type OutreachEmail = {
  id: string;
  leadId: string;
  businessName: string;
  recipient: string;
  subject: string;
  body: string;
  status: EmailStatus;
  kind: EmailKind;
  /** "ai", "template:<id>" or "manual" — how the text came to be. */
  generatedBy: string;
  sendingAccount: string;
  gmailMessageId: string;
  gmailThreadId: string;
  error: string;
  attempts: number;
  approvedAt: string;
  sentAt: string;
  repliedAt: string;
  createdAt: string;
  updatedAt: string;
  /** The facts this email was personalised from. Empty for older rows. */
  personalisationEvidence: string;
  /** Which campaign this email was written under. Empty outside a campaign. */
  campaignId: string;
  // ── Added with the production send engine (0009). Optional so every older
  //    constructor of this type keeps compiling; the store always fills them.
  /** The RFC 822 Message-ID header — what a follow-up threads under. */
  rfc822MessageId?: string;
  /** Which AI Outreach run wrote it. */
  runId?: string;
  failureKind?: FailureKind;
  /** Gmail's answer to the send, as stored. */
  providerResponse?: string;
  sendingStartedAt?: string;
  /** One sentence: what this email was personalised from. */
  personalisationNote?: string;
  replyFrom?: string;
  replySubject?: string;
  replySnippet?: string;
  replyKind?: ReplyKind;
  replyStage?: ReplyStage | "";
  replySuggestion?: ReplyStage | "";
  bouncedAt?: string;
  autoReplyAt?: string;
};

export const TEMPLATE_KINDS = [
  "no-website",
  "improvement",
  "general",
  "follow-up-1",
  "follow-up-2",
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export type OutreachTemplate = {
  id: string;
  name: string;
  kind: TemplateKind;
  subject: string;
  body: string;
  signature: string;
};

export type OutreachSettings = {
  dailyLimit: number;
  batchSize: number;
  delaySeconds: number;
  followUpsOn: boolean;
  followUp1Days: number;
  followUp2Days: number;
  maxFollowUps: number;
  autoSend: boolean;
  /** LOW-opportunity leads are only offered when this is explicitly turned on. */
  includeLow: boolean;
  /** "ai" or a template id. */
  defaultMode: string;
  /** Where the end-to-end test sends. Empty means the connected Gmail account itself. */
  testRecipient?: string;
  /** Web searches allowed per day (each costs a search credit). */
  searchDailyBudget?: number;
  /** AI drafts allowed per day. */
  aiDailyBudget?: number;
  /** The configurable legal-form rules (see contactability/legal-form.ts). */
  contactRules?: ContactRules;
};

/** Deliberately cautious. Nothing here is a number you would regret overnight. */
export const DEFAULT_SETTINGS: OutreachSettings = {
  dailyLimit: 30,
  batchSize: 5,
  delaySeconds: 45,
  followUpsOn: false,
  followUp1Days: 4,
  followUp2Days: 7,
  maxFollowUps: 2,
  autoSend: false,
  includeLow: false,
  defaultMode: "ai",
  testRecipient: "",
  searchDailyBudget: 300,
  aiDailyBudget: 150,
  contactRules: DEFAULT_CONTACT_RULES,
};

export type GmailStatus = "connected" | "needs_attention" | "disconnected";

/** What the browser is allowed to know about the Gmail connection. Never a token. */
export type GmailConnection = {
  email: string;
  status: GmailStatus;
  lastError: string;
  connectedAt: string;
  /** When Gmail last accepted a message from this app. */
  lastSendAt?: string;
  /** The last health check, as stored (JSON), and when it ran. */
  lastHealth?: string;
  lastHealthAt?: string;
  /** False when the server has no OAuth client configured at all. */
  configured: boolean;
  /**
   * Which Google OAuth client this deployment will actually ask for, so an
   * `invalid_client` can be checked against the Google Cloud Credentials page
   * instead of guessed at. Masked; client ids are public but there is no reason
   * to leave a full one on screen. Empty when nothing is configured.
   */
  clientProject: string;
  clientMasked: string;
  /**
   * The redirect URI Google must have registered. Empty means the app derives
   * it from the address you are on, which is `<origin>/oauth/gmail`.
   */
  redirectUriOverride: string;
  /**
   * Which OAuth variables this running build cannot see, and which build it is
   * (environment, branch, commit) — so "not set up" can say whether the fix is
   * adding a variable or redeploying an older build. Names only, never values.
   */
  setup?: OAuthSetup;
  /** The only Gmail account the Connect flow will accept. */
  intendedSender?: string;
};

export type SuppressionEntry = {
  email: string;
  reason: string;
  leadId: string;
  businessName: string;
  createdAt: string;
};

/** The lead fields outreach actually reads. Keeps the rules honest about inputs. */
export type OutreachLead = Pick<
  Lead,
  | "id"
  | "businessName"
  | "trade"
  | "town"
  | "email"
  | "emailConfidence"
  | "emailSource"
  | "website"
  | "websiteStatus"
  | "websiteQuality"
  | "websiteAnalysis"
  | "websiteScore"
  | "websiteCheckedAt"
  | "phone"
  | "address"
  | "businessStatus"
  | "rating"
  | "reviews"
  | "called"
  | "callResult"
  | "outreachStatus"
  | "unsubscribed"
  | "lastEmailedAt"
  | "followUpDate"
  | "notes"
  | "mapsLink"
  | "foundAt"
  | "source"
  | "updatedAt"
> & {
  /** Stable source id ("ch:SC612222", "osm:node:1"). Optional: older callers omit it. */
  placeId?: string;
  /** When the email address was found. Optional: older callers omit it. */
  emailFoundAt?: string;
  /** Server-held facts about the business's registered identity. Absent on browser-only rows. */
  facts?: BusinessFacts;
};

/**
 * What the server knows about a business's registered identity — written only
 * by Companies House checks and by a person's override (migration 0010). The
 * browser's lead sync never writes these.
 */
export type BusinessFacts = {
  companyNumber: string;
  companyType: string;
  companyStatus: string;
  /** With no company number, a date here means "searched; no matching company". */
  companyCheckedAt: string;
  legalFormOverride: "" | "CORPORATE" | "INDIVIDUAL" | "UNKNOWN" | "REVIEW_REQUIRED";
  legalFormNote: string;
  legalFormSetAt: string;
  /** How the website was found or searched for (lead_evidence "website"). */
  websiteEvidence?: WebsiteEvidenceRecord | null;
  /** The latest website audit, summarised (website_audits, 0011). */
  audit?: AuditSummary | null;
};

export type AuditSummary = {
  id: string;
  status: "ok" | "unreachable" | "error";
  httpStatus: number;
  url: string;
  finishedAt: string;
  opportunity: "strong" | "moderate" | "low" | "none" | "unmeasured";
  points: number;
  /** The findings worth leading with: kind, heading and the measured sentence. */
  keyFindings: { kind: string; title: string; evidence: string; impact: number; observedAt: string; source: string }[];
};

/** A lead as the server reads it: the synced fields plus the server-held facts. */
export type LeadWithFacts = Lead & { facts: BusinessFacts };

export const EMPTY_FACTS: BusinessFacts = {
  companyNumber: "",
  companyType: "",
  companyStatus: "",
  companyCheckedAt: "",
  legalFormOverride: "",
  legalFormNote: "",
  legalFormSetAt: "",
};
