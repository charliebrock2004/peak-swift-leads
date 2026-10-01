/**
 * The small set of building blocks every screen is made from.
 *
 * Deliberately few: a card, a stat, a badge, a section heading, an empty state,
 * a progress bar, a segmented control. Consistency comes from reusing these,
 * not from each screen styling itself.
 */
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

import type { Tone } from "./format";
import { toneText } from "./format";

export type { Tone };

const TONE_BADGE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  good: "bg-good/12 text-good",
  warn: "bg-warn/12 text-warn",
  bad: "bg-bad/12 text-bad",
  info: "bg-info/12 text-info",
  accent: "bg-accent text-accent-fg",
};

export function Card({
  className,
  children,
  as: Tag = "section",
}: {
  className?: string;
  children: ReactNode;
  as?: "section" | "div" | "article" | "li";
}) {
  return <Tag className={cn("rounded-xl bg-surface shadow-(--shadow-border)", className)}>{children}</Tag>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="text-xs font-medium tracking-widest text-subtle uppercase">{eyebrow}</p> : null}
        <h1 className="mt-1 font-display text-[1.75rem] leading-tight font-medium tracking-tight md:text-[2rem]">{title}</h1>
        {description ? <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function SectionTitle({ children, action, id }: { children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="flex items-center justify-between gap-3" id={id}>
      <h2 className="text-xs font-medium tracking-widest text-subtle uppercase">{children}</h2>
      {action}
    </div>
  );
}

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap",
        TONE_BADGE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
  to,
  search,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  to?: string;
  search?: Record<string, string>;
  className?: string;
}) {
  const body = (
    <>
      <p className="text-xs text-muted">{label}</p>
      <p className={cn("mt-1 font-display text-[1.65rem] leading-none font-medium tabular", tone === "neutral" ? "text-fg" : toneText(tone))}>
        {value}
      </p>
      {sub ? <p className="mt-1.5 line-clamp-2 text-xs text-subtle">{sub}</p> : null}
    </>
  );
  const base = cn("block min-w-0 rounded-lg bg-surface px-4 py-3.5 shadow-(--shadow-border)", className);
  if (to) {
    return (
      <Link to={to} search={search as never} className={cn(base, "transition-shadow duration-(--motion-quick) hover:shadow-(--shadow-border-hover)")}>
        {body}
      </Link>
    );
  }
  return <div className={base}>{body}</div>;
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("px-6 py-12 text-center", className)}>
      {icon ? <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-surface-2 text-muted [&_svg]:size-5">{icon}</div> : null}
      <p className="mt-4 font-medium">{title}</p>
      {children ? <div className="mx-auto mt-1.5 max-w-md text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </Card>
  );
}

export function ProgressBar({ value, max, tone = "accent", className }: { value: number; max: number; tone?: Tone; className?: string }) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const fill =
    tone === "good" ? "bg-good" : tone === "warn" ? "bg-warn" : tone === "bad" ? "bg-bad" : tone === "info" ? "bg-info" : "bg-accent";
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-(--motion-fast) ease-(--ease-out)", fill)} style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: readonly { id: T; label: string; count?: number }[];
  onChange: (next: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("scroll-x -mx-1 flex gap-1 px-1", className)}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors duration-(--motion-quick)",
            value === option.id ? "bg-accent text-accent-fg" : "bg-surface text-muted shadow-(--shadow-border) hover:text-fg",
          )}
        >
          {option.label}
          {option.count !== undefined ? (
            <span className={cn("tabular text-xs", value === option.id ? "text-accent-fg/70" : "text-subtle")}>{option.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}

export function LoadingPage() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-9 w-56" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-40" />
    </div>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const bar =
    tone === "bad" ? "before:bg-bad" : tone === "warn" ? "before:bg-warn" : tone === "good" ? "before:bg-good" : "before:bg-info";
  return (
    <div
      className={cn(
        "relative flex flex-col gap-3 overflow-hidden rounded-lg bg-surface px-4 py-3 shadow-(--shadow-border) before:absolute before:inset-y-0 before:left-0 before:w-[3px] sm:flex-row sm:items-center sm:justify-between",
        bar,
        className,
      )}
      role={tone === "bad" ? "alert" : "status"}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {children ? <div className="mt-0.5 text-sm text-muted">{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 gap-2">{action}</div> : null}
    </div>
  );
}

/** A labelled form field. */
export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}

/** The opportunity score as a compact, colour-coded figure. */
export function ScoreBadge({ score, className }: { score: number; className?: string }) {
  const tone: Tone = score >= 70 ? "good" : score >= 45 ? "warn" : "neutral";
  return (
    <span
      className={cn(
        "inline-flex h-7 min-w-9 items-center justify-center rounded-md px-1.5 font-display text-sm font-medium tabular",
        TONE_BADGE[tone],
        className,
      )}
      title="Opportunity score"
    >
      {score}
    </span>
  );
}


/** Insights holds what is working, the run history and the campaigns: one place, three views. */
export function InsightsTabs({ current }: { current: "/analytics" | "/runs" | "/campaigns" }) {
  const tabs = [
    { to: "/analytics", label: "What's working" },
    { to: "/runs", label: "Runs" },
    { to: "/campaigns", label: "Campaigns" },
  ] as const;
  return (
    <nav aria-label="Insights" className="-mt-2 flex gap-1">
      {tabs.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          className={cn("h-9 rounded-full px-3.5 text-sm leading-9", current === tab.to ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg")}
          aria-current={current === tab.to ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
