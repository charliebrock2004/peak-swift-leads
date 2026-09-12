/**
 * Outreach — the shapes everything else agrees on.
 *
 * Kept dependency-free (bar the `Lead` type) so both the browser and the server
 * functions can import it, and so the rules modules stay unit-testable without a
 * database or a network.
 */
import type { Lead } from "../leads.ts";

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

export const EMAIL_KINDS = ["initial", "follow-up-1", "follow-up-2"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

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
};

export type GmailStatus = "connected" | "needs_attention" | "disconnected";

/** What the browser is allowed to know about the Gmail connection. Never a token. */
export type GmailConnection = {
  email: string;
  status: GmailStatus;
  lastError: string;
  connectedAt: string;
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
>;
