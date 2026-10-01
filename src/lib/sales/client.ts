import { friendlyServerError } from "@/lib/server-errors";
import { salesAction } from "./server";

export type ActionReply = { ok: true; json: string } | { ok: false; error: string };

/** Call `salesAction`, turning a thrown network or auth error into a reply. */
export async function runSalesAction(data: Record<string, unknown>): Promise<ActionReply> {
  return salesAction({ data: data as never }).catch((error: unknown) => ({ ok: false as const, error: friendlyServerError(error) }));
}
