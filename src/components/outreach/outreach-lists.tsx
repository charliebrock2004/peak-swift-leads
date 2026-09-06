import { useMemo, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OutreachActions } from "@/components/outreach/outreach-panel";
import type { OutreachState } from "@/lib/outreach/server";

/**
 * Replies, and the people who asked to be left alone.
 *
 * Both are read-only on purpose. A reply is yours to answer, not the app's, and
 * a suppression cannot be undone from here — the whole point of it is that it
 * survives a stray tap.
 */
export function OutreachLists({
  state,
  busy,
  actions,
}: {
  state: OutreachState;
  busy: string;
  actions: OutreachActions;
}) {
  const [query, setQuery] = useState("");

  const replied = useMemo(
    () =>
      state.emails
        .filter((email) => email.status === "replied")
        .sort((a, b) => (b.repliedAt || b.sentAt).localeCompare(a.repliedAt || a.sentAt)),
    [state.emails],
  );

  const suppression = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return state.suppression;
    return state.suppression.filter(
      (entry) =>
        entry.email.toLowerCase().includes(needle) || entry.businessName.toLowerCase().includes(needle),
    );
  }, [state.suppression, query]);

  return (
    <section className="flex flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-xl font-medium">
            {replied.length} repl{replied.length === 1 ? "y" : "ies"}
          </h3>
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            disabled={busy !== "" || state.connection.status !== "connected"}
            onClick={() => void actions.checkReplies()}
          >
            {busy === "replies" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Check now
          </Button>
        </div>
        <p className="mt-1 text-sm text-muted">
          Follow-ups stop as soon as somebody writes back. Reply from Gmail — the app never answers for you.
        </p>

        {replied.length === 0 ? (
          <div className="mt-3 rounded-xl bg-surface px-5 py-10 text-center shadow-(--shadow-border)">
            <p className="text-sm text-muted">No replies yet.</p>
          </div>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {replied.map((email) => (
              <li key={email.id} className="lead-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="truncate leading-snug font-medium">{email.businessName}</h4>
                    <p className="truncate text-sm text-muted">{email.recipient}</p>
                    <p className="mt-1 text-xs text-subtle">
                      Sent {email.sentAt ? new Date(email.sentAt).toLocaleDateString("en-GB") : "—"}
                      {email.repliedAt ? ` · replied ${new Date(email.repliedAt).toLocaleDateString("en-GB")}` : ""}
                    </p>
                    <p className="mt-2 text-sm text-muted">{email.subject}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg">
                    Replied
                  </span>
                </div>
                <div className="mt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== ""}
                    onClick={() => void actions.unsubscribe(email.leadId, email.recipient, "Asked to stop")}
                  >
                    Mark do-not-contact
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="font-display text-xl font-medium">
          {state.suppression.length} unsubscribed
        </h3>
        <p className="mt-1 text-sm text-muted">
          Permanent. These addresses are refused before an email is written, approved or sent, and a
          suppression outlives the lead it came from.
        </p>

        <div className="relative mt-3">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <Input
            className="h-11 bg-surface pl-10"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search suppressed addresses…"
            aria-label="Search suppressed contacts"
          />
        </div>

        {suppression.length === 0 ? (
          <div className="mt-3 rounded-xl bg-surface px-5 py-10 text-center shadow-(--shadow-border)">
            <p className="text-sm text-muted">
              {state.suppression.length === 0 ? "Nobody has asked to be left alone." : "Nothing matches that."}
            </p>
          </div>
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5">
            {suppression.map((entry) => (
              <li key={entry.email} className="rounded-md bg-surface px-3 py-2.5 shadow-(--shadow-border)">
                <p className="truncate text-sm font-medium">{entry.businessName || entry.email}</p>
                <p className="truncate text-xs text-muted">{entry.email}</p>
                <p className="mt-0.5 text-xs text-subtle">
                  {entry.reason}
                  {entry.createdAt ? ` · ${new Date(entry.createdAt).toLocaleDateString("en-GB")}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
