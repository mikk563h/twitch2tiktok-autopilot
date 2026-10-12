import type { ReactNode } from "react";
import { STATUS_LABELS, type ClipStatus } from "@/lib/clips";

export function cn(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(" ");
}

const STATUS_TONE: Record<ClipStatus, string> = {
  BASELINE: "bg-faint/15 text-muted border-faint/30",
  DISCOVERED: "bg-info/10 text-info border-info/30",
  QUEUED: "bg-info/10 text-info border-info/30",
  DOWNLOADING: "bg-accent-soft text-accent-2 border-accent/30",
  DOWNLOADED: "bg-accent-soft text-accent-2 border-accent/30",
  ANALYZING: "bg-accent-soft text-accent-2 border-accent/30",
  EDITING: "bg-accent-soft text-accent-2 border-accent/30",
  READY: "bg-ok/10 text-ok border-ok/30",
  UPLOADING: "bg-accent-soft text-accent-2 border-accent/30",
  PROCESSING: "bg-accent-soft text-accent-2 border-accent/30",
  PUBLISHED: "bg-ok/15 text-ok border-ok/40",
  RETRY_WAIT: "bg-warn/10 text-warn border-warn/30",
  BLOCKED_PERMISSION: "bg-bad/10 text-bad border-bad/30",
  NEEDS_USER_ACTION: "bg-warn/15 text-warn border-warn/40",
  FAILED: "bg-bad/15 text-bad border-bad/40",
};

const ACTIVE: ClipStatus[] = ["DOWNLOADING", "ANALYZING", "EDITING", "UPLOADING", "PROCESSING"];

export function StatusBadge({ status }: { status: ClipStatus }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", STATUS_TONE[status])}>
      {ACTIVE.includes(status) && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {STATUS_LABELS[status]}
    </span>
  );
}

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";
const DOT: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info", muted: "bg-faint" };
const TEXT: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", info: "text-info", muted: "text-muted" };

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5">
      {pulse && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-50", DOT[tone])} />}
      <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", DOT[tone])} />
    </span>
  );
}

export function StatusLine({ tone, title, detail }: { tone: Tone; title: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="pt-1.5"><Dot tone={tone} pulse={tone === "ok"} /></div>
      <div className="min-w-0">
        <div className={cn("text-sm font-medium", tone === "ok" ? "text-fg" : TEXT[tone])}>{title}</div>
        {detail && <div className="mt-0.5 text-xs text-muted">{detail}</div>}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("card", className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: Tone; sub?: ReactNode }) {
  return (
    <div className="card card-pad">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={cn("mt-2 text-3xl font-semibold tabular-nums", tone && tone !== "muted" ? TEXT[tone] : "")}>{value}</div>
      {sub && <div className="mt-1 text-xs text-faint">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted">{children}</div>;
}

export function Notice({ tone, children }: { tone: Tone; children: ReactNode }) {
  const styles: Record<Tone, string> = {
    ok: "border-ok/30 bg-ok/5 text-ok", warn: "border-warn/30 bg-warn/5 text-warn", bad: "border-bad/30 bg-bad/5 text-bad",
    info: "border-info/30 bg-info/5 text-info", muted: "border-border bg-surface-2 text-muted",
  };
  return <div className={cn("rounded-lg border px-4 py-3 text-sm", styles[tone])}>{children}</div>;
}

export function ago(d: Date | string | null | undefined): string {
  if (!d) return "aldrig";
  const t = typeof d === "string" ? Date.parse(d) : d.getTime();
  const s = Math.round((Date.now() - t) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const txt = a < 60 ? `${a} sek` : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} t` : `${Math.round(a / 86400)} d`;
  return future ? `om ${txt}` : `for ${txt} siden`;
}

export function dt(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("da-DK", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Copenhagen" });
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
