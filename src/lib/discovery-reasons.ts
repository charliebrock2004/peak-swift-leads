/**
 * Why a row a discovery source returned is not a business worth considering.
 * Every refused row is counted under exactly one of these, so a run can say
 * what happened to every listing it saw — not only the ones it kept.
 *
 * Client-safe and dependency-free: the sources count with it on the server,
 * and the Find screen labels with it.
 */
export const REJECT_REASONS = ["chain", "not_a_business", "wrong_trade", "outside_area", "inactive"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export type RejectTally = Record<RejectReason, number>;

export function emptyRejectTally(): RejectTally {
  return { chain: 0, not_a_business: 0, wrong_trade: 0, outside_area: 0, inactive: 0 };
}

export function addRejects(into: RejectTally, from: Partial<RejectTally> | undefined): RejectTally {
  for (const reason of REJECT_REASONS) into[reason] += from?.[reason] ?? 0;
  return into;
}

export function rejectTotal(tally: Partial<RejectTally> | undefined): number {
  return REJECT_REASONS.reduce((sum, reason) => sum + (tally?.[reason] ?? 0), 0);
}
