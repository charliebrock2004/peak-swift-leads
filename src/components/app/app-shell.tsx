import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  Flag,
  History,
  Home,
  Inbox,
  Loader2,
  Menu,
  Phone,
  Search,
  Send,
  Settings,
  Table2,
  Users,
  X,
} from "lucide-react";

import { callQueue } from "@/lib/outreach/call-queue";
import { sendQueue } from "@/components/app/send-queue";
import { useLeadsStore } from "@/store/leads-store";
import { liveLeads } from "@/lib/leads";
import { cn } from "@/lib/utils";
import { useAppData } from "@/components/app/app-data";

type NavItem = { to: string; label: string; icon: typeof Home; count?: number; tone?: "attention" };

function useNavItems(): NavItem[] {
  const { state } = useAppData();
  const leads = useLeadsStore((store) => store.leads);
  return useMemo(() => {
    const emails = state?.emails ?? [];
    const queue = state ? sendQueue(state) : null;
    const ready = queue?.ready.length ?? 0;
    const failed = queue?.failed.length ?? 0;
    const newReplies = emails.filter((email) => email.status === "replied" && (email.replyStage || "new") === "new").length;
    const calls = callQueue(liveLeads(leads)).today.length;
    return [
      { to: "/", label: "Home", icon: Home },
      { to: "/find", label: "Find prospects", icon: Search },
      { to: "/send", label: "Ready to send", icon: Send, count: ready + failed, tone: failed ? "attention" : undefined },
      { to: "/calls", label: "Call list", icon: Phone, count: calls },
      { to: "/replies", label: "Replies", icon: Inbox, count: newReplies, tone: newReplies ? "attention" : undefined },
      { to: "/prospects", label: "Prospects", icon: Users },
      { to: "/campaigns", label: "Campaigns", icon: Flag },
      { to: "/runs", label: "Run history", icon: History },
      { to: "/analytics", label: "Analytics", icon: BarChart3 },
      { to: "/leads", label: "Lead sheet", icon: Table2 },
      { to: "/settings", label: "Settings", icon: Settings },
    ];
  }, [state, leads]);
}

const MOBILE_PRIMARY = ["/", "/find", "/send", "/calls", "/replies"];

function isActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
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
  const items = useNavItems();
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
        {items.map((item, index) => (
          <div key={item.to}>
            {index === 5 || index === 9 ? <div className="my-2 h-px bg-border" /> : null}
            <Link
              to={item.to}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-(--motion-quick)",
                isActive(pathname, item.to) ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface hover:text-fg",
              )}
              aria-current={isActive(pathname, item.to) ? "page" : undefined}
            >
              <item.icon className="size-4 shrink-0" />
              {item.label}
              <Count value={item.count} tone={item.tone} />
            </Link>
          </div>
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

function MobileBar({ pathname, onMore }: { pathname: string; onMore: () => void }) {
  const items = useNavItems().filter((item) => MOBILE_PRIMARY.includes(item.to));
  const short: Record<string, string> = { "/": "Home", "/find": "Find", "/send": "Send", "/calls": "Calls", "/replies": "Replies" };
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      aria-label="Main"
    >
      <div className="grid grid-cols-6">
        {items.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              "relative flex h-16 flex-col items-center justify-center gap-1 text-[11px]",
              isActive(pathname, item.to) ? "text-fg" : "text-subtle",
            )}
            aria-current={isActive(pathname, item.to) ? "page" : undefined}
          >
            <item.icon className="size-5" />
            {short[item.to]}
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
        <button type="button" onClick={onMore} className="flex h-16 flex-col items-center justify-center gap-1 text-[11px] text-subtle">
          <Menu className="size-5" />
          More
        </button>
      </div>
    </nav>
  );
}

function MoreSheet({ open, onClose, pathname }: { open: boolean; onClose: () => void; pathname: string }) {
  const items = useNavItems().filter((item) => !MOBILE_PRIMARY.includes(item.to));
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="More">
      <button type="button" className="absolute inset-0 bg-bg/70" aria-label="Close menu" onClick={onClose} />
      <div className="rise-in absolute inset-x-0 bottom-0 rounded-t-2xl bg-surface p-3 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-(--shadow-overlay)">
        <div className="flex items-center justify-between px-2 pb-2">
          <p className="text-xs font-medium tracking-widest text-subtle uppercase">More</p>
          <button type="button" onClick={onClose} className="flex size-10 items-center justify-center rounded-md text-muted" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="grid gap-1">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={cn(
                "flex h-12 items-center gap-3 rounded-lg px-3 text-sm",
                isActive(pathname, item.to) ? "bg-surface-2 text-fg" : "text-muted",
              )}
            >
              <item.icon className="size-5" />
              {item.label}
              <Count value={item.count} tone={item.tone} />
            </Link>
          ))}
        </div>
        <div className="mt-2 border-t border-border pt-2">
          <GmailStatus compact />
        </div>
      </div>
    </div>
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
 * The frame around every screen. The lead sheet brings its own full-height
 * layout, so pages decide their own padding; the shell only reserves room for
 * the sidebar and the phone's tab bar.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (router) => router.location.pathname });
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <Sidebar pathname={pathname} />
      <div className="flex min-h-dvh min-w-0 flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0 md:pl-60">{children}</div>
      <MobileBar pathname={pathname} onMore={() => setMoreOpen(true)} />
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} pathname={pathname} />
      <RunPill pathname={pathname} />
    </div>
  );
}

/** Standard page padding and width for everything except the lead sheet. */
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
