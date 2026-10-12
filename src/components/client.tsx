"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useActionState, useEffect, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

export type ActionResult = { ok: boolean; message: string } | null;

export function AutoRefresh({ ms = 5000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, ms);
    return () => clearInterval(t);
  }, [ms, router]);
  return null;
}

export function SubmitButton({ children, className = "btn-primary", pendingText, name, value, confirm }: { children: ReactNode; className?: string; pendingText?: string; name?: string; value?: string; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} disabled={pending} className={className}
      onClick={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
      {pending && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {pending ? pendingText ?? children : children}
    </button>
  );
}

/** Form bound to a server action returning {ok, message}; shows the result inline. */
export function ActionForm({ action, children, className }: { action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>; children: ReactNode; className?: string }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={className}>
      {children}
      {state && (
        <p className={`mt-3 rounded-lg border px-3 py-2 text-sm ${state.ok ? "border-ok/30 bg-ok/5 text-ok" : "border-bad/30 bg-bad/5 text-bad"}`}>{state.message}</p>
      )}
    </form>
  );
}

const NAV = [
  { href: "/", label: "Overview", icon: "M3 12l9-9 9 9M5 10v10h14V10" },
  { href: "/clips", label: "Clip Library", icon: "M4 6h16M4 12h16M4 18h10" },
  { href: "/queue", label: "Upload Queue", icon: "M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" },
  { href: "/hashtags", label: "Hashtag Manager", icon: "M9 3L7 21M17 3l-2 18M4 8h17M3 16h17" },
  { href: "/editor", label: "Video Editor", icon: "M4 5h16v14H4zM10 9l5 3-5 3z" },
  { href: "/automation", label: "Automation", icon: "M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3" },
  { href: "/accounts", label: "Accounts", icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM4 21a8 8 0 0116 0" },
  { href: "/health", label: "System Health", icon: "M3 12h4l3-8 4 16 3-8h4" },
  { href: "/setup", label: "Setup Wizard", icon: "M5 13l4 4L19 7" },
];

export function Sidebar({ badges }: { badges: Record<string, number> }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const nav = (
    <nav className="space-y-1">
      {NAV.map((n) => {
        const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} onClick={() => setOpen(false)}
            className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${active ? "bg-accent-soft text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}>
            <svg viewBox="0 0 24 24" className={`h-4 w-4 ${active ? "text-accent-2" : "text-faint group-hover:text-muted"}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={n.icon} /></svg>
            <span className="flex-1">{n.label}</span>
            {badges[n.href] ? <span className="rounded-full bg-warn/15 px-1.5 text-xs font-semibold text-warn">{badges[n.href]}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
  return (
    <>
      <button className="btn-ghost fixed left-3 top-3 z-40 lg:hidden" onClick={() => setOpen(!open)} aria-label="Menu">☰</button>
      <aside className={`fixed inset-y-0 left-0 z-30 w-60 border-r border-border bg-surface/95 px-3 py-5 backdrop-blur transition-transform lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <Link href="/" className="mb-7 flex items-center gap-2.5 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-fuchsia-500 text-xs font-bold text-white">T2</div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Twitch2TikTok</div>
            <div className="text-[11px] text-faint">Autopilot</div>
          </div>
        </Link>
        {nav}
        <form action="/api/logout" method="post" className="absolute inset-x-3 bottom-4">
          <button className="w-full rounded-lg px-3 py-2 text-left text-sm text-faint hover:bg-surface-2 hover:text-muted">Log ud</button>
        </form>
      </aside>
    </>
  );
}

export function TagEditor({ name, initial, placeholder }: { name: string; initial: string[]; placeholder?: string }) {
  const [tags, setTags] = useState(initial);
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const parts = raw.split(/[\s,]+/).map((t) => t.replace(/^#+/, "").trim()).filter(Boolean);
    setTags((cur) => {
      const next = [...cur];
      for (const p of parts) if (!next.some((t) => t.toLowerCase() === p.toLowerCase())) next.push(p);
      return next;
    });
    setDraft("");
  };
  return (
    <div className="rounded-lg border border-border bg-bg p-2 focus-within:border-accent">
      <input type="hidden" name={name} value={tags.join(",")} />
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t, i) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-2 py-1 text-sm text-accent-2">
            <span className="cursor-default" title={i === 0 ? "Højeste prioritet" : undefined}>#{t}</span>
            {i > 0 && <button type="button" className="text-faint hover:text-fg" title="Flyt op" onClick={() => setTags((c) => { const n = [...c]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}>↑</button>}
            <button type="button" className="text-faint hover:text-bad" onClick={() => setTags((c) => c.filter((x) => x !== t))} aria-label={`Fjern ${t}`}>×</button>
          </span>
        ))}
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder ?? "Tilføj hashtag og tryk Enter"}
          className="min-w-40 flex-1 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-faint"
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "," || e.key === " ") { e.preventDefault(); if (draft.trim()) add(draft); } else if (e.key === "Backspace" && !draft) setTags((c) => c.slice(0, -1)); }}
          onBlur={() => draft.trim() && add(draft)} />
      </div>
    </div>
  );
}

export function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn-ghost text-xs" onClick={() => { void navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? "Kopieret ✓" : "Kopiér"}
    </button>
  );
}

export function RangeField({ name, label, min, max, step, defaultValue, format, hint }: { name: string; label: string; min: number; max: number; step: number; defaultValue: number; format?: "pct" | "x" | "num"; hint?: string }) {
  const [v, setV] = useState(defaultValue);
  const shown = format === "pct" ? `${Math.round(v * 100)}%` : format === "x" ? `${v.toFixed(2)}×` : String(v);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between"><span className="label mb-0">{label}</span><span className="font-mono text-xs text-accent-2">{shown}</span></div>
      <input type="range" name={name} min={min} max={max} step={step} value={v} onChange={(e) => setV(Number(e.target.value))} className="w-full accent-[#8b5cf6]" />
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/** Facecam rectangle editor over a still frame (normalised 0..1 coordinates). */
export function FacecamPicker({ image, initial, enabledName, enabledDefault }: { image: string | null; initial: { x: number; y: number; w: number; h: number } | null; enabledName?: string; enabledDefault?: boolean }) {
  const [r, setR] = useState(initial ?? { x: 0.74, y: 0.04, w: 0.24, h: 0.26 });
  const [enabled, setEnabled] = useState(enabledDefault ?? !!initial);
  const field = (k: keyof typeof r, label: string) => (
    <label className="text-xs text-muted">{label}
      <input type="number" step="0.01" min={0} max={1} name={`f${k}`} value={r[k]} onChange={(e) => setR({ ...r, [k]: Number(e.target.value) })} className="input mt-1 py-1.5" />
    </label>
  );
  return (
    <div className="space-y-3">
      {enabledName && (
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={enabledName} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-[#8b5cf6]" /> Brug denne facecam-position</label>
      )}
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-surface-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {image && <img src={image} alt="" className="h-full w-full object-cover opacity-80" />}
        {enabled && <div className="absolute border-2 border-accent bg-accent/20 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />}
      </div>
      <div className="grid grid-cols-4 gap-2">{field("x", "X")}{field("y", "Y")}{field("w", "Bredde")}{field("h", "Højde")}</div>
    </div>
  );
}
