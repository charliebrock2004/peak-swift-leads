/**
 * The outreach server functions.
 *
 * This is where policy lives: nothing else may send an email, suppress an
 * address, or move an email's status. Every one of these runs behind
 * `authMiddleware`, so `context.userId` is verified and is the only scope any
 * query ever uses.
 *
 * Two rules shape the whole file:
 *
 * 1. **The server decides who may be emailed**, from the lead row it holds —
 *    never from anything the browser sent. A client can ask to email lead X; it
 *    cannot assert that lead X is eligible.
 * 2. **Nothing reaches Gmail without passing eligibility and the quality gate
 *    again, at send time.** Approval can be minutes or days old, and a lead can
 *    reply, unsubscribe or be marked Not Interested in between.
 *
 * `@/lib/db`, the Gmail client and the store are imported *inside* handlers:
 * this module is also loaded by the browser for its server-function stubs, and
 * `pg` and the OAuth secret must never follow it there.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { newLeadId } from "@/lib/leads";
import { composeEmail, evidenceFor, parseAiDraft, type AiDraft } from "./compose.ts";
import { evidenceSummary } from "./evidence.ts";
import { decideApproval } from "./approval.ts";
import {
  campaignProblem,
  campaignTransitionProblem,
  clampCampaign,
  newCampaign,
  type Campaign,
  type CampaignStatus,
} from "./campaigns.ts";
import { checkEligibility, emptyContext, type EligibilityContext } from "./eligibility.ts";
import { allowance, nextBatch, sanitizeSettings } from "./limits.ts";
import { checkEmailQuality, readsAsUnsubscribe } from "./quality.ts";
import {
  classifySetupError,
  SETUP_COPY,
  UNDEFINED_TABLE,
  type SetupReason,
} from "./setup-state.ts";
import type { BusinessProfile } from "./profile.ts";
import {
  DEFAULT_SETTINGS,
  type EmailKind,
  type GmailConnection,
  type LeadWithFacts,
  type OutreachEmail,
  type OutreachSettings,
  type OutreachTemplate,
  type SuppressionEntry,
} from "./types.ts";

// ── shared helpers ───────────────────────────────────────────────────────────

const str = (value: unknown, max = 200): string =>
  value == null ? "" : String(value).trim().slice(0, max);

function idList(value: unknown, max = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => str(entry, 64)).filter(Boolean).slice(0, max);
}

/** The failure shape every one of these functions uses. Never throws at the UI. */
export type Fail = {
  ok: false;
  error: string;
  needsAttention?: boolean;
  /** Set when the failure is a setup problem the UI should explain, not just report. */
  setup?: SetupReason;
};

/**
 * Build the context the eligibility rules need, from what is actually stored:
 * the suppression list, and which leads and addresses already have a live email.
 */
function contextFrom(
  emails: readonly OutreachEmail[],
  suppressed: ReadonlySet<string>,
  settings: OutreachSettings,
  kind: EmailKind = "initial",
): EligibilityContext {
  const live = new Set(["approved", "queued", "sending", "sent", "replied"]);
  const alreadyContacted = new Set<string>();
  const contactedAddresses = new Set<string>();
  for (const email of emails) {
    if (email.kind !== kind || !live.has(email.status)) continue;
    alreadyContacted.add(email.leadId);
    if (email.recipient) contactedAddresses.add(email.recipient.toLowerCase());
  }
  return {
    settings: { includeLow: settings.includeLow },
    suppressed,
    alreadyContacted,
    contactedAddresses,
    rules: settings.contactRules,
  };
}

/** Every server function needs the same four things; fetch them once. */
async function loadWorld(userId: string) {
  const { getSql } = await import("@/lib/db");
  const store = await import("./store.server.ts");
  const sql = await getSql();
  const [settings, emails, suppression, templates] = await Promise.all([
    store.loadSettings(sql, userId),
    store.loadEmails(sql, userId),
    store.suppressedSet(sql, userId),
    store.loadTemplates(sql, userId),
  ]);
  return { sql, store, settings, emails, suppression, templates };
}

/**
 * Campaigns and their membership, or nothing at all.
 *
 * A deployment that has not run the campaigns migration has no campaigns —
 * which is the truth, not a failure — so a missing table returns empty rather
 * than taking down the whole outreach screen with it.
 */
async function loadCampaignWorld(
  store: typeof import("./store.server.ts"),
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
): Promise<{ campaigns: Campaign[]; campaignMembers: { campaignId: string; leadId: string }[] }> {
  try {
    const [campaigns, campaignMembers] = await Promise.all([
      store.loadCampaigns(sql, userId),
      store.loadCampaignMembers(sql, userId),
    ]);
    return { campaigns, campaignMembers };
  } catch (error) {
    if (isMissingTable(error)) return { campaigns: [], campaignMembers: [] };
    throw error;
  }
}

async function salesTools() {
  const [scoring, records, health, dash] = await Promise.all([
    import("../scoring/prospect-score.ts"),
    import("../scoring/records.ts"),
    import("./health.ts"),
    import("./dashboard.ts"),
  ]);
  return { ...scoring, ...records, assessHealth: health.assessHealth, computeStats: dash.computeStats };
}

/** Everything the prospect score needs beyond the lead itself, loaded once. */
async function scoringWorld(userId: string, settings: OutreachSettings, suppressed: ReadonlySet<string>, emails: readonly OutreachEmail[] = []) {
  const { getSql } = await import("@/lib/db");
  const contacts = await import("@/lib/contactability/store.server");
  const sql = await getSql();
  const [screenings, doNotCall] = await Promise.all([
    contacts.loadScreenings(sql, userId).catch(() => new Map()),
    contacts.loadDoNotCall(sql, userId).catch(() => new Map()),
  ]);
  const live = new Set(["approved", "queued", "sending", "sent", "replied"]);
  const contacted = new Set(emails.filter((email) => email.kind === "initial" && live.has(email.status)).map((email) => email.leadId));
  return { screenings, doNotCall, suppressed, contacted, rules: settings.contactRules };
}

// ── AI ───────────────────────────────────────────────────────────────────────

/**
 * The project's existing AI key, used for personalisation.
 *
 * Absent is not an error: `composeEmail` falls back to the templates and says
 * so. That keeps outreach fully usable with no AI configured at all.
 */
function aiGenerator(): ((prompt: string) => Promise<AiDraft | null>) | undefined {
  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const base = (process.env.XAI_API_BASE || "https://api.x.ai/v1").replace(/\/+$/, "");
  return async (prompt: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: process.env.XAI_MODEL?.trim() || "grok-4.20-0309-non-reasoning",
          input: [
            {
              role: "system",
              content:
                "You write short, honest, British-English cold emails for a one-person web design studio in Scotland. They read like a real person who has looked at the business, not like marketing. You never invent facts, numbers, conversations or compliments, and never insult anyone. Reply with JSON only.",
            },
            { role: "user", content: prompt },
          ],
          max_output_tokens: 900,
        }),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as {
        output_text?: unknown;
        output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
      };
      let text = typeof payload.output_text === "string" ? payload.output_text : "";
      if (!text) {
        const chunks: string[] = [];
        for (const item of payload.output ?? []) {
          for (const part of item.content ?? []) if (part.text) chunks.push(part.text);
        }
        text = chunks.join("\n");
      }
      return parseAiDraft(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── Gmail token handling ─────────────────────────────────────────────────────

type UsableToken = { ok: true; accessToken: string; email: string } | Fail;

/**
 * A live access token, refreshing it first if it is close to expiry.
 *
 * A fatal refresh failure marks the connection `needs_attention` and stops
 * whatever was being attempted: retrying a revoked grant can only fail again.
 */
async function usableToken(userId: string): Promise<UsableToken> {
  const { getSql } = await import("@/lib/db");
  const store = await import("./store.server.ts");
  const gmail = await import("@/lib/gmail/client.server.ts");
  const { needsRefresh } = await import("@/lib/gmail/oauth.ts");

  const sql = await getSql();
  const account = await store.loadGmailAccount(sql, userId);
  if (account?.tokenProblem) return { ok: false, error: account.tokenProblem, needsAttention: true };
  if (!account || account.status === "disconnected" || !account.refresh_token) {
    return { ok: false, error: "Gmail is not connected. Connect it in Settings → Gmail." };
  }
  const expiresAt = account.expires_at
    ? account.expires_at instanceof Date
      ? account.expires_at.toISOString()
      : String(account.expires_at)
    : "";

  if (account.access_token && !needsRefresh(expiresAt)) {
    return { ok: true, accessToken: account.access_token, email: account.email };
  }

  const refreshed = await gmail.refreshAccessToken(account.refresh_token);
  if (!refreshed.ok) {
    if (refreshed.fatal) await store.markGmailProblem(sql, userId, refreshed.error);
    return {
      ok: false,
      error: refreshed.fatal
        ? `Gmail is connected but the token refresh failed (${refreshed.error}). Reconnect Gmail in Settings.`
        : `Could not refresh the Gmail token just now: ${refreshed.error}`,
      needsAttention: refreshed.fatal,
    };
  }
  await store.updateGmailAccessToken(sql, userId, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  });
  return { ok: true, accessToken: refreshed.accessToken, email: account.email };
}

// ── State ────────────────────────────────────────────────────────────────────

export type OutreachState = {
  ok: true;
  /** The studio profile with defaults filled in — what emails actually use. */
  profile: BusinessProfile;
  /** True once the owner has saved their own profile. */
  profileSaved: boolean;
  /** Paid calls spent today, against their budgets. */
  usage: { search: number; ai: number; searchBudget: number; aiBudget: number };
  /** Which web-search provider discovery will use, or "" when none is configured. */
  searchProvider: string;
  campaigns: Campaign[];
  /** Which prospects belong to which campaign. Empty before the migration runs. */
  campaignMembers: { campaignId: string; leadId: string }[];
  connection: GmailConnection;
  settings: OutreachSettings;
  templates: OutreachTemplate[];
  emails: OutreachEmail[];
  suppression: SuppressionEntry[];
  leads: LeadWithFacts[];
  allowance: { sent: number; limit: number; remaining: number; batch: number; atLimit: boolean };
  aiAvailable: boolean;
  database: "neon" | "pglite" | "none";
};

/**
 * Which Google OAuth client this deployment will ask for, safe to show.
 *
 * `invalid_client` from Google has one cause the server cannot detect: a
 * well-formed client id naming a client that no longer exists, or that belongs
 * to a different Cloud project than the one being looked at. The id carries its
 * project number, so showing it turns an unanswerable error into a comparison.
 * The secret is never included, and the id's random middle is masked.
 */
async function clientIdentity(config: { clientId: string } | null) {
  const gmail = await import("@/lib/gmail/client.server.ts");
  const setup = gmail.oauthSetup();
  const { chooseRedirectUri } = await import("@/lib/gmail/redirect.ts");
  const intendedSender = gmail.allowedSender();
  if (!config) return { clientProject: "", clientMasked: "", redirectUriOverride: chooseRedirectUri(process.env, "").uri, setup, intendedSender };
  const { describeClientId } = await import("@/lib/gmail/oauth.ts");
  const described = describeClientId(config.clientId);
  return {
    clientProject: described.project,
    clientMasked: described.masked,
    redirectUriOverride: chooseRedirectUri(process.env, "").uri,
    setup,
    intendedSender,
  };
}

/** Everything the outreach screen needs, in one round trip. */
export const getOutreachState = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<OutreachState | Fail> => {
    try {
      const { sql, store, settings, emails, templates } = await loadWorld(context.userId);
      const gmail = await import("@/lib/gmail/client.server.ts");
      const { dbSource } = await import("@/lib/db");
      const config = gmail.googleConfig();
      const [account, suppression, leads] = await Promise.all([
        store.loadGmailAccount(sql, context.userId),
        store.loadSuppression(sql, context.userId),
        store.loadLeads(sql, context.userId),
      ]);
      // Folded into the state the screen already loads rather than given their
      // own server function: the SSR bundle splits past a certain number of
      // them, and campaigns are part of the same picture as everything here.
      // A deployment that has not run the campaigns migration yet simply has
      // none, which is true rather than an error.
      const { campaigns, campaignMembers } = await loadCampaignWorld(store, sql, context.userId);
      const { effectiveProfile, profileIsSetUp } = await import("./profile.ts");
      // 0009 may not be applied on a deploy that is mid-migration: a missing
      // table reads as "nothing saved yet", never as an outage.
      const storedProfile = await store.loadProfile(sql, context.userId).catch(() => null);
      const used = await store.budgetUsed(sql, context.userId).catch(() => ({ search: 0, ai: 0 }));
      return {
        ok: true,
        profile: effectiveProfile(storedProfile),
        profileSaved: profileIsSetUp(storedProfile),
        usage: {
          ...used,
          searchBudget: settings.searchDailyBudget ?? 300,
          aiBudget: settings.aiDailyBudget ?? 150,
        },
        searchProvider: process.env.TAVILY_API_KEY?.trim()
          ? "Tavily"
          : process.env.BRAVE_SEARCH_API_KEY?.trim()
            ? "Brave"
            : "",
        connection: store.publicConnection(account, config !== null, await clientIdentity(config)),
        settings,
        templates,
        emails,
        suppression,
        leads,
        campaigns,
        campaignMembers,
        allowance: allowance(emails, settings),
        aiAvailable: Boolean(process.env.XAI_API_KEY?.trim()),
        database: dbSource,
      };
    } catch (error) {
      console.error("[outreach] state failed:", error);
      const setup = await classifyStateFailure(error);
      return { ok: false, error: SETUP_COPY[setup].detail, setup };
    }
  });

/**
 * Work out what actually went wrong loading outreach state.
 *
 * The environment is asked first and the error text second: `dbSource` and the
 * Postgres error code are facts, whereas message matching is a guess. Only when
 * neither is conclusive does this fall back to reading the message.
 */
async function classifyStateFailure(error: unknown): Promise<SetupReason> {
  const { dbSource } = await import("@/lib/db");
  if (dbSource === "none") return "no-database";
  if (typeof error === "object" && error !== null && "code" in error) {
    if ((error as { code?: unknown }).code === UNDEFINED_TABLE) return "schema-missing";
  }
  return classifySetupError(error instanceof Error ? error.message : String(error ?? ""));
}

// ── Gmail connect / disconnect / test ────────────────────────────────────────

/**
 * Start the OAuth dance.
 *
 * The client id is read on the server; the browser only ever receives the URL
 * to send the person to. `state` is returned so the callback page can prove the
 * redirect came from a flow this browser started.
 */
export const startGmailConnect = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ origin: str((input as { origin?: unknown })?.origin, 200) }))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true; url: string; state: string; redirectUri: string } | { ok: true; switchTo: string; redirectUri: string } | Fail> => {
    const gmail = await import("@/lib/gmail/client.server.ts");
    const { buildAuthUrl, clientIdProblem } = await import("@/lib/gmail/oauth.ts");
    const { signOAuthState } = await import("@/lib/crypto/secrets.server");
    const config = gmail.googleConfig();
    if (!config) {
      const { missingAdvice } = await import("./oauth-setup.ts");
      return {
        ok: false,
        error:
          missingAdvice(gmail.oauthSetup()) ||
          "Google OAuth is not set up. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server environment.",
      };
    }
    // Catch a malformed client id here rather than letting Google answer
    // "Error 401: invalid_client" on its own page, which names no cause and
    // reads like a sign-in fault instead of a configuration one.
    const badClientId = clientIdProblem(config.clientId);
    if (badClientId) {
      return {
        ok: false,
        error: `${badClientId} Fix it in the deployment's environment variables and redeploy.`,
      };
    }
    const { chooseRedirectUri, sameOrigin } = await import("@/lib/gmail/redirect.ts");
    const choice = chooseRedirectUri(process.env, data.origin);
    const redirectUri = choice.uri;
    if (!redirectUri) return { ok: false, error: "Could not work out the redirect URI." };
    // Logged so the exact value Google receives can be read from the runtime
    // logs. Not a secret: it is in the address bar of every sign-in.
    console.info(`[gmail] connect redirect_uri=${redirectUri} source=${choice.source} from=${data.origin}`);
    // The flow must run on the redirect URI's own origin: the state is kept in
    // this tab and the sign-in cookie belongs to one host, so starting on another
    // alias of the same deployment would land the callback somewhere that has
    // neither. Move there first; Settings picks the flow up again on arrival.
    if (choice.origin && !sameOrigin(choice.origin, data.origin)) {
      return { ok: true, switchTo: `${choice.origin}/settings?section=gmail&connect=1`, redirectUri };
    }
    // Signed to this account and timestamped, so the callback can prove — on
    // the server — that this signed-in owner started this exact flow.
    const state = signOAuthState(context.userId);
    return {
      ok: true,
      state,
      redirectUri,
      url: buildAuthUrl({
        clientId: config.clientId,
        redirectUri,
        state,
        loginHint: gmail.allowedSender() || undefined,
        authEndpoint: process.env.GOOGLE_OAUTH_BASE
          ? `${process.env.GOOGLE_OAUTH_BASE.replace(/\/+$/, "")}/auth`
          : undefined,
      }),
    };
  },
  );

/**
 * The redirect URI must match Google's registered value byte for byte.
 *
 * `GOOGLE_REDIRECT_URI` wins when set; otherwise it is built from the origin the
 * browser is actually on, which is what makes this work unchanged on localhost,
 * a preview URL and production.
 */
async function redirectUriFor(origin: string): Promise<string> {
  const { chooseRedirectUri } = await import("@/lib/gmail/redirect.ts");
  return chooseRedirectUri(process.env, origin).uri;
}

export const completeGmailConnect = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { code?: unknown; origin?: unknown; state?: unknown };
    return { code: str(source.code, 512), origin: str(source.origin, 200), state: str(source.state, 200) };
  })
  .handler(async ({ data, context }): Promise<{ ok: true; connection: GmailConnection } | Fail> => {
    if (!data.code) return { ok: false, error: "Google did not return an authorisation code." };
    const { verifyOAuthState } = await import("@/lib/crypto/secrets.server");
    const stateCheck = verifyOAuthState(context.userId, data.state);
    if (!stateCheck.ok) {
      return {
        ok: false,
        error:
          stateCheck.reason === "expired"
            ? "That Google sign-in took too long and expired. Start again from Settings → Gmail."
            : "That Google sign-in was not started by this account, so it was refused. Start again from Settings → Gmail.",
      };
    }
    const { getSql } = await import("@/lib/db");
    const store = await import("./store.server.ts");
    const gmail = await import("@/lib/gmail/client.server.ts");

    const redirectUri = await redirectUriFor(data.origin);
    const exchanged = await gmail.exchangeCode(data.code, redirectUri);
    if (!exchanged.ok) return { ok: false, error: exchanged.error };

    const profile = await gmail.getProfile(exchanged.accessToken);
    if (!profile.ok) return { ok: false, error: `Connected, but Gmail would not identify the account: ${profile.error}` };

    // When a sender is pinned, connecting the wrong account is refused outright
    // rather than quietly sending from somewhere unexpected.
    const expected = gmail.allowedSender();
    if (expected && profile.email.toLowerCase() !== expected) {
      await gmail.revokeToken(exchanged.accessToken);
      return {
        ok: false,
        error: `You signed in to Google as ${profile.email}. This app sends from ${expected} — press Connect Gmail again and choose ${expected}. Nothing was saved, and access for ${profile.email} was revoked.`,
      };
    }

    const sql = await getSql();
    await store.saveGmailTokens(sql, context.userId, {
      email: profile.email,
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      expiresAt: exchanged.expiresAt,
      scope: exchanged.scope,
    });
    const account = await store.loadGmailAccount(sql, context.userId);
    return {
      ok: true,
      connection: store.publicConnection(account, true, await clientIdentity(gmail.googleConfig())),
    };
  });

export const disconnectGmail = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<{ ok: true } | Fail> => {
    const { getSql } = await import("@/lib/db");
    const store = await import("./store.server.ts");
    const gmail = await import("@/lib/gmail/client.server.ts");
    const sql = await getSql();
    const account = await store.loadGmailAccount(sql, context.userId);
    // Tell Google first, but never let that failure block forgetting locally.
    if (account?.refresh_token) await gmail.revokeToken(account.refresh_token);
    await store.clearGmailAccount(sql, context.userId);
    return { ok: true };
  });

export const sendTestEmail = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ to: str((input as { to?: unknown })?.to, 254) }))
  .handler(async ({ data, context }): Promise<{ ok: true; messageId: string; to: string } | Fail> => {
    const token = await usableToken(context.userId);
    if (!token.ok) return token;
    const gmail = await import("@/lib/gmail/client.server.ts");
    const { buildRawMessage } = await import("@/lib/gmail/mime.ts");
    const to = data.to || token.email;
    const { getSql: getTestSql } = await import("@/lib/db");
    const testStore = await import("./store.server.ts");
    const { effectiveProfile, fromName } = await import("./profile.ts");
    const profile = effectiveProfile(await testStore.loadProfile(await getTestSql(), context.userId).catch(() => null));
    const raw = buildRawMessage({
      to,
      from: token.email,
      fromName: fromName(profile),
      subject: "Peak Swift outreach — test email",
      body: `This is a test from Peak Swift Leads.\n\nIf you are reading this, the Gmail connection works and outreach can send from ${token.email}.\n\nNo prospect was contacted.`,
    });
    const sent = await gmail.sendMessage(token.accessToken, raw);
    if (!sent.ok) {
      if (sent.fatal) await testStore.markGmailProblem(await getTestSql(), context.userId, sent.error);
      return { ok: false, error: sent.error, needsAttention: sent.fatal };
    }
    await testStore.markGmailSent(await getTestSql(), context.userId).catch(() => undefined);
    return { ok: true, messageId: sent.messageId, to };
  });

// ── Generation ───────────────────────────────────────────────────────────────

export type GeneratedRow = {
  leadId: string;
  ok: boolean;
  emailId?: string;
  subject?: string;
  body?: string;
  generatedBy?: string;
  /** What the email was personalised from, so Review can show why. */
  evidence?: { kind: string; text: string; source: string }[];
  note?: string;
  error?: string;
};

/**
 * Draft emails for the given leads.
 *
 * Eligibility is re-checked here from the server's own lead rows, so a client
 * asking to write to somebody who unsubscribed gets a refusal, not a draft.
 * Nothing generated here is sendable until it is approved and queued.
 */
export const generateEmails = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as {
      leadIds?: unknown;
      mode?: unknown;
      kind?: unknown;
      campaignId?: unknown;
      runId?: unknown;
    };
    const kind = str(source.kind, 20);
    return {
      leadIds: idList(source.leadIds, 50),
      mode: str(source.mode, 60) || "ai",
      kind: (kind === "follow-up-1" || kind === "follow-up-2" ? kind : "initial") as EmailKind,
      // A label on the draft, never a permission. Eligibility below is
      // unchanged and runs whether or not a campaign asked for this.
      campaignId: str(source.campaignId, 40),
      runId: str(source.runId, 64),
    };
  })
  .handler(({ data, context }) => generateEmailsCore(data, context));

export type GenerateInput = { leadIds: string[]; mode: string; kind: EmailKind; campaignId: string; runId: string };

/** The drafting itself, callable from a background job as well as the UI. */
export async function generateEmailsCore(data: GenerateInput, context: { userId: string }): Promise<{ ok: true; rows: GeneratedRow[] } | Fail> {
    if (data.leadIds.length === 0) return { ok: true, rows: [] };
    try {
      const { sql, store, settings, emails, suppression, templates } = await loadWorld(context.userId);
      const eligibilityContext = contextFrom(emails, suppression, settings, data.kind);
      const profile = await store.loadProfile(sql, context.userId).catch(() => null);
      const { effectiveProfile } = await import("./profile.ts");
      const studio = effectiveProfile(profile).businessName;
      const baseGenerate = aiGenerator();
      // Each AI draft spends one unit of today's AI budget, checked in the
      // database before the call. Out of budget means the template is used,
      // and the draft says so — it never means a runaway bill.
      const aiBudget = settings.aiDailyBudget ?? 150;
      const generate = baseGenerate
        ? async (prompt: string) => {
            const allowed = await store
              .consumeBudget(sql, context.userId, "ai", 1, aiBudget)
              .then((used) => used !== null)
              .catch(() => true);
            if (!allowed) throw new Error("AI budget reached");
            return baseGenerate(prompt);
          }
        : undefined;
      const rows: GeneratedRow[] = [];

      for (const leadId of data.leadIds) {
        const lead = await store.loadLead(sql, context.userId, leadId);
        if (!lead) {
          rows.push({ leadId, ok: false, error: "Lead not found." });
          continue;
        }
        const eligibility = checkEligibility(lead, eligibilityContext, data.kind);
        if (!eligibility.eligible) {
          rows.push({ leadId, ok: false, error: eligibility.reasons.join(", ") });
          continue;
        }

        const composed = await composeEmail(lead, {
          kind: data.kind,
          mode: data.mode,
          templates,
          generate,
          profile: profile ?? undefined,
        });

        const existing = await store.findDraft(sql, context.userId, leadId, data.kind);
        const id = existing?.id ?? newLeadId();
        // A follow-up must land in the same Gmail thread as what it follows,
        // with the subject Gmail and the recipient's mail client both use to
        // thread it: "Re: " and the original subject.
        const previous = emails
          .filter((email) => email.leadId === leadId && email.gmailThreadId && (email.status === "sent" || email.status === "replied"))
          .sort((a, b) => (b.sentAt || b.createdAt).localeCompare(a.sentAt || a.createdAt))[0];
        const subject =
          data.kind !== "initial" && previous
            ? `Re: ${previous.subject.replace(/^\s*re:\s*/i, "")}`.slice(0, 120)
            : composed.subject;

        // A draft that cannot pass the gate is still stored, so it can be seen
        // and edited — but it is stored as a draft, and the queue will refuse it.
        const verdict = checkEmailQuality({
          subject,
          body: composed.body,
          recipient: lead.email,
          lead,
          suppressed: suppression,
          studio,
        });

        const evidence = evidenceFor(lead);
        await store.upsertDraft(sql, context.userId, {
          id,
          personalisationEvidence: evidenceSummary(evidence),
          personalisationNote: composed.personalisation,
          campaignId: data.campaignId,
          runId: data.runId,
          leadId,
          businessName: lead.businessName,
          recipient: lead.email,
          subject,
          body: composed.body,
          kind: data.kind,
          generatedBy: composed.generatedBy,
          status: "draft",
          gmailThreadId: data.kind === "initial" ? "" : (previous?.gmailThreadId ?? ""),
        });
        await store.recordActivity(sql, context.userId, {
          id: newLeadId(),
          type: "EMAIL_PREPARED",
          leadId,
          leadName: lead.businessName,
          result: composed.generatedBy,
          reason: verdict.ok ? "" : verdict.problems[0]?.message,
        });

        rows.push({
          leadId,
          ok: true,
          emailId: id,
          subject,
          body: composed.body,
          generatedBy: composed.generatedBy,
          evidence: evidence.map((item) => ({ kind: item.kind, text: item.text, source: item.source })),
          note: [composed.fellBackBecause, verdict.ok ? "" : verdict.problems[0]?.message]
            .filter(Boolean)
            .join(" "),
        });
      }
      return { ok: true, rows };
    } catch (error) {
      console.error("[outreach] generate failed:", error);
      return { ok: false, error: "Could not generate emails." };
    }
}

/** Edit a draft by hand. Anything edited is marked manual, not AI. */
export const updateDraft = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { id?: unknown; subject?: unknown; body?: unknown };
    return { id: str(source.id, 64), subject: str(source.subject, 200), body: str(source.body, 6000) };
  })
  .handler(async ({ data, context }): Promise<{ ok: true } | Fail> => {
    if (!data.id) return { ok: false, error: "No email id." };
    const { getSql } = await import("@/lib/db");
    const store = await import("./store.server.ts");
    const sql = await getSql();
    const email = await store.loadEmail(sql, context.userId, data.id);
    if (!email) return { ok: false, error: "That email no longer exists." };
    if (email.status === "sent" || email.status === "replied") {
      return { ok: false, error: "That email has already been sent." };
    }
    await store.upsertDraft(sql, context.userId, {
      id: email.id,
      leadId: email.leadId,
      businessName: email.businessName,
      recipient: email.recipient,
      subject: data.subject,
      body: data.body,
      kind: email.kind,
      generatedBy: "manual",
      status: "draft",
      gmailThreadId: email.gmailThreadId,
    });
    return { ok: true };
  });

// ── Approve / queue / skip ───────────────────────────────────────────────────

export const setEmailDecision = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { ids?: unknown; decision?: unknown };
    const decision = str(source.decision, 20);
    return {
      ids: idList(source.ids, 200),
      decision: (decision === "approve" || decision === "queue" || decision === "skip" ? decision : "skip") as
        | "approve"
        | "queue"
        | "skip",
    };
  })
  .handler(async ({ data, context }): Promise<{ ok: true; changed: number; refused: string[] } | Fail> => {
    try {
      const { sql, store, settings, emails, suppression } = await loadWorld(context.userId);
      const { effectiveProfile } = await import("./profile.ts");
      const studio = effectiveProfile(await store.loadProfile(sql, context.userId).catch(() => null)).businessName;
      const refused: string[] = [];
      let changed = 0;

      for (const id of data.ids) {
        const email = await store.loadEmail(sql, context.userId, id);
        // The lead is only needed for an approval, and only when the email
        // resolved. `decideApproval` handles both being absent.
        const lead = email ? await store.loadLead(sql, context.userId, email.leadId) : null;
        const outcome = decideApproval({
          decision: data.decision,
          email,
          lead,
          context: contextFrom(
            emails.filter((other) => other.id !== id),
            suppression,
            settings,
            email?.kind ?? "initial",
          ),
          suppressed: suppression,
          studio,
        });

        if (outcome.action === "refuse") {
          // Every refusal is reported, including an id that no longer resolves.
          // Skipping one silently returned `changed: 0, refused: []`, which the
          // UI could only render as the button having done nothing at all.
          refused.push(outcome.reason);
          continue;
        }

        try {
          await store.setEmailStatus(
            sql,
            context.userId,
            id,
            outcome.status,
            { approved: outcome.status !== "skipped" },
          );
          changed += 1;
        } catch (error) {
          // The partial unique index is the last line of duplicate defence: if
          // another live email already exists for this address and kind, this
          // is where it is refused.
          const message = error instanceof Error ? error.message : String(error);
          const who = email?.businessName || "That email";
          refused.push(
            /unique|duplicate/i.test(message)
              ? `${who}: already has an email queued or sent`
              : `${who}: could not approve`,
          );
        }
      }
      return { ok: true, changed, refused };
    } catch (error) {
      console.error("[outreach] decision failed:", error);
      return { ok: false, error: "Could not update those emails." };
    }
  });

// ── Sending ──────────────────────────────────────────────────────────────────

export type SendReport = {
  ok: true;
  sent: number;
  failed: number;
  skipped: number;
  remaining: number;
  details: { id: string; businessName: string; status: string; error?: string }[];
  stopped?: string;
};

/**
 * Send one batch of queued emails.
 *
 * Bounded by the daily limit and the batch size, and checked again per email.
 * A failure marks that email failed and moves on; only a dead Gmail connection
 * stops the whole batch, because every remaining send would fail identically.
 */
export const sendQueued = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<SendReport | Fail> => {
    // Kept for the older batch callers. Every email still goes through the
    // same engine as the one-at-a-time Send screen: the second gate, the atomic
    // claim inside the limits, classified failures and reconciliation.
    try {
      const { sql, store, settings, emails } = await loadWorld(context.userId);
      const room = allowance(emails, settings);
      if (room.atLimit) {
        return {
          ok: true,
          sent: 0,
          failed: 0,
          skipped: 0,
          remaining: 0,
          details: [],
          stopped: `Daily limit reached (${room.sent}/${room.limit}).`,
        };
      }
      const batch = nextBatch(emails, settings);
      if (batch.length === 0) {
        return { ok: true, sent: 0, failed: 0, skipped: 0, remaining: room.remaining, details: [] };
      }
      const engine = await import("./send-engine.server.ts");
      const deps = await engineDeps(context.userId);
      const profile = await store.loadProfile(sql, context.userId).catch(() => null);

      const details: SendReport["details"] = [];
      let sent = 0;
      let failed = 0;
      let skipped = 0;
      let stopped: string | undefined;
      for (const email of batch) {
        const outcome = await engine.sendOne(deps, email.id, { settings, profile });
        if (outcome.status === "sent" || outcome.status === "sent_unrecorded") {
          sent += 1;
          details.push({ id: email.id, businessName: email.businessName, status: "sent" });
        } else if (outcome.status === "failed") {
          failed += 1;
          details.push({ id: email.id, businessName: email.businessName, status: "failed", error: outcome.reason });
        } else {
          skipped += 1;
          details.push({ id: email.id, businessName: email.businessName, status: "skipped", error: "reason" in outcome ? outcome.reason : "" });
          if (outcome.status === "not_sent") {
            stopped = outcome.reason;
            break;
          }
        }
      }
      const after = await store.loadEmails(sql, context.userId);
      return { ok: true, sent, failed, skipped, remaining: allowance(after, settings).remaining, details, stopped };
    } catch (error) {
      console.error("[outreach] send failed:", error);
      return { ok: false, error: "Sending stopped on a server error. Anything sent before it is recorded; nothing further was sent." };
    }
  });

/**
 * The send engine's dependencies for one request: the database, the real Gmail
 * client, and a token fetched (and refreshed) at most once.
 */
async function engineDeps(userId: string): Promise<import("./send-engine.server.ts").EngineDeps> {
  const { getSql } = await import("@/lib/db");
  const gmail = await import("@/lib/gmail/client.server.ts");
  const sql = await getSql();
  const { appOrigin } = await import("@/lib/app-origin");
  let token: Promise<import("./send-engine.server.ts").TokenResult> | null = null;
  return {
    sql,
    userId,
    publicOrigin: appOrigin(),
    gmail: {
      sendMessage: gmail.sendMessage,
      findSentMessage: gmail.findSentMessage,
      getMessageMeta: gmail.getMessageMeta,
    },
    token: () =>
      (token ??= usableToken(userId).then((result) =>
        result.ok ? result : { ok: false as const, error: result.error, needsAttention: result.needsAttention },
      )),
  };
}

// ── Replies ──────────────────────────────────────────────────────────────────

/**
 * Look for replies to emails we sent.
 *
 * Read-only and one-way: the app never answers a prospect. A reply stops
 * follow-ups, moves the lead to Replied, and — if the reply asks us to stop —
 * suppresses the address permanently.
 */
/**
 * How long one reply poll may spend talking to Gmail.
 *
 * Comfortably inside a Vercel Hobby function's 10 second ceiling, with room for
 * the database round trips either side. Anything left over is picked up by the
 * next poll.
 */
const REPLY_BUDGET_MS = 6_000;
/** Rows per poll. Matches the default in `awaitingReply`. */
const REPLY_BATCH = 40;

export type ReplyReport = {
  ok: true;
  replies: number;
  unsubscribes: number;
  /** How many threads this pass actually looked at. */
  checked: number;
  /** True when more were waiting than this pass could reach. */
  more: boolean;
  /** Delivery failures found on threads — not replies. */
  bounces?: number;
  /** Out-of-office answers — recorded, not counted as replies. */
  autoReplies?: number;
};

export const checkReplies = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(({ context }) => checkRepliesCore(context.userId));

/** One pass over the emails awaiting a reply. Also run by the reply-poll job. */
export async function checkRepliesCore(userId: string): Promise<ReplyReport | Fail> {
    try {
      const token = await usableToken(userId);
      if (!token.ok) return token;
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const gmail = await import("@/lib/gmail/client.server.ts");
      const sql = await getSql();

      // One Gmail call per email, sequentially, inside one serverless
      // invocation. `awaitingReply` bounds how many rows come back; this bounds
      // how long we spend on them, so the poll always returns an answer instead
      // of being killed mid-way and losing the replies it had already found.
      const deadline = Date.now() + REPLY_BUDGET_MS;
      const waiting = await store.awaitingReply(sql, userId);
      const checkedIds: string[] = [];
      let replies = 0;
      let unsubscribes = 0;
      let ranOut = false;

      const { decideThread } = await import("./replies.ts");
      let bounces = 0;
      let autoReplies = 0;
      for (const email of waiting) {
        if (Date.now() > deadline) {
          ranOut = true;
          break;
        }
        checkedIds.push(email.id);
        const thread = await gmail.getThread(token.accessToken, email.gmailThreadId, token.email);
        if (!thread.ok) {
          if (thread.fatal) {
            await store.markGmailProblem(sql, userId, thread.error);
            return { ok: false, error: "Gmail connection needs attention.", needsAttention: true };
          }
          continue;
        }
        // Only messages that arrived after ours count — an older message in the
        // same thread is not an answer to this email.
        const sentAt = Date.parse(email.sentAt) || 0;
        const theirs = thread.messages.filter(
          (message) => !message.fromUs && (!message.internalDate || Number(message.internalDate) >= sentAt - 60_000),
        );
        const decided = decideThread(theirs);
        if (!decided) continue;
        const { message, verdict } = decided;
        const at = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : undefined;

        if (verdict.kind === "bounce") {
          // A delivery failure, not a reply: the address is dead. Suppress it so
          // nothing is ever sent there again, and say so.
          await store.markBounced(sql, userId, email.id, { from: message.from, subject: message.subject, snippet: message.snippet });
          await store.suppress(sql, userId, {
            email: email.recipient,
            reason: "Bounced — the address does not accept email",
            leadId: email.leadId,
            businessName: email.businessName,
          });
          await store.updateLeadOutreach(sql, userId, email.leadId, { outreachStatus: "Bounced" });
          await store.recordActivity(sql, userId, {
            id: newLeadId(), type: "EMAIL_BOUNCED", leadId: email.leadId, leadName: email.businessName, result: email.recipient,
          });
          bounces += 1;
          continue;
        }
        if (verdict.kind === "auto_reply") {
          // An out-of-office is not a conversation. Recorded, shown, and
          // follow-ups carry on as scheduled.
          await store.markAutoReply(sql, userId, email.id, { from: message.from, subject: message.subject, snippet: message.snippet });
          autoReplies += 1;
          continue;
        }

        await store.markReplied(sql, userId, email.id, {
          from: message.from,
          subject: message.subject,
          snippet: message.snippet,
          kind: verdict.kind,
          suggestion: verdict.suggestion,
          at,
        });
        await store.updateLeadOutreach(sql, userId, email.leadId, { outreachStatus: "Replied" });
        replies += 1;
        await store.recordActivity(sql, userId, {
          id: newLeadId(),
          type: "REPLY_RECEIVED",
          leadId: email.leadId,
          leadName: email.businessName,
          result: email.recipient,
          reason: verdict.suggestion,
        });

        if (verdict.kind === "unsubscribe" || readsAsUnsubscribe(theirs.map((entry) => entry.snippet).join(" "))) {
          await store.suppress(sql, userId, {
            email: email.recipient,
            reason: "Asked to stop in a reply",
            leadId: email.leadId,
            businessName: email.businessName,
          });
          await store.updateLeadOutreach(sql, userId, email.leadId, {
            outreachStatus: "Unsubscribed",
            unsubscribed: new Date().toISOString(),
          });
          unsubscribes += 1;
        }
      }
      // Rotate what was looked at to the back of the queue, so the next pass
      // picks up where this one stopped rather than repeating it.
      await store.markRepliesChecked(sql, userId, checkedIds);
      return {
        ok: true,
        replies,
        unsubscribes,
        bounces,
        autoReplies,
        checked: checkedIds.length,
        more: ranOut || waiting.length === REPLY_BATCH,
      };
    } catch (error) {
      console.error("[outreach] reply check failed:", error);
      return { ok: false, error: "Could not check for replies." };
    }
}

// ── Suppression ──────────────────────────────────────────────────────────────

/** Suppress an address by hand. There is deliberately no way to undo this here. */
export const unsubscribeLead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { leadId?: unknown; email?: unknown; reason?: unknown };
    return {
      leadId: str(source.leadId, 64),
      email: str(source.email, 254).toLowerCase(),
      reason: str(source.reason, 200) || "Marked by hand",
    };
  })
  .handler(async ({ data, context }): Promise<{ ok: true } | Fail> => {
    const { getSql } = await import("@/lib/db");
    const store = await import("./store.server.ts");
    const sql = await getSql();
    const lead = data.leadId ? await store.loadLead(sql, context.userId, data.leadId) : null;
    const address = data.email || lead?.email || "";
    if (!address) return { ok: false, error: "No email address to suppress." };
    await store.suppress(sql, context.userId, {
      email: address,
      reason: data.reason,
      leadId: data.leadId,
      businessName: lead?.businessName ?? "",
    });
    if (data.leadId) {
      await store.updateLeadOutreach(sql, context.userId, data.leadId, {
        outreachStatus: "Unsubscribed",
        unsubscribed: new Date().toISOString(),
      });
    }
    return { ok: true };
  });

// ── Settings and templates ───────────────────────────────────────────────────

export const saveOutreachSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => (input ?? {}) as Partial<OutreachSettings>)
  .handler(async ({ data, context }): Promise<{ ok: true; settings: OutreachSettings } | Fail> => {
    const { getSql } = await import("@/lib/db");
    const store = await import("./store.server.ts");
    const sql = await getSql();
    const current = await store.loadSettings(sql, context.userId);
    const next = sanitizeSettings(data ?? {}, current ?? DEFAULT_SETTINGS);
    await store.saveSettings(sql, context.userId, next);
    return { ok: true, settings: next };
  });

export const saveOutreachTemplate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as Record<string, unknown>;
    return {
      id: str(source.id, 60),
      name: str(source.name, 80),
      kind: str(source.kind, 30),
      subject: str(source.subject, 200),
      body: str(source.body, 6000),
      signature: str(source.signature, 400),
    };
  })
  .handler(async ({ data, context }): Promise<{ ok: true; templates: OutreachTemplate[] } | Fail> => {
    if (!data.id) return { ok: false, error: "No template id." };
    const { getSql } = await import("@/lib/db");
    const store = await import("./store.server.ts");
    const sql = await getSql();
    await store.saveTemplate(sql, context.userId, {
      id: data.id,
      name: data.name || data.id,
      kind: (data.kind || "general") as OutreachTemplate["kind"],
      subject: data.subject,
      body: data.body,
      signature: data.signature,
    });
    return { ok: true, templates: await store.loadTemplates(sql, context.userId) };
  });

export { emptyContext };

function isMissingTable(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: string }).code === "42P01";
  }
  return /does not exist/i.test(error instanceof Error ? error.message : String(error ?? ""));
}

type AgentFail = { success: false; error: string; code: string; retryable: boolean };
const agentFail = (error: string, code: string, retryable = false): AgentFail => ({
  success: false,
  error,
  code,
  retryable,
});

export const getCampaignStats = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    try {
      const { settings, emails, suppression, store, sql } = await loadWorld(context.userId);
      const { computeStats, scoreAll, describeBottleneck } = await salesTools();
      const leads = await store.loadLeads(sql, context.userId);
      const ctx = contextFrom(emails, suppression, settings);
      const world = await scoringWorld(context.userId, settings, suppression, emails);
      const scores = [...scoreAll(leads, world).values()];
      const stats = computeStats(leads, emails, settings, ctx, new Date(), scores);
      const room = allowance(emails, settings);
      return {
        success: true as const,
        count: stats.leads,
        qualified: stats.eligibleNow,
        // "hot"/"warm" are the API's historical names for strong/good prospects.
        hot: stats.hot,
        warm: stats.warm,
        calls: stats.call,
        skipped: scores.filter((score) => score.action === "SKIP").length,
        emailsFound: stats.emailsAvailable,
        sentToday: stats.sentToday,
        remainingToday: room.remaining,
        replies: stats.replies,
        errors: stats.failed,
        bottleneck: describeBottleneck(scores),
      };
    } catch (error) {
      return agentFail(error instanceof Error ? error.message : "Could not load stats.", "STATS_FAILED", true);
    }
  });

export const getSystemHealth = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    try {
      const { store, emails, sql } = await loadWorld(context.userId);
      const { assessHealth } = await salesTools();
      const { dbSource } = await import("@/lib/db");
      const gmail = await import("@/lib/gmail/client.server.ts");
      const [account, leads] = await Promise.all([
        store.loadGmailAccount(sql, context.userId),
        store.loadLeads(sql, context.userId),
      ]);
      const report = assessHealth({
        database: dbSource,
        connection: store.publicConnection(account, gmail.googleConfig() !== null, await clientIdentity(gmail.googleConfig())),
        leads,
        emails,
        aiAvailable: Boolean(process.env.XAI_API_KEY?.trim()),
      });
      return { success: true as const, ...report };
    } catch (error) {
      return agentFail(error instanceof Error ? error.message : "Could not load health.", "HEALTH_FAILED", true);
    }
  });

export const getActivityLog = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const sql = await getSql();
      const events = await store.loadActivity(sql, context.userId);
      return { success: true as const, count: events.length, events };
    } catch (error) {
      if (isMissingTable(error)) return { success: true as const, count: 0, events: [] };
      return agentFail(error instanceof Error ? error.message : "Could not load activity.", "ACTIVITY_FAILED", true);
    }
  });

export const getReviewQueue = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    try {
      const { store, sql } = await loadWorld(context.userId);
      const { scoreAll, toProspectRecord } = await salesTools();
      const { settings, emails, suppression } = await loadWorld(context.userId);
      const leads = await store.loadLeads(sql, context.userId);
      let reviews: Awaited<ReturnType<typeof store.loadReviews>> = [];
      try {
        reviews = await store.loadReviews(sql, context.userId);
      } catch (error) {
        if (!isMissingTable(error)) throw error;
      }
      const decided = new Map(reviews.map((row) => [row.leadId, row]));
      const scores = scoreAll(leads, await scoringWorld(context.userId, settings, suppression, emails));
      const queue = leads
        .filter((lead) => scores.get(lead.id)!.action === "REVIEW" && (decided.get(lead.id)?.decision ?? "pending") === "pending")
        .sort((a, b) => scores.get(b.id)!.priority - scores.get(a.id)!.priority)
        .map((lead) => toProspectRecord(lead, scores.get(lead.id)!));
      return { success: true as const, count: queue.length, queue };
    } catch (error) {
      return agentFail(error instanceof Error ? error.message : "Could not load the review queue.", "REVIEW_FAILED", true);
    }
  });

export const recordLeadReview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const data = (input ?? {}) as { leadId?: unknown; decision?: unknown; note?: unknown };
    return {
      leadId: str(data.leadId, 64),
      decision: str(data.decision, 40) || "pending",
      note: str(data.note, 400),
    };
  })
  .handler(async ({ context, data }) => {
    if (!data.leadId) return agentFail("Missing lead.", "INVALID", false);
    if (!["approved", "skipped", "investigate", "pending"].includes(data.decision)) {
      return agentFail("Decision must be approved, skipped or investigate.", "INVALID", false);
    }
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const sql = await getSql();
      await store.upsertReview(sql, context.userId, data);
      await store.recordActivity(sql, context.userId, {
        id: newLeadId(),
        type: data.decision === "approved" ? "LEAD_APPROVED" : data.decision === "skipped" ? "LEAD_SKIPPED" : "LEAD_REVIEW_REQUIRED",
        leadId: data.leadId,
        result: data.decision,
        reason: data.note,
      });
      return { success: true as const, leadId: data.leadId, decision: data.decision };
    } catch (error) {
      if (isMissingTable(error)) {
        return agentFail("Review tables are not on this database yet. Redeploy so migrations run.", "SCHEMA_MISSING", true);
      }
      return agentFail(error instanceof Error ? error.message : "Could not save the review.", "REVIEW_SAVE_FAILED", true);
    }
  });

export const getFollowups = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    try {
      const { settings, emails, suppression, store, sql } = await loadWorld(context.userId);
      const { followUpsDue } = await import("./follow-ups.ts");
      const leads = await store.loadLeads(sql, context.userId);
      const due = followUpsDue(leads, emails, settings, contextFrom(emails, suppression, settings));
      return {
        success: true as const,
        count: due.length,
        followUpsOn: settings.followUpsOn,
        due: due.map((entry) => ({ leadId: entry.lead.id, businessName: entry.lead.businessName, kind: entry.kind })),
      };
    } catch (error) {
      return agentFail(error instanceof Error ? error.message : "Could not load follow-ups.", "FOLLOWUPS_FAILED", true);
    }
  });

export const saveOutreachRun = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => input as Record<string, unknown>)
  .handler(async ({ context, data }) => {
    const num = (key: string) => {
      const value = Number(data[key]);
      return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    };
    const run = {
      id: str(data.id, 64) || newLeadId(),
      startedAt: str(data.startedAt, 40),
      finishedAt: str(data.finishedAt, 40),
      location: str(data.location, 80),
      businessType: str(data.businessType, 80),
      mode: str(data.mode, 20) || "prepare",
      found: num("found"),
      qualified: num("qualified"),
      hot: num("hot"),
      warm: num("warm"),
      callCount: num("callCount"),
      lowCount: num("lowCount"),
      skipped: num("skipped"),
      emailsFound: num("emailsFound"),
      prepared: num("prepared"),
      sent: num("sent"),
      replies: num("replies"),
      errors: num("errors"),
      bottleneck: str(data.bottleneck, 300),
      summary: str(data.summary, 500),
    };
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const sql = await getSql();
      await store.insertRun(sql, context.userId, run);
      await store.recordActivity(sql, context.userId, {
        id: newLeadId(),
        type: "SEARCH_COMPLETED",
        result: run.mode,
        reason: run.summary,
        metadata: JSON.stringify({ found: run.found, sent: run.sent, errors: run.errors }),
      });
      return { success: true as const, id: run.id };
    } catch (error) {
      if (isMissingTable(error)) return { success: true as const, id: run.id, stored: false };
      return agentFail(error instanceof Error ? error.message : "Could not save the run.", "RUN_SAVE_FAILED", true);
    }
  });

/**
 * Every campaign write, behind one server function.
 *
 * Create, rename, retarget, start, pause, resume, complete, archive and add
 * prospects are all the same shape of operation — change one campaign row, or
 * its membership — so they share a function rather than each claiming their
 * own. That is deliberate: the SSR bundle has split before under the weight of
 * server-function exports, and a feature does not need nine of them.
 *
 * Nothing here sends. A campaign never gets its own route past
 * `checkEligibility`, the suppression list, the duplicate index or the daily
 * limit; starting one only means it may be searched against. `sanitizeSettings`
 * still owns the ceiling, and `clampCampaign` is applied server-side so a
 * crafted request cannot set a daily target the settings would refuse.
 */
export const saveCampaign = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as Record<string, unknown>;
    const action = str(source.action, 20);
    return {
      action: (action === "status" || action === "prospects" || action === "duplicate" ? action : "save") as
        | "save"
        | "status"
        | "prospects"
        | "duplicate",
      id: str(source.id, 40),
      name: str(source.name, 60),
      locations: str(source.locations, 200),
      trades: str(source.trades, 200),
      targetProspects: Number(source.targetProspects ?? 50),
      dailyTarget: Number(source.dailyTarget ?? 10),
      batchSize: Number(source.batchSize ?? 5),
      sendMode: str(source.sendMode, 10) === "send" ? ("send" as const) : ("prepare" as const),
      status: str(source.status, 20) as CampaignStatus,
      leadIds: idList(source.leadIds, 500),
    };
  })
  .handler(async ({ data, context }) => {
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const sql = await getSql();
      const settings = await store.loadSettings(sql, context.userId);
      const limits = { dailyMax: settings.dailyLimit, batchMax: settings.batchSize };
      const now = new Date().toISOString();
      const existing = data.id ? await store.loadCampaign(sql, context.userId, data.id) : null;

      if (data.action === "prospects") {
        if (!existing) return agentFail("That campaign no longer exists.", "CAMPAIGN_MISSING");
        const added = await store.addCampaignProspects(
          sql,
          context.userId,
          existing.id,
          data.leadIds,
        );
        return { success: true as const, id: existing.id, added };
      }

      if (data.action === "duplicate") {
        if (!existing) return agentFail("That campaign no longer exists.", "CAMPAIGN_MISSING");
        // Same areas, trades and limits; a fresh name, no prospects and no
        // history. Starts as a draft, so copying never starts anything.
        const copy = clampCampaign(
          {
            ...newCampaign(newLeadId(), now),
            name: `${existing.name} (copy)`.slice(0, 60),
            locations: existing.locations,
            trades: existing.trades,
            targetProspects: existing.targetProspects,
            dailyTarget: existing.dailyTarget,
            batchSize: existing.batchSize,
            sendMode: "prepare",
          },
          limits,
          now,
        );
        await store.upsertCampaign(sql, context.userId, copy);
        return { success: true as const, id: copy.id, campaign: copy };
      }

      if (data.action === "status") {
        if (!existing) return agentFail("That campaign no longer exists.", "CAMPAIGN_MISSING");
        const problem = campaignTransitionProblem(existing.status, data.status);
        if (problem) return agentFail(problem, "CAMPAIGN_TRANSITION");
        const next = { ...existing, status: data.status, updatedAt: now };
        await store.upsertCampaign(sql, context.userId, next);
        return { success: true as const, id: next.id, campaign: next };
      }

      const base = existing ?? newCampaign(data.id || newLeadId(), now);
      const next = clampCampaign(
        {
          ...base,
          name: data.name,
          locations: data.locations,
          trades: data.trades,
          targetProspects: data.targetProspects,
          dailyTarget: data.dailyTarget,
          batchSize: data.batchSize,
          sendMode: data.sendMode,
          // A save never changes status — that is what the status action is
          // for — so editing a paused campaign cannot quietly restart it.
          status: base.status,
        },
        limits,
        now,
      );
      const problem = campaignProblem(next);
      if (problem) return agentFail(problem, "CAMPAIGN_INVALID");
      await store.upsertCampaign(sql, context.userId, next);
      return { success: true as const, id: next.id, campaign: next };
    } catch (error) {
      if (isMissingTable(error)) {
        return agentFail(
          "Campaigns need the latest database migration. Redeploy to apply it.",
          "CAMPAIGNS_NOT_MIGRATED",
        );
      }
      return agentFail(
        error instanceof Error ? error.message : "Could not save the campaign.",
        "CAMPAIGN_SAVE_FAILED",
        true,
      );
    }
  });

export const getRecentRuns = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const sql = await getSql();
      const runs = await store.loadRuns(sql, context.userId);
      return { success: true as const, count: runs.length, runs };
    } catch (error) {
      if (isMissingTable(error)) return { success: true as const, count: 0, runs: [] };
      return agentFail(error instanceof Error ? error.message : "Could not load runs.", "RUNS_FAILED", true);
    }
  });

export const getLeads = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    try {
      const { store, sql } = await loadWorld(context.userId);
      const { toProspectRecord, tallyScores, scoreAll } = await salesTools();
      const { settings, emails, suppression } = await loadWorld(context.userId);
      const leads = await store.loadLeads(sql, context.userId);
      const scores = scoreAll(leads, await scoringWorld(context.userId, settings, suppression, emails));
      const rows = leads.map((lead) => toProspectRecord(lead, scores.get(lead.id)!));
      const tally = tallyScores(leads, [...scores.values()]);
      return {
        success: true as const,
        count: rows.length,
        hot: tally.strong,
        warm: tally.good,
        calls: tally.call,
        skipped: [...scores.values()].filter((score) => score.action === "SKIP").length,
        emailsFound: tally.emailsFound,
        rows,
      };
    } catch (error) {
      return agentFail(error instanceof Error ? error.message : "Could not load leads.", "LEADS_FAILED", true);
    }
  });

export const getLead = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ id: str((input as { id?: unknown })?.id, 64) }))
  .handler(async ({ context, data }) => {
    if (!data.id) return agentFail("Missing lead id.", "INVALID", false);
    try {
      const { store, sql } = await loadWorld(context.userId);
      const { toProspectRecord, scoreLead } = await salesTools();
      const lead = await store.loadLead(sql, context.userId, data.id);
      if (!lead) return agentFail("Lead not found.", "NOT_FOUND", false);
      const { settings, emails, suppression } = await loadWorld(context.userId);
      const score = scoreLead(lead, await scoringWorld(context.userId, settings, suppression, emails));
      return { success: true as const, lead: toProspectRecord(lead, score) };
    } catch (error) {
      return agentFail(error instanceof Error ? error.message : "Could not load the lead.", "LEAD_FAILED", true);
    }
  });

export const qualifyLeads = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    try {
      const { store, sql } = await loadWorld(context.userId);
      const { scoreAll } = await salesTools();
      const { settings, emails, suppression } = await loadWorld(context.userId);
      const leads = await store.loadLeads(sql, context.userId);
      const scores = scoreAll(leads, await scoringWorld(context.userId, settings, suppression, emails));
      const rows = leads.map((lead) => {
        const score = scores.get(lead.id)!;
        return {
          id: lead.id,
          businessName: lead.businessName,
          trade: lead.trade,
          town: lead.town,
          phone: lead.phone,
          email: lead.email,
          website: lead.website,
          websiteStatus: lead.websiteStatus,
          band: score.band,
          priority: score.priority,
          action: score.action,
          actionReason: score.actionReason,
          blockers: score.blockers,
          why: score.why.map((reason) => reason.text),
        };
      });
      const hot = rows.filter((row) => row.band === "STRONG").length;
      const warm = rows.filter((row) => row.band === "GOOD").length;
      const calls = rows.filter((row) => row.action === "CALL").length;
      return {
        success: true as const,
        count: rows.length,
        qualified: hot + warm,
        hot,
        warm,
        calls,
        skipped: rows.filter((row) => row.action === "SKIP").length,
        emailsFound: rows.filter((row) => row.email.trim()).length,
        errors: 0,
        rows,
      };
    } catch (error) {
      return agentFail(error instanceof Error ? error.message : "Could not qualify leads.", "QUALIFY_FAILED", true);
    }
  });

// ── Sending, one email at a time (the Send screen) ───────────────────────────

/**
 * Send one approved email now.
 *
 * The Send screen calls this once per email, in order, so progress is real
 * ("Sending 3 of 10") and no single serverless call ever has to outlive a batch.
 * Everything that matters happens in the send engine — see its header.
 */
export const sendEmail = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ id: str((input as { id?: unknown })?.id, 64) }))
  .handler(async ({ data, context }) => {
    if (!data.id) return { ok: false as const, error: "No email id." };
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const engine = await import("./send-engine.server.ts");
      const sql = await getSql();
      const [settings, profile] = await Promise.all([
        store.loadSettings(sql, context.userId),
        store.loadProfile(sql, context.userId).catch(() => null),
      ]);
      const outcome = await engine.sendOne(await engineDeps(context.userId), data.id, { settings, profile });
      const sentToday = await store.countSentSince(sql, context.userId, engine.dayStart(new Date()));
      return {
        ok: true as const,
        outcome,
        allowance: { sent: sentToday, limit: settings.dailyLimit, remaining: Math.max(0, settings.dailyLimit - sentToday) },
      };
    } catch (error) {
      console.error("[outreach] sendEmail failed:", error);
      return {
        ok: false as const,
        error:
          "The server stopped before it could say whether this email went. Nothing is resent automatically — reopen Send and it will be checked against Gmail.",
      };
    }
  });

/** Finish any send whose answer was lost, from Gmail's own record. */
export const reconcileSending = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    try {
      const engine = await import("./send-engine.server.ts");
      const result = await engine.reconcileStale(await engineDeps(context.userId));
      return { ok: true as const, ...result };
    } catch (error) {
      console.error("[outreach] reconcile failed:", error);
      return { ok: false as const, error: "Could not check unfinished sends against Gmail just now." };
    }
  });

/** Put failed emails back in the queue — only after Gmail confirms they did not go. */
export const retryFailedEmails = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ ids: idList((input as { ids?: unknown })?.ids, 50) }))
  .handler(async ({ data, context }) => {
    try {
      const engine = await import("./send-engine.server.ts");
      const results = await engine.retryEmails(await engineDeps(context.userId), data.ids);
      return { ok: true as const, results };
    } catch (error) {
      console.error("[outreach] retry failed:", error);
      return { ok: false as const, error: "Could not retry those emails." };
    }
  });

// ── Gmail health ─────────────────────────────────────────────────────────────

export type HealthCheck = { id: string; label: string; level: "ok" | "warn" | "fail" | "off"; detail: string };

/**
 * Ask Google, now, whether sending would work — and say exactly what is wrong
 * when it would not. Refreshes the token (which sends nothing) and reads the
 * mailbox profile; never sends an email.
 */
export const checkGmailHealth = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const checks: HealthCheck[] = [];
    const add = (check: HealthCheck) => checks.push(check);
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const gmail = await import("@/lib/gmail/client.server.ts");
      const { clientIdProblem, hasRequiredScopes, GMAIL_SCOPES } = await import("@/lib/gmail/oauth.ts");
      const { keySource } = await import("@/lib/crypto/secrets.server");
      const { effectiveProfile } = await import("./profile.ts");
      const { missingAdvice } = await import("./oauth-setup.ts");
      const sql = await getSql();

      const config = gmail.googleConfig();
      const badClient = config ? clientIdProblem(config.clientId) : null;
      add(
        !config
          ? { id: "credentials", label: "OAuth credentials", level: "fail", detail: missingAdvice(gmail.oauthSetup()) || "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set on this deployment." }
          : badClient
            ? { id: "credentials", label: "OAuth credentials", level: "fail", detail: badClient }
            : { id: "credentials", label: "OAuth credentials", level: "ok", detail: "Client id and secret are configured." },
      );

      const account = await store.loadGmailAccount(sql, context.userId);
      if (!account || account.status === "disconnected") {
        add({ id: "connected", label: "Gmail account", level: "fail", detail: "No Gmail account is connected. Press Connect Gmail." });
        return finishHealth(sql, store, context.userId, checks);
      }
      add({ id: "connected", label: "Gmail account", level: "ok", detail: `Connected as ${account.email}.` });

      const source = keySource();
      add({
        id: "encryption",
        label: "Token storage",
        level: account.tokenProblem ? "fail" : source === "development" && process.env.DATABASE_URL ? "warn" : "ok",
        detail: account.tokenProblem
          ? account.tokenProblem
          : `Tokens are encrypted at rest (key from ${source === "TOKEN_ENCRYPTION_KEY" ? "TOKEN_ENCRYPTION_KEY" : source === "DATABASE_URL" ? "the database URL — set TOKEN_ENCRYPTION_KEY to control it separately" : source === "BETTER_AUTH_SECRET" ? "BETTER_AUTH_SECRET" : "a development key"}).`,
      });
      if (account.tokenProblem) return finishHealth(sql, store, context.userId, checks);

      if (!account.refresh_token) {
        add({ id: "refresh", label: "Refresh token", level: "fail", detail: "No refresh token is stored. Reconnect Gmail." });
        return finishHealth(sql, store, context.userId, checks);
      }
      const refreshed = await gmail.refreshAccessToken(account.refresh_token);
      if (!refreshed.ok) {
        if (refreshed.fatal) await store.markGmailProblem(sql, context.userId, refreshed.error);
        add({
          id: "refresh",
          label: "Refresh token",
          level: "fail",
          detail: refreshed.fatal
            ? `Gmail is connected but the token refresh failed: ${refreshed.error}. Reconnect Gmail. (If the Google consent screen is in Testing mode, tokens expire after 7 days — publish the app in Google Cloud to stop that.)`
            : `Google could not be reached to refresh the token: ${refreshed.error}`,
        });
        return finishHealth(sql, store, context.userId, checks);
      }
      await store.updateGmailAccessToken(sql, context.userId, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      });
      add({ id: "refresh", label: "Refresh token", level: "ok", detail: "Google issued a fresh access token." });

      const scopes = refreshed.scope || account.scope;
      add(
        hasRequiredScopes(scopes)
          ? { id: "permissions", label: "Permissions", level: "ok", detail: "Send and read access are granted." }
          : {
              id: "permissions",
              label: "Permissions",
              level: "fail",
              detail: `Missing: ${GMAIL_SCOPES.filter((scope) => !scopes.split(/\s+/).includes(scope)).map((scope) => scope.split("/").pop()).join(", ")}. Reconnect and tick every box on Google's screen.`,
            },
      );

      const profileCheck = await gmail.getProfile(refreshed.accessToken);
      if (!profileCheck.ok) {
        add({ id: "api", label: "Gmail API", level: "fail", detail: `Gmail API refused the request: ${profileCheck.error}. Check the Gmail API is enabled in Google Cloud.` });
        return finishHealth(sql, store, context.userId, checks);
      }
      add({ id: "api", label: "Gmail API", level: "ok", detail: `Mailbox reachable (${profileCheck.email}).` });

      const pinned = gmail.allowedSender();
      const profile = effectiveProfile(await store.loadProfile(sql, context.userId).catch(() => null));
      const mailbox = profileCheck.email.toLowerCase();
      if (pinned && pinned !== mailbox) {
        add({ id: "identity", label: "Sender identity", level: "fail", detail: `This app sends from ${pinned}, but the connected mailbox is ${mailbox}. Disconnect and connect ${pinned}.` });
      } else if (profile.senderEmail && profile.senderEmail !== mailbox) {
        add({ id: "identity", label: "Sender identity", level: "warn", detail: `Your business profile says ${profile.senderEmail}, but emails will come from ${mailbox}.` });
      } else {
        add({ id: "identity", label: "Sender identity", level: "ok", detail: `Emails are sent as "${profile.senderName} at ${profile.businessName}" <${mailbox}>.` });
      }
      const { senderAdvice } = await import("./sender-advice.ts");
      const advice = senderAdvice(mailbox);
      if (advice.kind === "consumer") add({ id: "sender-domain", label: "Sending domain", level: "warn", detail: advice.advice });
      else if (advice.kind === "domain") add({ id: "sender-domain", label: "Sending domain", level: "ok", detail: advice.advice });
      const { appOrigin } = await import("@/lib/app-origin");
      add(
        appOrigin()
          ? { id: "unsubscribe", label: "Unsubscribe link", level: "ok", detail: `Each email carries a signed one-click unsubscribe link to ${appOrigin()}/unsubscribe.` }
          : { id: "unsubscribe", label: "Unsubscribe link", level: "warn", detail: "No public address is known for this deployment, so emails carry only the reply-to-stop line and a mailto unsubscribe. Set APP_URL." },
      );

      const lastSend = account.last_send_at ? new Date(account.last_send_at as string).toISOString() : "";
      add({
        id: "last-send",
        label: "Last successful send",
        level: lastSend ? "ok" : "off",
        detail: lastSend ? new Date(lastSend).toUTCString() : "Nothing has been sent from this app yet. Send a test email to prove the path.",
      });
      return finishHealth(sql, store, context.userId, checks);
    } catch (error) {
      console.error("[outreach] health check failed:", error);
      add({ id: "server", label: "Health check", level: "fail", detail: error instanceof Error ? error.message : "The check could not run." });
      return { ok: true as const, checks, healthy: false, checkedAt: new Date().toISOString() };
    }
  });

async function finishHealth(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  store: typeof import("./store.server.ts"),
  userId: string,
  checks: HealthCheck[],
) {
  const healthy = checks.every((check) => check.level === "ok" || check.level === "off");
  const checkedAt = new Date().toISOString();
  await store.saveGmailHealth(sql, userId, JSON.stringify({ healthy, checks, checkedAt })).catch(() => undefined);
  return { ok: true as const, checks, healthy, checkedAt };
}

/**
 * The whole pipeline, once, to your own address — see `runEndToEndTest` in the
 * send engine. Refuses any recipient that is not the designated test address
 * or the connected mailbox.
 */
export const runPipelineTest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ to: str((input as { to?: unknown })?.to, 254).toLowerCase() }))
  .handler(async ({ data, context }) => {
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const engine = await import("./send-engine.server.ts");
      const sql = await getSql();
      const [settings, profile] = await Promise.all([
        store.loadSettings(sql, context.userId),
        store.loadProfile(sql, context.userId).catch(() => null),
      ]);
      const deps = await engineDeps(context.userId);
      const token = await deps.token();
      const to = data.to || settings.testRecipient || (token.ok ? token.email : "");
      const result = await engine.runEndToEndTest(deps, {
        to,
        designated: settings.testRecipient ?? "",
        profile,
        generate: aiGenerator(),
      });
      return {
        ok: true as const,
        passed: result.ok,
        steps: result.steps,
        messageId: result.messageId ?? "",
        threadId: result.threadId ?? "",
        to,
      };
    } catch (error) {
      console.error("[outreach] pipeline test failed:", error);
      return { ok: false as const, error: error instanceof Error ? error.message : "The test could not run." };
    }
  });

// ── Business profile ─────────────────────────────────────────────────────────

export const saveBusinessProfile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => (input ?? {}) as Record<string, unknown>)
  .handler(async ({ data, context }) => {
    try {
      const { sanitizeProfile, effectiveProfile } = await import("./profile.ts");
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const { profile, problems } = sanitizeProfile(data as never);
      await store.saveProfile(await getSql(), context.userId, profile);
      return { ok: true as const, profile: effectiveProfile(profile), problems };
    } catch (error) {
      console.error("[outreach] profile save failed:", error);
      return { ok: false as const, error: isMissingTable(error) ? "Redeploy so the latest migration runs, then save again." : "Could not save the profile." };
    }
  });

// ── Replies inbox ────────────────────────────────────────────────────────────

/**
 * Move a reply to a stage, and record the outcome on the lead so the lifecycle,
 * eligibility and every screen agree. Never sends anything.
 */
export const setReplyStage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const source = (input ?? {}) as { emailId?: unknown; stage?: unknown };
    return { emailId: str(source.emailId, 64), stage: str(source.stage, 20) };
  })
  .handler(async ({ data, context }) => {
    const { REPLY_STAGES } = await import("./types.ts");
    if (!(REPLY_STAGES as readonly string[]).includes(data.stage)) return { ok: false as const, error: "Unknown stage." };
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const { leadOutcomeForStage } = await import("./replies.ts");
      const { addDays, todayIso } = await import("@/lib/leads");
      const sql = await getSql();
      const email = await store.setReplyStage(sql, context.userId, data.emailId, data.stage);
      if (!email) return { ok: false as const, error: "That reply no longer exists." };
      const outcome = leadOutcomeForStage(data.stage as (typeof REPLY_STAGES)[number]);
      if (outcome) {
        await store.updateLeadOutcome(sql, context.userId, email.leadId, {
          called: outcome.called,
          callResult: outcome.callResult,
          followUpDate: outcome.followUpInDays ? addDays(todayIso(), outcome.followUpInDays) : undefined,
        });
      }
      await store.recordActivity(sql, context.userId, {
        id: newLeadId(),
        type: "REPLY_STAGE",
        leadId: email.leadId,
        leadName: email.businessName,
        result: data.stage,
      });
      return { ok: true as const, email };
    } catch (error) {
      console.error("[outreach] reply stage failed:", error);
      return { ok: false as const, error: "Could not update that reply." };
    }
  });

// ── Runs, recorded as they happen ────────────────────────────────────────────

/**
 * Create or update a run record. The Find screen writes one when a run starts
 * and after each stage, so the history is honest about runs that were stopped
 * or interrupted, and "View run" can list the prospects it found.
 */
export const recordRun = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => (input ?? {}) as Record<string, unknown>)
  .handler(async ({ data, context }) => {
    const num = (key: string) => {
      const value = Number(data[key]);
      return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    };
    const status = str(data.status, 20);
    const run = {
      id: str(data.id, 64) || newLeadId(),
      startedAt: str(data.startedAt, 40),
      finishedAt: str(data.finishedAt, 40),
      location: str(data.location, 80),
      businessType: str(data.businessType, 200),
      mode: str(data.mode, 20) || "prepare",
      found: num("found"),
      qualified: num("qualified"),
      hot: num("hot"),
      warm: num("warm"),
      callCount: num("callCount"),
      lowCount: num("lowCount"),
      skipped: num("skipped"),
      emailsFound: num("emailsFound"),
      prepared: num("prepared"),
      sent: num("sent"),
      replies: num("replies"),
      errors: num("errors"),
      bottleneck: str(data.bottleneck, 300),
      summary: str(data.summary, 500),
      status: ["running", "done", "stopped", "failed", "interrupted"].includes(status) ? status : "running",
      phase: str(data.phase, 40),
      campaignId: str(data.campaignId, 40),
      target: num("target"),
      dailyLimit: num("dailyLimit"),
      funnel: typeof data.funnel === "string" ? data.funnel.slice(0, 8000) : JSON.stringify(data.funnel ?? {}).slice(0, 8000),
      leadIds: idList(data.leadIds, 500),
      updatedAt: "",
    };
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const sql = await getSql();
      await store.upsertRun(sql, context.userId, run);
      if (run.status !== "running") {
        await store.recordActivity(sql, context.userId, {
          id: newLeadId(),
          type: "SEARCH_COMPLETED",
          result: run.status,
          reason: run.summary,
          metadata: JSON.stringify({ runId: run.id, found: run.found, prepared: run.prepared }),
        });
      }
      return { success: true as const, id: run.id };
    } catch (error) {
      if (isMissingTable(error)) return { success: true as const, id: run.id, stored: false };
      return agentFail(error instanceof Error ? error.message : "Could not save the run.", "RUN_SAVE_FAILED", true);
    }
  });

/**
 * Everything about one run: what it set out to do, the funnel it measured, the
 * prospects it found, and what has happened to them since — sends, replies and
 * outcomes counted from the rows that exist today.
 */
export const getRunDetail = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ id: str((input as { id?: unknown })?.id, 64) }))
  .handler(async ({ data, context }) => {
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const sql = await getSql();
      const run = await store.loadRunRow(sql, context.userId, data.id);
      if (!run) return { ok: false as const, error: "That run no longer exists." };
      const leads = (await store.loadLeads(sql, context.userId)).filter((lead) => run.leadIds.includes(lead.id));
      const emails = (await store.loadEmails(sql, context.userId)).filter(
        (email) => email.runId === run.id || run.leadIds.includes(email.leadId),
      );
      return { ok: true as const, run, leads, emails };
    } catch (error) {
      console.error("[outreach] run detail failed:", error);
      return { ok: false as const, error: "Could not load that run." };
    }
  });

/** Every recorded run, newest first. Runs abandoned mid-way are closed as interrupted. */
export const listRuns = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const sql = await getSql();
      await store.closeAbandonedRuns(sql, context.userId).catch(() => undefined);
      const runs = await store.loadRunRows(sql, context.userId, 50);
      return { ok: true as const, runs };
    } catch (error) {
      if (isMissingTable(error)) return { ok: true as const, runs: [] };
      console.error("[outreach] list runs failed:", error);
      return { ok: false as const, error: "Could not load run history." };
    }
  });

/** What discovery recorded about these leads' websites and emails. */
export const getEvidence = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => ({ leadIds: idList((input as { leadIds?: unknown })?.leadIds, 500) }))
  .handler(async ({ data, context }) => {
    try {
      const { getSql } = await import("@/lib/db");
      const store = await import("./store.server.ts");
      const evidence = await store.loadLeadEvidence(await getSql(), context.userId, data.leadIds);
      return { ok: true as const, evidence };
    } catch (error) {
      if (isMissingTable(error)) return { ok: true as const, evidence: [] };
      return { ok: false as const, error: "Could not load evidence." };
    }
  });
