/**
 * Welcome: seven short questions on one screen, then the first 20 prospects.
 *
 * Not a wizard. Everything here is the workspace profile (Settings → Business
 * has the rest), and every answer is used straight away: the areas and trades
 * are the search, the contact method decides who is queued, the price shapes
 * scoring, the website and examples go to the writer.
 */
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Loader2, Mail, Plus, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Page } from "@/components/app/app-shell";
import { useAppData } from "@/components/app/app-data";
import { WithState } from "@/components/app/setup-gate";
import { Card, Segmented } from "@/components/app/ui";
import { TRADE_SUGGESTIONS } from "@/lib/leads";
import { MAX_TRADES } from "@/lib/outreach/auto-run";
import { profileList, type BusinessProfile } from "@/lib/outreach/profile";
import { saveBusinessProfile, type OutreachState } from "@/lib/outreach/server";
import { tradeTier } from "@/lib/scoring/trade-value";
import { friendlyServerError } from "@/lib/server-errors";
import { cn } from "@/lib/utils";

const AREAS = ["Perthshire", "Perth", "Stirling", "Dundee", "Fife", "Edinburgh", "Glasgow", "Aberdeen"];
/** Suggestions, the trades that buy bigger jobs first. */
const TIER_ORDER = { high: 0, medium: 1, unknown: 2, low: 3, excluded: 4 } as const;
const SUGGESTED = [...TRADE_SUGGESTIONS].sort((a, b) => TIER_ORDER[tradeTier(a)] - TIER_ORDER[tradeTier(b)]);
const FIRST_RUN = 20;

export function WelcomePage() {
  return (
    <Page>
      <WithState>{(state) => <Welcome state={state} />}</WithState>
    </Page>
  );
}

function Question({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-labelledby={`q-${n}`}>
      <div className="flex items-baseline gap-2">
        <span className="w-5 shrink-0 text-sm text-subtle tabular">{n}</span>
        <div>
          <h2 id={`q-${n}`} className="text-[15px] font-medium">
            {title}
          </h2>
          {hint ? <p className="text-xs text-muted">{hint}</p> : null}
        </div>
      </div>
      <div className="flex flex-col gap-2 pl-7">{children}</div>
    </section>
  );
}

function Welcome({ state }: { state: OutreachState }) {
  const { prospecting, reload } = useAppData();
  const navigate = useNavigate();
  const saved = state.profileSaved;
  const [profile, setProfile] = useState<BusinessProfile>({
    ...state.profile,
    // Defaults are the app's, not yours: start empty where the answer matters.
    businessName: saved ? state.profile.businessName : "",
    senderName: saved ? state.profile.senderName : "",
    services: saved ? state.profile.services : "",
    website: saved ? state.profile.website : "",
  });
  const [areas, setAreas] = useState<string[]>(profileList(state.profile.targetAreas));
  const [area, setArea] = useState("");
  const [trades, setTrades] = useState<string[]>(profileList(state.profile.targetTrades).slice(0, MAX_TRADES));
  const [trade, setTrade] = useState("");
  const [busy, setBusy] = useState<"" | "find" | "save">("");
  const set = (key: keyof BusinessProfile, value: string) => setProfile((current) => ({ ...current, [key]: value }));

  const addTo = (list: string[], value: string, max: number) =>
    value.trim().length >= 2 && !list.some((item) => item.toLowerCase() === value.trim().toLowerCase()) && list.length < max ? [...list, value.trim()] : list;
  const toggle = (list: string[], value: string, max: number) =>
    list.some((item) => item.toLowerCase() === value.toLowerCase()) ? list.filter((item) => item.toLowerCase() !== value.toLowerCase()) : addTo(list, value, max);

  const problem = areas.length === 0 ? "Say where you sell (question 3)." : trades.length === 0 ? "Choose at least one kind of business (question 4)." : "";
  const gmail = state.connection.status === "connected";

  const save = async (): Promise<boolean> => {
    const payload = {
      ...profile,
      targetAreas: areas.join(", "),
      targetTrades: trades.join(", "),
      // The writer says where you work; your search areas are the honest answer.
      areasServed: profile.areasServed.trim() && saved ? profile.areasServed : areas.join(", "),
      location: profile.location.trim() && saved ? profile.location : (areas[0] ?? ""),
      onboarded: true,
    };
    const result = await saveBusinessProfile({ data: payload }).catch((error: unknown) => ({ ok: false as const, error: friendlyServerError(error) }));
    if (!result.ok) {
      toast(result.error);
      return false;
    }
    if (result.problems.length) toast(result.problems.map((item) => item.message).join(" "));
    return true;
  };

  const findFirst = async () => {
    if (problem || prospecting.running) return;
    setBusy("find");
    const ok = await save();
    if (!ok) return setBusy("");
    await reload();
    const names = trades.map((item) => (/s$/i.test(item) ? item : `${item}s`));
    void prospecting.start({
      location: areas.join(", "),
      trades,
      target: FIRST_RUN,
      dailyLimit: Math.min(10, state.settings.dailyLimit),
      radiusMiles: 25,
      campaignId: "",
      campaignName: `${areas[0]} ${names.slice(0, 3).join(" & ")}`.slice(0, 60),
    });
    void navigate({ to: "/find" });
  };

  const saveOnly = async () => {
    setBusy("save");
    const ok = await save();
    setBusy("");
    if (!ok) return;
    await reload();
    toast("Saved. Find uses it whenever you're ready.");
    void navigate({ to: "/" });
  };

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium tracking-widest text-subtle uppercase">Welcome</p>
        <h1 className="font-display text-[1.9rem] leading-tight font-medium tracking-tight md:text-[2.25rem]">Your first 20 prospects</h1>
        <p className="text-sm text-muted">Seven quick answers. PeakSwift searches, checks each business's website and contact details, and ranks the ones worth your time.</p>
      </header>

      <Card className="flex flex-col gap-7 p-5 md:p-6">
        <Question n={1} title="What do you sell?" hint="In your own words — the emails use it as written.">
          <Input value={profile.services} onChange={(event) => set("services", event.target.value)} placeholder="Simple, fast websites for local trades" className="h-11" aria-label="What you sell" />
          <div className="grid grid-cols-2 gap-2">
            <Input value={profile.businessName} onChange={(event) => set("businessName", event.target.value)} placeholder="Business name" className="h-11" aria-label="Business name" />
            <Input value={profile.senderName} onChange={(event) => set("senderName", event.target.value)} placeholder="Your first name" className="h-11" aria-label="Your first name" />
          </div>
        </Question>

        <Question n={2} title="What's a typical project worth?" hint="Whole pounds. Used to weigh up trades and to compare with what you win.">
          <div className="grid grid-cols-2 gap-2">
            <Input inputMode="numeric" value={profile.typicalProject} onChange={(event) => set("typicalProject", event.target.value)} placeholder="Typical, e.g. 2500" className="h-11" aria-label="Typical project value in pounds" />
            <Input inputMode="numeric" value={profile.minimumProject} onChange={(event) => set("minimumProject", event.target.value)} placeholder="Smallest you'd take" className="h-11" aria-label="Smallest project in pounds" />
          </div>
        </Question>

        <Question n={3} title="Where do you sell?" hint="Towns or regions. A region is searched town by town.">
          {areas.length ? (
            <div className="flex flex-wrap gap-1.5">
              {areas.map((item) => (
                <button key={item} type="button" onClick={() => setAreas(toggle(areas, item, 6))} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-accent pr-2.5 pl-3.5 text-sm font-medium text-accent-fg" aria-label={`Remove ${item}`}>
                  {item}
                  <X className="size-3.5" />
                </button>
              ))}
            </div>
          ) : null}
          <div className="scroll-x -mx-1 flex gap-1.5 px-1">
            {AREAS.filter((item) => !areas.includes(item)).map((item) => (
              <button key={item} type="button" onClick={() => setAreas(toggle(areas, item, 6))} className="h-8 shrink-0 rounded-full bg-surface-2 px-3 text-xs font-medium text-muted hover:text-fg">
                {item}
              </button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setAreas(addTo(areas, area, 6));
              setArea("");
            }}
          >
            <Input value={area} onChange={(event) => setArea(event.target.value)} placeholder="Another town or region" className="h-10" aria-label="Add a town or region" />
            <Button type="submit" variant="secondary" aria-label="Add area">
              <Plus />
            </Button>
          </form>
        </Question>

        <Question n={4} title="Which businesses do you want?" hint={`Up to ${MAX_TRADES}. Trades that sell bigger jobs usually pay for a proper website.`}>
          {trades.length ? (
            <div className="flex flex-wrap gap-1.5">
              {trades.map((item) => (
                <button key={item} type="button" onClick={() => setTrades(toggle(trades, item, MAX_TRADES))} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-accent pr-2.5 pl-3.5 text-sm font-medium text-accent-fg" aria-label={`Remove ${item}`}>
                  {item}
                  <X className="size-3.5" />
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED.filter((item) => !trades.some((chosen) => chosen.toLowerCase() === item.toLowerCase()))
              .slice(0, 12)
              .map((item) => (
                <button key={item} type="button" disabled={trades.length >= MAX_TRADES} onClick={() => setTrades(toggle(trades, item, MAX_TRADES))} className="h-8 rounded-full bg-surface-2 px-3 text-xs font-medium text-muted hover:text-fg disabled:opacity-40">
                  {item}
                </button>
              ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setTrades(addTo(trades, trade, MAX_TRADES));
              setTrade("");
            }}
          >
            <Input value={trade} onChange={(event) => setTrade(event.target.value)} placeholder="Another trade, e.g. Stonemason" className="h-10" aria-label="Add a trade" />
            <Button type="submit" variant="secondary" aria-label="Add trade" disabled={trades.length >= MAX_TRADES}>
              <Plus />
            </Button>
          </form>
        </Question>

        <Question n={5} title="Email, phone or both?" hint="How you're happy to make first contact. A channel you don't use is never suggested.">
          <Segmented
            label="How you make first contact"
            value={(profile.contactMethods || "both") as "email" | "phone" | "both"}
            onChange={(value) => set("contactMethods", value)}
            options={[
              { id: "both", label: "Both" },
              { id: "email", label: "Email" },
              { id: "phone", label: "Phone" },
            ]}
          />
        </Question>

        <Question n={6} title="Your website, and work you can point to" hint="Optional. The writer may mention one example, exactly as you put it.">
          <Input value={profile.website} onChange={(event) => set("website", event.target.value)} placeholder="yourstudio.co.uk" className="h-11" aria-label="Your website" />
          <Input value={profile.examples} onChange={(event) => set("examples", event.target.value)} placeholder="e.g. New site for a Perth roofer — more quote requests" className="h-11" aria-label="Past work you can mention" />
        </Question>

        <Question n={7} title="Connect your email?" hint="Only needed to send. Finding and checking prospects works without it.">
          {gmail ? (
            <p className="flex items-center gap-1.5 text-sm text-good">
              <Check className="size-4" /> Gmail is connected{state.connection.email ? ` (${state.connection.email})` : ""}.
            </p>
          ) : (
            <Link to="/settings" search={{ section: "gmail" } as never} className="self-start">
              <Button variant="secondary" type="button">
                <Mail /> Connect Gmail
              </Button>
            </Link>
          )}
        </Question>
      </Card>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button className="h-12 text-[15px] sm:w-auto" disabled={Boolean(problem) || busy !== "" || prospecting.running} onClick={() => void findFirst()}>
          {busy === "find" ? <Loader2 className="animate-spin" /> : <Search />}
          Find my first {FIRST_RUN} prospects
        </Button>
        <Button variant="ghost" className="h-12" disabled={busy !== ""} onClick={() => void saveOnly()}>
          {busy === "save" ? <Loader2 className="animate-spin" /> : null}
          Save and look around first
        </Button>
      </div>
      {problem ? <p className="-mt-2 text-sm text-muted">{problem}</p> : prospecting.running ? <p className="-mt-2 text-sm text-muted">A Find run is already going — it's on the Find page.</p> : null}
      <p className={cn("text-xs text-subtle", problem ? "" : "-mt-2")}>Nothing is sent. Every email waits for you to read and approve it.</p>
    </>
  );
}
