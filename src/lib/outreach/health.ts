/**
 * System health — derived from facts the rest of the app already holds.
 *
 * Nothing here pings a third party. A HEALTHY Gmail tile means the stored
 * connection is healthy, not that Google was just asked. That is deliberate:
 * a diagnostics page that itself spends quota would lie the moment it is open.
 */
import { decideProspect } from "../decision.ts";
import type { Lead } from "../leads.ts";
import { sentToday } from "./limits.ts";
import type { GmailConnection, OutreachEmail, OutreachLead } from "./types.ts";

export const HEALTH_LEVELS = ["HEALTHY", "WARNING", "ERROR", "OFF"] as const;
export type HealthLevel = (typeof HEALTH_LEVELS)[number];

export type HealthItem = {
  id: string;
  label: string;
  level: HealthLevel;
  detail: string;
};

export type HealthReport = {
  items: HealthItem[];
  bottleneck: string;
  sentToday: number;
  failedToday: number;
  lastError: string;
};

export type HealthInput = {
  database: "neon" | "pglite" | "none";
  connection: GmailConnection;
  leads: readonly OutreachLead[];
  emails: readonly OutreachEmail[];
  aiAvailable: boolean;
  now?: Date;
};

export function assessHealth(input: HealthInput): HealthReport {
  const now = input.now ?? new Date();
  const items: HealthItem[] = [];

  if (input.database === "neon") {
    items.push({ id: "database", label: "Database", level: "HEALTHY", detail: "Postgres is configured and in use." });
  } else if (input.database === "pglite") {
    items.push({
      id: "database",
      label: "Database",
      level: "WARNING",
      detail: "Preview storage — it resets when the server restarts.",
    });
  } else {
    items.push({
      id: "database",
      label: "Database",
      level: "ERROR",
      detail: "No DATABASE_URL. Outreach cannot persist.",
    });
  }

  items.push({
    id: "search",
    label: "Lead search",
    level: "HEALTHY",
    detail: "OpenStreetMap and Companies House. Nothing is invented.",
  });

  const withSite = input.leads.filter((lead) => lead.website.trim()).length;
  const checked = input.leads.filter((lead) => lead.websiteCheckedAt.trim()).length;
  items.push({
    id: "website",
    label: "Website analysis",
    level: withSite > 0 && checked === 0 ? "WARNING" : "HEALTHY",
    detail:
      withSite === 0
        ? "No websites on the sheet yet."
        : `${checked} of ${withSite} sites have been checked.`,
  });

  const withEmail = input.leads.filter((lead) => lead.email.trim()).length;
  const calls = input.leads.filter((lead) => decideProspect(lead as Lead).level === "CALL").length;
  items.push({
    id: "email",
    label: "Email discovery",
    level: input.leads.length > 8 && withEmail === 0 ? "WARNING" : "HEALTHY",
    detail:
      withEmail === 0
        ? calls > 0
          ? `No public emails yet. ${calls} strong prospect${calls === 1 ? "" : "s"} are on the call list instead.`
          : "No public emails on the sheet. Addresses are never guessed."
        : `${withEmail} public email${withEmail === 1 ? "" : "s"} found. Never guessed.`,
  });

  items.push({
    id: "qualify",
    label: "AI qualification",
    level: "HEALTHY",
    detail: "Rules-based opportunity scores, with named reasons.",
  });

  items.push({
    id: "personalise",
    label: "AI personalisation",
    level: input.aiAvailable ? "HEALTHY" : "WARNING",
    detail: input.aiAvailable
      ? "xAI is configured. Drafts still go through the quality gate."
      : "No XAI_API_KEY — drafts use the templates and say so.",
  });

  if (!input.connection.configured) {
    items.push({
      id: "gmail",
      label: "Gmail OAuth",
      level: "OFF",
      detail: "GOOGLE_CLIENT_ID is not set on this deployment.",
    });
  } else if (input.connection.status === "connected") {
    items.push({
      id: "gmail",
      label: "Gmail OAuth",
      level: "HEALTHY",
      detail: `Connected as ${input.connection.email}.`,
    });
  } else if (input.connection.status === "needs_attention") {
    items.push({
      id: "gmail",
      label: "Gmail OAuth",
      level: "ERROR",
      detail: input.connection.lastError || "Needs reconnecting.",
    });
  } else {
    items.push({
      id: "gmail",
      label: "Gmail OAuth",
      level: "WARNING",
      detail: "OAuth is configured but no mailbox is connected.",
    });
  }

  const sent = sentToday(input.emails, now);
  const failedToday = input.emails.filter((email) => {
    if (email.status !== "failed") return false;
    if (!email.updatedAt) return false;
    return email.updatedAt.slice(0, 10) === now.toISOString().slice(0, 10);
  }).length;
  const lastFailed = [...input.emails].reverse().find((email) => email.status === "failed");

  items.push({
    id: "sending",
    label: "Email sending",
    level: failedToday > 0 ? "WARNING" : input.connection.status === "connected" ? "HEALTHY" : "OFF",
    detail:
      failedToday > 0
        ? `${failedToday} failed today. Sent ${sent}.`
        : `Sent ${sent} today. Limit is counted from what actually went out.`,
  });

  const replied = input.emails.filter((email) => email.status === "replied").length;
  items.push({
    id: "replies",
    label: "Reply detection",
    level: input.connection.status === "connected" ? "HEALTHY" : "OFF",
    detail:
      input.connection.status === "connected"
        ? replied > 0
          ? `${replied} thread${replied === 1 ? "" : "s"} marked replied. Replies are never auto-answered.`
          : "Reads threads this app created. Never sends a reply."
        : "Connect Gmail to watch for replies.",
  });

  const worst = items.find((item) => item.level === "ERROR") ?? items.find((item) => item.level === "WARNING");
  return {
    items,
    bottleneck: worst?.detail ?? "Nothing blocking.",
    sentToday: sent,
    failedToday,
    lastError: lastFailed?.error ?? input.connection.lastError ?? "",
  };
}
