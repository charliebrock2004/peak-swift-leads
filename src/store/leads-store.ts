import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createLead, migrateLead, SAMPLE_LEADS, type Lead } from "@/lib/leads";

type LeadsState = {
  leads: Lead[];
  addLead: (partial?: Partial<Lead>) => string;
  addLeads: (partials: Partial<Lead>[]) => number;
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
      addLeads: (partials) => {
        const leads = partials.map((partial) => createLead(partial));
        if (leads.length === 0) return 0;
        set({ leads: [...leads, ...get().leads] });
        return leads.length;
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
    {
      name: "peak-swift-leads-v1",
      version: 2,
      merge: (persisted, current) => {
        const incoming = persisted as { leads?: Partial<Lead>[] } | undefined;
        const leads = Array.isArray(incoming?.leads)
          ? incoming.leads.map((lead) => migrateLead(lead))
          : current.leads;
        return { ...current, leads };
      },
      migrate: (persisted, _version) => {
        const state = persisted as { leads?: Partial<Lead>[] };
        const leads = Array.isArray(state.leads) ? state.leads.map((lead) => migrateLead(lead)) : SAMPLE_LEADS;
        return { leads } as LeadsState;
      },
    },
  ),
);
