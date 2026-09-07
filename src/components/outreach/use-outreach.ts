import { useCallback, useEffect, useState } from "react";
import {
  checkReplies,
  disconnectGmail,
  generateEmails,
  getOutreachState,
  saveOutreachSettings,
  saveOutreachTemplate,
  sendQueued,
  sendTestEmail,
  setEmailDecision,
  startGmailConnect,
  unsubscribeLead,
  updateDraft,
  type OutreachState,
} from "@/lib/outreach/server";
import { OAUTH_STATE_KEY } from "@/lib/outreach/oauth-state";
import { classifySetupError, type SetupReason } from "@/lib/outreach/setup-state";
import type { OutreachSettings, OutreachTemplate } from "@/lib/outreach/types";

/**
 * One place that owns outreach state and every action on it.
 *
 * Outreach is server-truth, unlike the lead sheet: eligibility, the queue and
 * the daily count all have to be decided from what the server holds, so this
 * reloads after anything that changes them rather than trying to keep a local
 * mirror in step.
 */
export function useOutreach() {
  const [state, setState] = useState<OutreachState | null>(null);
  const [error, setError] = useState("");
  /** Why outreach is unavailable, when it is — drives the setup screen. */
  const [setup, setSetup] = useState<SetupReason | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");

  const reload = useCallback(async () => {
    try {
      const next = await getOutreachState();
      if (!next.ok) {
        setError(next.error);
        setSetup(next.setup ?? classifySetupError(next.error));
        return;
      }
      setState(next);
      setError("");
      setSetup(null);
    } catch (err) {
      // The auth middleware rejects before the handler runs, so these never
      // carry the server's own classification — read it from the message.
      const message = err instanceof Error ? err.message : "Could not load outreach.";
      setError(message);
      setSetup(classifySetupError(message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Run one action with a busy label, then refresh. Errors become messages. */
  const run = useCallback(
    async <T,>(label: string, action: () => Promise<T>, refresh = true): Promise<T | null> => {
      setBusy(label);
      setError("");
      try {
        const result = await action();
        if (refresh) await reload();
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : "That did not work.");
        return null;
      } finally {
        setBusy("");
      }
    },
    [reload],
  );

  const actions = {
    /**
     * Send the browser to Google.
     *
     * The `state` is stashed first so the callback can prove the redirect
     * belongs to this flow.
     */
    connectGmail: () =>
      run(
        "connect",
        async () => {
          const started = await startGmailConnect({ data: { origin: window.location.origin } });
          if (!started.ok) {
            setError(started.error);
            return null;
          }
          try {
            window.sessionStorage.setItem(OAUTH_STATE_KEY, started.state);
          } catch {
            setError("This browser is blocking session storage, which the sign-in needs.");
            return null;
          }
          window.location.href = started.url;
          return null;
        },
        false,
      ),

    disconnectGmail: () => run("disconnect", () => disconnectGmail()),

    sendTest: (to: string) =>
      run("test", async () => {
        const result = await sendTestEmail({ data: { to } });
        if (!result.ok) setError(result.error);
        return result;
      }),

    generate: (leadIds: string[], mode: string, kind: "initial" | "follow-up-1" | "follow-up-2" = "initial") =>
      run("generate", async () => {
        const result = await generateEmails({ data: { leadIds, mode, kind } });
        if (!result.ok) setError(result.error);
        return result;
      }),

    decide: (ids: string[], decision: "approve" | "queue" | "skip") =>
      run(decision, async () => {
        const result = await setEmailDecision({ data: { ids, decision } });
        if (!result.ok) setError(result.error);
        else if (result.refused.length > 0) setError(result.refused.join(" · "));
        return result;
      }),

    saveDraft: (id: string, subject: string, body: string) =>
      run("save", async () => {
        const result = await updateDraft({ data: { id, subject, body } });
        if (!result.ok) setError(result.error);
        return result;
      }),

    send: () =>
      run("send", async () => {
        const result = await sendQueued();
        if (!result.ok) setError(result.error);
        else if (result.stopped) setError(result.stopped);
        return result;
      }),

    checkReplies: () =>
      run("replies", async () => {
        const result = await checkReplies();
        if (!result.ok) setError(result.error);
        return result;
      }),

    unsubscribe: (leadId: string, email: string, reason: string) =>
      run("unsubscribe", async () => {
        const result = await unsubscribeLead({ data: { leadId, email, reason } });
        if (!result.ok) setError(result.error);
        return result;
      }),

    saveSettings: (settings: Partial<OutreachSettings>) =>
      run("settings", async () => {
        const result = await saveOutreachSettings({ data: settings });
        if (!result.ok) setError(result.error);
        return result;
      }),

    saveTemplate: (template: OutreachTemplate) =>
      run("template", async () => {
        const result = await saveOutreachTemplate({ data: template });
        if (!result.ok) setError(result.error);
        return result;
      }),
  };

  return { state, loading, busy, error, setError, setup, reload, actions };
}
