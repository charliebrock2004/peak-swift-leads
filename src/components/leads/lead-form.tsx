import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PriorityBadge } from "@/components/leads/priority-badge";
import { WebsiteStatusBadge } from "@/components/leads/website-status";
import {
  CALLED_OPTIONS,
  CALL_RESULT_OPTIONS,
  WEBSITE_STATUS_OPTIONS,
  computePriority,
  createLead,
  formatRating,
  parseNumberInput,
  priorityReason,
  resolveWebsiteStatus,
  type CallResult,
  type CalledStatus,
  type Lead,
  type WebsiteStatus,
} from "@/lib/leads";
import { cn } from "@/lib/utils";

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

const fieldClass =
  "flex h-10 w-full rounded-md bg-bg px-3 text-sm text-fg shadow-(--shadow-border) outline-none transition-[box-shadow] duration-(--motion-quick) ease-(--ease-out) placeholder:text-subtle focus-visible:shadow-(--shadow-focus)";

export function LeadFormDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: Lead | null;
  onSave: (lead: Lead) => void;
}) {
  const [draft, setDraft] = useState<Lead>(() => initial ?? createLead());

  useEffect(() => {
    if (open) setDraft(initial ?? createLead());
  }, [open, initial]);

  function patch(next: Partial<Lead>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft.businessName.trim()) return;
    onSave({ ...draft, businessName: draft.businessName.trim() });
    onOpenChange(false);
  }

  const priority = computePriority(draft);
  const editing = Boolean(initial);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit lead" : "Add lead"}</DialogTitle>
            <DialogDescription>
              Priority updates from website status, reviews and rating.
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 gap-3 overflow-y-auto px-5 py-1 sm:grid-cols-2">
            <Field label="Business name" className="sm:col-span-2">
              <Input
                id="lead-name"
                autoFocus
                required
                value={draft.businessName}
                onChange={(event) => patch({ businessName: event.target.value })}
                placeholder="The Wee Bakehouse"
              />
            </Field>
            <Field label="Trade">
              <Input
                id="lead-trade"
                list="trade-list"
                value={draft.trade}
                onChange={(event) => patch({ trade: event.target.value })}
                placeholder="Plumber"
              />
            </Field>
            <Field label="Town">
              <Input
                id="lead-town"
                list="town-list"
                value={draft.town}
                onChange={(event) => patch({ town: event.target.value })}
                placeholder="Crieff"
              />
            </Field>
            <Field label="Phone number">
              <Input
                id="lead-phone"
                inputMode="tel"
                value={draft.phone}
                onChange={(event) => patch({ phone: event.target.value })}
                placeholder="01764 652184"
              />
            </Field>
            <Field label="Email">
              <Input
                id="lead-email"
                type="email"
                inputMode="email"
                value={draft.email}
                onChange={(event) => patch({ email: event.target.value })}
                placeholder="hello@business.co.uk"
              />
            </Field>
            <Field label="Google Maps link" className="sm:col-span-2">
              <Input
                value={draft.mapsLink}
                onChange={(event) => patch({ mapsLink: event.target.value })}
                placeholder="Optional — built from name + town"
              />
            </Field>
            <Field label="Google rating">
              <Input
                id="lead-rating"
                type="number"
                min={0}
                max={5}
                step={0.1}
                value={formatRating(draft.rating)}
                onChange={(event) => patch({ rating: parseNumberInput(event.target.value, 1) })}
                placeholder="4.8"
              />
            </Field>
            <Field label="Number of reviews">
              <Input
                id="lead-reviews"
                type="number"
                min={0}
                step={1}
                value={draft.reviews}
                onChange={(event) => patch({ reviews: parseNumberInput(event.target.value) })}
                placeholder="24"
              />
            </Field>
            <Field label="Website" className="sm:col-span-2">
              <Input
                value={draft.website}
                onChange={(event) => patch({ website: event.target.value })}
                placeholder="Independent site, social URL, or blank"
              />
            </Field>
            <Field label="Website status" className="sm:col-span-2">
              <select
                className={fieldClass}
                value={resolveWebsiteStatus(draft)}
                onChange={(event) =>
                  patch({ websiteStatus: event.target.value as WebsiteStatus })
                }
              >
                {WEBSITE_STATUS_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Called?">
              <select
                className={fieldClass}
                value={draft.called}
                onChange={(event) => patch({ called: event.target.value as CalledStatus })}
              >
                {CALLED_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Call result">
              <select
                className={fieldClass}
                value={draft.callResult}
                onChange={(event) => patch({ callResult: event.target.value as CallResult })}
              >
                <option value="">—</option>
                {CALL_RESULT_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Follow-up date">
              <Input
                type="date"
                value={draft.followUpDate}
                onChange={(event) => patch({ followUpDate: event.target.value })}
              />
            </Field>
            <Field label="Demo site" className="sm:col-span-2">
              <Input
                value={draft.demoUrl}
                onChange={(event) => patch({ demoUrl: event.target.value })}
                placeholder="Link to the demo you built for them"
              />
            </Field>
            <div className="flex flex-col justify-end gap-2 pb-1 sm:col-span-2">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                Ranked
                <PriorityBadge priority={priority} />
                <WebsiteStatusBadge status={resolveWebsiteStatus(draft)} />
              </div>
              <p className="text-sm text-muted">{priorityReason(draft)}</p>
            </div>
            <Field label="Notes" className="sm:col-span-2">
              <textarea
                rows={3}
                value={draft.notes}
                onChange={(event) => patch({ notes: event.target.value })}
                className="w-full resize-y rounded-md bg-bg px-3 py-2 text-sm text-fg shadow-(--shadow-border) outline-none placeholder:text-subtle focus-visible:shadow-(--shadow-focus)"
                placeholder="Who you spoke to, what they said"
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">{editing ? "Save lead" : "Add lead"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
