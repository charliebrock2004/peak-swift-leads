/**
 * The batch runner the browser uses: one call to the research server function
 * per batch.
 *
 * Kept apart from `@/lib/prospect-search` so the sweep logic stays free of the
 * server-function import and can be unit-tested with a stub runner.
 */
import type { BatchResult, RunBatch } from "@/lib/prospect-search";
import { researchProspects } from "@/lib/research";

export const runResearchBatch: RunBatch = async (request): Promise<BatchResult> => {
  try {
    const result = await researchProspects({
      data: {
        location: request.area,
        context: request.context,
        businessType: request.businessType,
        limit: request.limit,
        exclude: request.exclude,
      },
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, prospects: result.prospects };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Research call failed",
    };
  }
};
