import { useMemo, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { BarChart3, Home, Inbox, KanbanSquare, Loader2, Phone, Search, Send, Settings, Users } from "lucide-react";

import { callQueue } from "@/lib/outreach/call-queue";
import { sendQueue } from "@/components/app/send-queue";
import type { Lead } from "@/lib/leads";
import { liveLeads } from "@/lib/leads";
import { cn } from "@/lib/utils";
import { useAppData } from "@/components/app/app-data";

type NavItem = { to: string; label: string; icon: typeof Home; count?: number; tone?: "attention"; matches: string[] };

/**
 * Five places. Today is where the work is (replies, sending and calls are
 * reached from it); Businesses holds every prospect and Find; Pipeline is the
 * sale; Insights is what is working; Settings is setup.
 */
function useNavItems(): { main: NavItem[]; queues: NavItem[] } {
  const { state } = useAppData();
  const leads = useMemo(() => (state?.leads ?? []) as unknown as Lead[], [state]);
  return useMemo(() => {
    const emails = state?.emails ?? [];
    const queue = state ? sendQueue(state) : null;
    const ready = queue?.ready.length ?? 0;
    const failed = queue?.failed.length ?? 0;
    const newReplies = emails.filter((email) => email.status === "replied" && (email.replyStage || "new") === "new").length;
    const calls = callQueue(liveLeads(leads)).today.length;
    return {
      main: [
        { to: "/", label: "Today", icon: Home, count: newReplies + failed, tone: newReplies + failed ? "attention" : undefined, matches: ["/", "/replies", "/send", "/calls"] },
        { to: "/prospects", label: "Businesses", icon: Users, matches: ["/prospects", "/businesses", "/find", "/leads"] },
        { to: "/pipeline", label: "Pipeline", icon: KanbanSquare, matches: ["/pipeline"] },
        { to: "/analytics", label: "Insights", icon: BarChart3, matches: ["/analytics", "/runs", "/campaigns"] },
        { to: "/settings", label: "Settings", icon: Settings, matches: ["/settings"] },
      ],
      queues: [
        { to: "/replies", label: "Replies", icon: Inbox, count: newReplies, tone: newReplies ? "attention" : undefined, matches: ["/replies"] },
        { to: "/send", label: "Ready to send", icon: Send, count: ready + failed, tone: failed ? "attention" : undefined, matches: ["/send"] },
        { to: "/calls", label: "Call list", icon: Phone, count: calls, matches: ["/calls"] },
      ],
    };
  }, [state, leads]);
}

function isActive(pathname: string, item: Pick<NavItem, "matches">): boolean {
  return item.matches.some((to) => (to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`)));
}

function Count({ value, tone }: { value?: number; tone?: "attention" }) {
  if (!value) return null;
  return (
    <span
      className={cn(
        "ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium tabular",
        tone === "attention" ? "bg-bad/90 text-bg" : "bg-surface-2 text-muted",
      )}
    >
      {value > 99 ? "99+" : value}
    </span>
  );
}

function GmailStatus({ compact = false }: { compact?: boolean }) {
  const { state } = useAppData();
  if (!state) return null;
  const connection = state.connection;
  const tone =
    connection.status === "connected" ? "bg-good" : connection.status === "needs_attention" ? "bg-bad" : "bg-subtle";
  const label =
    connection.status === "connected"
      ? connection.email
      : connection.status === "needs_attention"
        ? "Gmail needs attention"
        : "Gmail not connected";
  return (
    <Link
      to="/settings"
      search={{ section: "gmail" } as never}
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
    >
      <span className={cn("size-2 shrink-0 rounded-full", tone)} aria-hidden />
      <span className="truncate">{label}</span>
      {!compact ? (
        <span className="ml-auto shrink-0 tabular text-subtle">
          {state.allowance.sent}/{state.allowance.limit}
        </span>
      ) : null}
    </Link>
  );
}

function Sidebar({ pathname }: { pathname: string }) {
  const { main, queues } = useNavItems();
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-bg md:flex">
      <div className="flex h-16 items-center gap-2.5 px-5">
        <Mark />
        <div className="leading-tight">
          <p className="font-display text-[15px] font-medium tracking-tight">Peak Swift</p>
          <p className="text-[11px] tracking-wide text-subtle">Prospecting</p>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2" aria-label="Main">
        {main.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-(--motion-quick)",
              isActive(pathname, item) ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface hover:text-fg",
            )}
            aria-current={isActive(pathname, item) ? "page" : undefined}
          >
            <item.icon className="size-4 shrink-0" />
            {item.label}
            <Count value={item.count} tone={item.tone} />
          </Link>
        ))}
        <Link to="/find" className="mt-3 flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-2.5 text-sm font-medium text-accent-fg">
          <Search className="size-4" /> Find prospects
        </Link>
        <p className="mt-5 px-2.5 text-[11px] font-medium tracking-wider text-subtle uppercase">Queues</p>
        {queues.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors duration-(--motion-quick)",
              pathname === item.to ? "bg-surface-2 text-fg" : "text-subtle hover:bg-surface hover:text-fg",
            )}
          >
            <item.icon className="size-3.5 shrink-0" />
            {item.label}
            <Count value={item.count} tone={item.tone} />
          </Link>
        ))}
      </nav>
      <div className="border-t border-border p-3">
        <GmailStatus />
      </div>
    </aside>
  );
}

function Mark() {
  return (
    <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-accent" />
      <path d="M8 22 L14 11 L18 17 L20.5 13 L24 22 Z" className="fill-accent-fg" />
    </svg>
  );
}

function MobileBar({ pathname }: { pathname: string }) {
  const { main } = useNavItems();
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      aria-label="Main"
    >
      <div className="grid grid-cols-5">
        {main.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cn("relative flex h-16 flex-col items-center justify-center gap-1 text-[11px]", isActive(pathname, item) ? "text-fg" : "text-subtle")}
            aria-current={isActive(pathname, item) ? "page" : undefined}
          >
            <item.icon className="size-5" />
            {item.label}
            {item.count ? (
              <span
                className={cn(
                  "absolute top-2 left-1/2 ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular",
                  item.tone === "attention" ? "bg-bad text-bg" : "bg-accent text-accent-fg",
                )}
              >
                {item.count > 99 ? "99+" : item.count}
              </span>
            ) : null}
          </Link>
        ))}
      </div>
    </nav>
  );
}

function RunPill({ pathname }: { pathname: string }) {
  const { prospecting } = useAppData();
  if (!prospecting.running || pathname === "/find") return null;
  return (
    <Link
      to="/find"
      className="rise-in fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg shadow-(--shadow-overlay) md:bottom-6"
    >
      <Loader2 className="size-4 shrink-0 animate-spin" />
      <span className="truncate">{prospecting.run.detail || "Finding prospects…"}</span>
    </Link>
  );
}

/**
 * The frame around every screen. Pages decide their own padding; the shell
 * only reserves room for the sidebar and the phone's tab bar.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (router) => router.location.pathname });
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <Sidebar pathname={pathname} />
      <div className="flex min-h-dvh min-w-0 flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0 md:pl-60">{children}</div>
      <MobileBar pathname={pathname} />
      <RunPill pathname={pathname} />
    </div>
  );
}

/** Standard page padding and width. */
export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main
      className={cn(
        "mx-auto flex w-full flex-col gap-6 px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-10 md:px-8 md:pt-8",
        wide ? "max-w-6xl" : "max-w-4xl",
      )}
    >
      {children}
    </main>
  );
}
