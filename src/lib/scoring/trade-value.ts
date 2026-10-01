/**
 * How much a website project for this kind of business is likely to be worth
 * to a local web designer — a starting point, not a fact.
 *
 * Trades that sell large jobs (roofs, extensions, kitchens) can justify a
 * proper site and pay for it; a takeaway usually lives on a delivery app. The
 * workspace profile can override the tiers (preferred / excluded trades), and
 * the prospect-quality feedback loop will tell us where this is wrong.
 *
 * Client-safe and pure.
 */

export type TradeTier = "high" | "medium" | "low" | "unknown";

const HIGH =
  /roof|build|construct|joiner|carpent|kitchen|bathroom|extension|landscap|electric|plumb|heating|gas engineer|window|glaz|driveway|paving|renovat|loft|plaster|scaffold|solar|tree surg|arborist|architect|surveyor|solicitor|lawyer|accountant|dentist|clinic|physio|vet|estate agent|removal|joinery|stonemason|fencing|decking|garden design|interior design|wedding|venue|hotel|guest ?house|b&b|holiday|cottage/i;
const MEDIUM =
  /hair|barber|beaut|salon|nail|spa|massage|therap|gym|fitness|personal train|yoga|pilates|dog|groom|pet|cafe|café|coffee|restaurant|bistro|bakery|butcher|florist|garage|mechanic|mot|tyre|car wash|valet|clean|window clean|painter|decorat|tiler|tiling|floor|carpet|gardener|handyman|locksmith|photograph|tutor|driving|childcare|nursery|tattoo|optician|pharmac|print|sign|catering|mobile|repair/i;
const LOW = /takeaway|take-away|kebab|pizza|chip shop|fish and chip|chinese|indian|burger|newsagent|off licen|convenience|vape|bookmaker|betting|charity shop|pub\b|bar\b/i;

export function tradeTier(trade: string, profile?: { preferredTrades?: readonly string[]; excludedTrades?: readonly string[] }): TradeTier | "excluded" {
  const value = (trade ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (profile?.excludedTrades?.some((entry) => entry.trim() && value.includes(entry.trim().toLowerCase()))) return "excluded";
  if (profile?.preferredTrades?.some((entry) => entry.trim() && value.includes(entry.trim().toLowerCase()))) return "high";
  if (LOW.test(value)) return "low";
  if (HIGH.test(value)) return "high";
  if (MEDIUM.test(value)) return "medium";
  return "unknown";
}

export const TRADE_TIER_LABEL: Record<TradeTier, string> = {
  high: "a trade that buys larger projects",
  medium: "a trade where a website pays its way",
  low: "a trade that rarely invests in a website",
  unknown: "trade value not known",
};
