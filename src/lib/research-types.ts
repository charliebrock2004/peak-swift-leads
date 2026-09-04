/**
 * The shape a researched business takes on its way from the API to the review
 * screen.
 *
 * Split out from `research.ts` because that module defines a server function:
 * anything importing it drags the server-function machinery along, and the
 * search orchestrator needs only this type.
 */
import type { Priority, WebsiteStatus } from "./leads.ts";

export type Prospect = {
  businessName: string;
  trade: string;
  town: string;
  phone: string;
  rating: number | "";
  reviews: number | "";
  website: string;
  mapsLink: string;
  websiteStatus: WebsiteStatus;
  notes: string;
  /** What the research actually saw — the evidence behind the classification. */
  source: string;
  priority: Priority;
  reason: string;
};

export type ResearchResult =
  | { ok: true; prospects: Prospect[]; location: string; businessType: string }
  | { ok: false; error: string };
