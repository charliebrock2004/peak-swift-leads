import { createContext, useContext } from "react";
import type { OutreachState } from "@/lib/outreach/server";
import type { SetupReason } from "@/lib/outreach/setup-state";
import type { EligibilityContext } from "@/lib/outreach/eligibility";
import type { useProspectRun } from "./use-prospect-run";

export type AppData = {
  state: OutreachState | null;
  loading: boolean;
  /** Why outreach cannot load, when it cannot. */
  setup: SetupReason | null;
  error: string;
  reload: () => Promise<void>;
  context: EligibilityContext | null;
  prospecting: ReturnType<typeof useProspectRun>;
};

export const AppDataContext = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const value = useContext(AppDataContext);
  if (!value) throw new Error("useAppData must be used inside AppDataProvider");
  return value;
}
