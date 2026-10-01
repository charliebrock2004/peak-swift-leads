/**
 * Plain formatting helpers shared by the screens — no components here, so the
 * component modules stay hot-reloadable.
 */
import { websiteVerificationOf } from "@/lib/audit/website-state";
import type { OutreachLead } from "@/lib/outreach/types";

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "accent";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
  info: "text-info",
  accent: "text-fg",
};

export function toneText(tone: Tone): string {
  return TONE_TEXT[tone];
}

/** A plural that reads naturally: "1 email", "3 emails". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const seconds = Math.round((now.getTime() - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * The website, as far as it is actually known. "No independent website" only
 * when a recent search found none — a listing without a website field just
 * says so (audit/website-state.ts).
 */
export function websiteLine(lead: OutreachLead): string {
  const verified = websiteVerificationOf(lead);
  const host = lead.website.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  switch (verified.state) {
    case "VERIFIED_NO_WEBSITE":
      return "No independent website found";
    case "SOCIAL_ONLY":
      return verified.canClaimNoWebsite ? "Social media only — no website found" : "Social media page";
    case "DIRECTORY_ONLY":
      return verified.canClaimNoWebsite ? "Directory listings only — no website found" : "Directory listing";
    case "WEBSITE_UNREACHABLE":
      return `${host} — could not be reached`;
    case "WEBSITE_FOUND":
      return host;
    default:
      return host ? `${host} (not verified)` : "No website listed — not searched yet";
  }
}

export function statusTone(status: string): "good" | "info" | "bad" | "warn" | "neutral" {
  if (status === "done") return "good";
  if (status === "running") return "info";
  if (status === "failed") return "bad";
  if (status === "stopped" || status === "interrupted") return "warn";
  return "neutral";
}
