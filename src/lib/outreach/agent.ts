/**
 * AI-operable outreach actions.
 *
 * The handlers live in their original modules so they share the existing
 * server-function chunks (a second createServerFn module splits the production
 * SSR bundle). This file is the named API an agent should import.
 *
 * Sending still only happens through `sendQueued`. There is no agent shortcut
 * that bypasses eligibility, the quality gate, or the daily limit.
 */
export {
  getOutreachState,
  generateEmails,
  setEmailDecision,
  sendQueued,
  checkReplies,
  getCampaignStats,
  getSystemHealth,
  getActivityLog,
  getReviewQueue,
  recordLeadReview,
  getFollowups,
  saveOutreachRun,
  getRecentRuns,
  getLeads,
  getLead,
  qualifyLeads,
} from "./server.ts";
export { researchProspects } from "../research.ts";
export { checkLeadWebsite, findLeadEmail } from "../qualify-server.ts";
export { checkEligibility, emptyContext } from "./eligibility.ts";
export { describeBottleneck, tallyDecisions, decideProspect } from "../decision.ts";
export { assessHealth } from "./health.ts";
