/**
 * Plain formatting helpers shared by the screens — no components here, so the
 * component modules stay hot-reloadable.
 */
import { resolveWebsiteStatus, type Lead } from "@/lib/leads";
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

export function websiteLine(lead: OutreachLead): string {
  const status = resolveWebsiteStatus(lead as Lead);
  if (status === "No Website Found") return "No independent website found";
  if (status === "Social Only") return "Social media page only";
  if (status === "Directory Only") return "Directory listings only";
  if (status === "Unclear") return lead.website ? lead.website : "Not confirmed either way";
  return lead.website || "Has a website";
}

export function statusTone(status: string): "good" | "info" | "bad" | "warn" | "neutral" {
  if (status === "done") return "good";
  if (status === "running") return "info";
  if (status === "failed") return "bad";
  if (status === "stopped" || status === "interrupted") return "warn";
  return "neutral";
}
