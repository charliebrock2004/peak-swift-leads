import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { businessAction } from "@/lib/businesses/server";
import { friendlyServerError } from "@/lib/server-errors";

type Fields = { businessName: string; trade: string; town: string; phone: string; email: string; website: string; address: string };

const BLANK: Fields = { businessName: "", trade: "", town: "", phone: "", email: "", website: "", address: "" };

/**
 * Add a business by hand, or correct one. What you type is yours to vouch
 * for: an email entered here is recorded as "Entered by you", never as
 * something the app found.
 */
export function BusinessForm({ id, initial, onSaved, onCancel }: { id?: string; initial?: Partial<Fields>; onSaved: (id: string) => void; onCancel: () => void }) {
  const [fields, setFields] = useState<Fields>({ ...BLANK, ...initial });
  const [busy, setBusy] = useState(false);
  const set = (key: keyof Fields) => (event: React.ChangeEvent<HTMLInputElement>) => setFields((current) => ({ ...current, [key]: event.target.value }));

  const save = async () => {
    setBusy(true);
    const reply = await businessAction({ data: { action: id ? "update" : "create", id: id ?? "", fields } }).catch((error: unknown) => ({ ok: false as const, error: friendlyServerError(error) }));
    setBusy(false);
    if (!reply.ok) return void toast(reply.error);
    const saved = JSON.parse(reply.json) as { id: string; duplicate?: boolean };
    toast(saved.duplicate ? "That business is already in your list — opening it." : id ? "Saved." : "Business added.");
    onSaved(saved.id);
  };

  const field = (key: keyof Fields, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted">{label}</span>
      <Input value={fields[key]} onChange={set(key)} className="h-11" {...props} />
    </label>
  );

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {field("businessName", "Business name", { required: true, autoFocus: !id })}
      <div className="grid grid-cols-2 gap-3">
        {field("trade", "Trade")}
        {field("town", "Town")}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("phone", "Phone", { inputMode: "tel", autoComplete: "off" })}
        {field("email", "Email", { type: "email", inputMode: "email", autoComplete: "off" })}
      </div>
      {field("website", "Website", { inputMode: "url", placeholder: "https://…" })}
      {field("address", "Address")}
      <p className="text-xs text-subtle">Only add an email you know is theirs — it is recorded as entered by you.</p>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || fields.businessName.trim().length < 2}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {id ? "Save" : "Add business"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
