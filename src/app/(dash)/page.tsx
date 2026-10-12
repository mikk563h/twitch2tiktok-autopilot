import Link from "next/link";
import { redirect } from "next/navigation";
import { overview } from "@/lib/dashboard";
import { getSettings } from "@/lib/settings";
import { TIKTOK_STATE_LABELS } from "@/lib/tiktok/state";
import { AutoRefresh, ActionForm, SubmitButton } from "@/components/client";
import { Card, PageHeader, Stat, StatusBadge, StatusLine, ago, Empty, type Tone } from "@/components/ui";
import { ClipThumb } from "@/components/clip-thumb";
import { scanNow } from "../actions";
import { config } from "@/lib/config";
import { latestRuns } from "@/lib/github";
import { BATCH_STALE_MS } from "@/lib/pipeline/maintenance";

export default async function OverviewPage() {
  const settings = await getSettings();
  if (!settings.setup.completedAt) redirect("/setup");
  const { counts, twitch, tiktok, workers, recent, alerts, today } = await overview();
  const batch = config.runMode === "batch";
  const runs = batch ? await latestRuns(3) : [];
  const n = (s: keyof typeof counts) => counts[s] ?? 0;
  const discovered = Object.entries(counts).filter(([k]) => k !== "BASELINE").reduce((s, [, v]) => s + v, 0);
  const edited = n("READY") + n("UPLOADING") + n("PROCESSING") + n("PUBLISHED") + n("NEEDS_USER_ACTION");
  const inQueue = n("DISCOVERED") + n("QUEUED") + n("DOWNLOADING") + n("DOWNLOADED") + n("ANALYZING") + n("EDITING") + n("READY") + n("UPLOADING") + n("PROCESSING") + n("RETRY_WAIT");
  const errors = n("FAILED") + n("BLOCKED_PERMISSION") + n("NEEDS_USER_ACTION");

  const scanAge = twitch.sync.lastSuccessAt ? Date.now() - Date.parse(twitch.sync.lastSuccessAt) : Infinity;
  const scanLimit = batch ? BATCH_STALE_MS : Math.max(5 * settings.automation.pollIntervalSec * 1000, 300_000);
  const twitchTone: Tone = !twitch.configured ? "bad" : !settings.automation.monitorEnabled ? "muted" : scanAge < scanLimit ? "ok" : "bad";
  const tiktokTone: Tone = tiktok.state === "PUBLIC_APPROVED" ? "ok" : tiktok.state === "PRIVATE_ONLY" ? "warn" : tiktok.state === "RATE_LIMITED" ? "warn" : "bad";

  return (
    <>
      <AutoRefresh ms={5000} />
      <PageHeader title="Overview" subtitle={`Overvåger twitch.tv/${twitch.channel} · ${settings.automation.monitorEnabled ? (batch ? "kører automatisk hvert 15. minut" : `scanner hvert ${settings.automation.pollIntervalSec}. sekund`) : "overvågning er slået FRA"}`}
        actions={<ActionForm action={scanNow}><SubmitButton className="btn-ghost" pendingText="Starter…">{batch ? "Kør nu" : "Scan nu"}</SubmitButton></ActionForm>} />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Opdagede clips" value={discovered} sub={`${today.discovered} sidste døgn · ${n("BASELINE")} historiske`} />
        <Stat label="Færdigredigerede" value={edited} />
        <Stat label="Publicerede" value={n("PUBLISHED")} tone="ok" sub={`${today.published} sidste døgn`} />
        <Stat label="I kø" value={inQueue} tone={inQueue ? "info" : undefined} />
        <Stat label="Fejl / handling" value={errors} tone={errors ? "bad" : undefined} sub={errors ? <Link href="/queue" className="text-accent-2 hover:underline">Se køen →</Link> : "Alt kører"} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card title="Twitch">
          <StatusLine tone={twitchTone}
            title={!twitch.configured ? "Ikke konfigureret" : !settings.automation.monitorEnabled ? "Overvågning slået fra" : twitchTone === "ok" ? "Scanner kører" : "Scanner forsinket"}
            detail={<>Seneste vellykkede scan: {ago(twitch.sync.lastSuccessAt)}{twitch.lastRun && !twitch.lastRun.ok && twitch.lastRun.error ? <><br /><span className="text-bad">{String(twitch.lastRun.error).slice(0, 160)}</span></> : null}</>} />
          <div className="mt-4 text-xs text-muted">Download: {twitch.user ? `officiel API som ${twitch.user.account_name}` : "offentlige clips (ingen editor-konto forbundet)"}</div>
        </Card>
        <Card title="TikTok">
          <StatusLine tone={tiktokTone} title={TIKTOK_STATE_LABELS[tiktok.state]} detail={tiktok.detail} />
          <div className="mt-4 text-xs text-muted">Auto-publicering: {settings.automation.autoPublish ? <span className="text-ok">TIL</span> : <span className="text-warn">FRA</span>} · tilstand: {settings.tiktok.mode}</div>
        </Card>
        <Card title={batch ? "Autopilot" : "Workers"}>
          <div className="space-y-3">
            {workers.map((w) => (
              <StatusLine key={w.worker} tone={w.alive ? "ok" : "bad"} title={batch ? (w.alive ? "Kører som planlagt" : "Ingen kørsel for nylig") : w.worker}
                detail={batch ? `Seneste kørsel ${ago(w.lastBeatAt)}` : w.alive ? `heartbeat ${ago(w.lastBeatAt)}` : `NEDE — sidste heartbeat ${ago(w.lastBeatAt)}`} />
            ))}
            {runs.map((r) => (
              <a key={r.html_url} href={r.html_url} target="_blank" rel="noreferrer" className="flex justify-between text-xs text-muted hover:text-fg">
                <span>{r.event === "schedule" ? "Planlagt" : "Manuel"} · {ago(r.created_at)}</span>
                <span className={r.conclusion === "success" ? "text-ok" : r.conclusion ? "text-bad" : "text-info"}>{r.conclusion ?? r.status}</span>
              </a>
            ))}
          </div>
        </Card>
      </div>

      {alerts.length > 0 && (
        <Card title="Aktive advarsler" className="mt-6">
          <ul className="space-y-2">
            {alerts.map((a) => (
              <li key={String(a.id)} className="flex items-start gap-2 text-sm">
                <span className={`mt-0.5 rounded px-1.5 text-[11px] font-semibold uppercase ${a.severity === "critical" ? "bg-bad/15 text-bad" : "bg-warn/15 text-warn"}`}>{String(a.severity)}</span>
                <span>{String(a.message)}</span>
                <span className="ml-auto whitespace-nowrap text-xs text-faint">{ago(a.last_seen_at as Date)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Seneste clips" className="mt-6" actions={<Link href="/clips" className="text-xs text-accent-2 hover:underline">Alle clips →</Link>}>
        {recent.length === 0 ? <Empty>Ingen nye clips endnu. Nye clips fra Twitch dukker op her automatisk.</Empty> : (
          <ul className="divide-y divide-border/70">
            {recent.map((c) => (
              <li key={c.id}>
                <Link href={`/clips/${c.id}`} className="flex items-center gap-4 py-3 hover:bg-surface-2/40">
                  <ClipThumb clip={c} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{c.final_title ?? c.twitch_title}</div>
                    <div className="truncate text-xs text-muted">{c.game_name ?? "—"} · {ago(c.twitch_created_at)}{c.final_title && c.title_source !== "twitch" ? ` · Twitch: ${c.twitch_title}` : ""}</div>
                  </div>
                  <StatusBadge status={c.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
