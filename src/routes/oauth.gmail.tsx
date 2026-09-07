import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { completeGmailConnect } from "@/lib/outreach/server";
import { OAUTH_STATE_KEY } from "@/lib/outreach/oauth-state";

export const Route = createFileRoute("/oauth/gmail")({ component: GmailCallback });

/**
 * Where Google sends the browser back after you approve access.
 *
 * The one-time code arrives in the URL and is handed straight to the server,
 * which is the only place that holds the client secret and the only place a
 * token ever exists. Nothing sensitive is stored in the browser.
 *
 * `state` is checked first: it proves this redirect belongs to a flow this
 * browser started, rather than a link someone sent you.
 */
function GmailCallback() {
  const [status, setStatus] = useState<"working" | "done" | "failed">("working");
  const [message, setMessage] = useState("Finishing the Gmail connection…");
  const [account, setAccount] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function finish() {
      const params = new URLSearchParams(window.location.search);
      const denied = params.get("error");
      if (denied) {
        if (!cancelled) {
          setStatus("failed");
          setMessage(denied === "access_denied" ? "Access was not granted." : `Google returned: ${denied}`);
        }
        return;
      }

      const code = params.get("code") ?? "";
      const returnedState = params.get("state") ?? "";
      let expectedState = "";
      try {
        expectedState = window.sessionStorage.getItem(OAUTH_STATE_KEY) ?? "";
      } catch {
        expectedState = "";
      }

      if (!code) {
        if (!cancelled) {
          setStatus("failed");
          setMessage("Google did not send an authorisation code.");
        }
        return;
      }
      if (!expectedState || returnedState !== expectedState) {
        if (!cancelled) {
          setStatus("failed");
          setMessage("That sign-in did not start from this browser. Start again from Outreach → Settings.");
        }
        return;
      }

      try {
        window.sessionStorage.removeItem(OAUTH_STATE_KEY);
      } catch {
        /* nothing to clean up */
      }

      const result = await completeGmailConnect({ data: { code, origin: window.location.origin } });
      if (cancelled) return;
      if (!result.ok) {
        setStatus("failed");
        setMessage(result.error);
        return;
      }
      setStatus("done");
      setAccount(result.connection.email);
      setMessage("Gmail is connected.");
      // Clear the code out of the address bar so it is not left in history.
      window.history.replaceState({}, "", "/oauth/gmail");
    }

    void finish();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 text-fg">
      <div className="w-full max-w-sm rounded-xl bg-surface px-6 py-8 text-center shadow-(--shadow-border)">
        <p className="text-xs font-medium tracking-widest text-muted uppercase">Peak Swift</p>
        {status === "working" ? <Loader2 className="mx-auto mt-4 size-6 animate-spin text-muted" /> : null}
        {status === "done" ? <CheckCircle2 className="mx-auto mt-4 size-6 text-fg" /> : null}
        {status === "failed" ? <TriangleAlert className="mx-auto mt-4 size-6 text-hot" /> : null}
        <h1 className="mt-4 font-display text-xl font-medium">
          {status === "done" ? "Connected" : status === "failed" ? "Could not connect" : "Connecting"}
        </h1>
        <p className="mt-2 text-sm text-muted">{message}</p>
        {account ? <p className="mt-1 text-sm tabular-nums text-fg">{account}</p> : null}
        <a
          href="/"
          className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg"
        >
          Back to leads
        </a>
      </div>
    </div>
  );
}
