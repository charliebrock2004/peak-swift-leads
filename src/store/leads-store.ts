import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createLead, SAMPLE_LEADS, type Lead } from "@/lib/leads";

type LeadsState = {
  leads: Lead[];
  addLead: (partial?: Partial<Lead>) => string;
  updateLead: (id: string, patch: Partial<Lead>) => void;
  removeLead: (id: string) => void;
};

export const useLeadsStore = create<LeadsState>()(
  persist(
    (set, get) => ({
      leads: SAMPLE_LEADS,
      addLead: (partial = {}) => {
        const lead = createLead(partial);
        set({ leads: [lead, ...get().leads] });
        return lead.id;
      },
      updateLead: (id, patch) => {
        set({
          leads: get().leads.map((lead) => (lead.id === id ? { ...lead, ...patch } : lead)),
        });
      },
      removeLead: (id) => {
        set({ leads: get().leads.filter((lead) => lead.id !== id) });
      },
    }),
    { name: "peak-swift-leads-v1" },
  ),
);
