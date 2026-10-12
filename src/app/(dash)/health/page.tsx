import { healthData } from "@/lib/dashboard";
import { emailConfigured } from "@/lib/notify";
import { config } from "@/lib/config";
import { AutoRefresh, ActionForm, SubmitButton } from "@/components/client";
import { Card, PageHeader, StatusLine, Stat, ago, dt, bytes, Empty } from "@/components/ui";
import { testEmail } from "../../actions";

function Spark({ values, max, color }: { values: number[]; max: number; color: string }) {
  if (values.length < 2) return <div className="h-10 text-xs text-faint">Ingen data endnu</div>;
  const w = 240;
  const h = 40;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (Math.min(v, max) / max) * h}`).join(" ");
  return <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-full" preserveAspectRatio="none"><polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}

export default async function HealthPage() {
  const h = await healthData();
  const m = [...h.metrics].reverse();
  const latest = h.metrics[0];
  const diskUsedPct = h.disk ? 1 - h.disk.free / h.disk.total : 0;
  return (
    <>
      <AutoRefresh ms={10000} />
      <PageHeader title="System Health" subtitle={`Version ${h.version} · ${h.runMode === "batch" ? "Gratis-mode: Vercel + Neon + din computer" : "Server-mode: Docker-workers"}`} />
      {h.runMode === "workers" && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Stat label="Disk" value={h.disk ? `${Math.round(diskUsedPct * 100)}%` : "?"} tone={diskUsedPct > 0.9 ? "bad" : diskUsedPct > 0.8 ? "warn" : "ok"} sub={h.disk ? `${bytes(h.disk.free)} fri af ${bytes(h.disk.total)}` : ""} />
        <Stat label="Hukommelse" value={latest ? `${Math.round((1 - Number(latest.mem_free) / Number(latest.mem_total)) * 100)}%` : "?"} sub={latest ? `${bytes(Number(latest.mem_free))} fri` : ""} />
        <Stat label="CPU load (1 min)" value={latest ? Number(latest.load1).toFixed(2) : "?"} sub={latest ? `${latest.cpu_count} kerner` : ""} />
        <Stat label="Database" value={bytes(h.dbSize)} tone={h.dbOk ? undefined : "bad"} sub={h.dbOk ? "PostgreSQL OK" : "NEDE"} />
      </div>}
      {h.runMode === "batch" && <div className="grid gap-4 md:grid-cols-2"><Stat label="Database (Neon)" value={bytes(h.dbSize)} tone={h.dbOk ? undefined : "bad"} sub={h.dbOk ? "forbundet · gratis plan: 0,5 GB" : "NEDE"} /><Stat label="Seneste kørsel" value={ago(h.workers[0]?.lastBeatAt)} tone={h.workers[0]?.alive ? "ok" : "bad"} sub="kører hvert 15. minut" /></div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="Komponenter">
          <div className="space-y-3">
            <StatusLine tone={h.dbOk ? "ok" : "bad"} title="PostgreSQL" detail={h.dbOk ? "forbundet" : "ingen forbindelse"} />
            {h.runMode === "workers" && <StatusLine tone={h.redisOk ? "ok" : "bad"} title="Redis" detail={h.redisOk ? `forbundet · ${h.redisInfo}` : "ingen forbindelse"} />}
            {h.workers.map((w) => <StatusLine key={w.worker} tone={w.alive ? "ok" : "bad"} title={h.runMode === "batch" ? "Autopilot (din computer)" : `Worker: ${w.worker}`} detail={`${w.alive ? "kører" : "NEDE"} · ${h.runMode === "batch" ? "seneste kørsel" : "heartbeat"} ${ago(w.lastBeatAt)} · v${String(w.version ?? "?").slice(0, 7)}`} />)}
          </div>
        </Card>
        <Card title="Seneste succes">
          <div className="space-y-3 text-sm">
            <StatusLine tone={h.sync.lastSuccessAt ? "ok" : "muted"} title="Twitch-scan" detail={`${ago(h.sync.lastSuccessAt)} (${dt(h.sync.lastSuccessAt)})`} />
            <StatusLine tone={h.lastPost ? "ok" : "muted"} title="TikTok-post" detail={h.lastPost ? `${ago(h.lastPost)} (${dt(h.lastPost)})` : "ingen endnu"} />
            <StatusLine tone={h.backups[0]?.ok ? "ok" : h.backups.length ? "bad" : "muted"} title="Databasebackup" detail={h.backups.find((b) => b.kind === "backup") ? `${ago(h.backups.find((b) => b.kind === "backup")!.created_at as Date)} · ${bytes(Number(h.backups.find((b) => b.kind === "backup")!.size_bytes))}` : "ingen registreret (kører i backup-containeren)"} />
            <StatusLine tone={h.backups.find((b) => b.kind === "restore_test")?.ok ? "ok" : "muted"} title="Restore-test" detail={h.backups.find((b) => b.kind === "restore_test") ? `${ago(h.backups.find((b) => b.kind === "restore_test")!.created_at as Date)}: ${h.backups.find((b) => b.kind === "restore_test")!.message}` : "ikke kørt endnu"} />
          </div>
        </Card>
        <Card title="Notifikationer">
          <div className="space-y-3">
            <StatusLine tone={emailConfigured() ? "ok" : "warn"} title="E-mail" detail={emailConfigured() ? `til ${config.alertEmailTo}` : "SMTP_URL / ALERT_EMAIL_TO ikke sat"} />
            <StatusLine tone={config.heartbeatUrl ? "ok" : "warn"} title="Ekstern heartbeat" detail={config.heartbeatUrl ? "pinges hvert minut når alt er OK" : "HEARTBEAT_URL ikke sat (fx healthchecks.io)"} />
            <ActionForm action={testEmail}><SubmitButton className="btn-ghost text-xs">Send testmail</SubmitButton></ActionForm>
          </div>
        </Card>
      </div>

      {h.runMode === "workers" && <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="Fri disk (14 dage)"><Spark values={m.map((x) => Number(x.disk_free) / 1024 ** 3)} max={Math.max(1, ...m.map((x) => Number(x.disk_total) / 1024 ** 3))} color="#34d399" /></Card>
        <Card title="Fri hukommelse"><Spark values={m.map((x) => Number(x.mem_free))} max={Math.max(1, ...m.map((x) => Number(x.mem_total)))} color="#a78bfa" /></Card>
        <Card title="CPU load"><Spark values={m.map((x) => Number(x.load1))} max={Math.max(1, ...m.map((x) => Number(x.cpu_count)))} color="#fbbf24" /></Card>
      </div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Alarmer">
          {h.alerts.length === 0 ? <Empty>Ingen alarmer.</Empty> : (
            <ul className="space-y-2 text-sm">
              {h.alerts.map((a) => (
                <li key={String(a.id)} className={`flex gap-2 ${a.resolved_at ? "opacity-50" : ""}`}>
                  <span className={`mt-0.5 h-fit rounded px-1.5 text-[11px] font-semibold uppercase ${a.severity === "critical" ? "bg-bad/15 text-bad" : "bg-warn/15 text-warn"}`}>{a.resolved_at ? "løst" : String(a.severity)}</span>
                  <span className="flex-1">{String(a.message)}</span>
                  <span className="whitespace-nowrap text-xs text-faint">{ago(a.last_seen_at as Date)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Twitch-scanninger">
          <table className="w-full text-xs">
            <thead className="text-left text-muted"><tr><th className="pb-2">Tid</th><th className="pb-2">Type</th><th className="pb-2">Kald</th><th className="pb-2">Set</th><th className="pb-2">Nye</th><th className="pb-2">Resultat</th></tr></thead>
            <tbody>
              {h.scans.map((s) => (
                <tr key={String(s.id)} className="border-t border-border/60">
                  <td className="py-1.5">{ago(s.started_at as Date)}</td><td>{String(s.kind)}</td><td>{String(s.requests)}</td><td>{String(s.clips_seen)}</td><td>{String(s.clips_new)}</td>
                  <td className={s.ok ? "text-ok" : s.ok === false ? "text-bad" : "text-muted"}>{s.ok ? "OK" : s.ok === false ? String(s.error ?? "fejl").slice(0, 60) : "kører"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card title="Logs (advarsler, fejl og hændelser)" className="mt-6">
        <div className="max-h-[520px] overflow-y-auto font-mono text-xs">
          {h.logs.length === 0 ? <Empty>Ingen loglinjer.</Empty> : h.logs.map((l) => (
            <div key={String(l.id)} className="flex gap-3 border-b border-border/40 py-1.5">
              <span className="w-32 shrink-0 text-faint">{dt(l.created_at as Date)}</span>
              <span className={`w-12 shrink-0 uppercase ${l.level === "error" ? "text-bad" : l.level === "warn" ? "text-warn" : "text-info"}`}>{String(l.level)}</span>
              <span className="w-20 shrink-0 text-muted">{String(l.source)}</span>
              <span className="break-all">{String(l.message)}</span>
            </div>
          ))}
        </div>
        <p className="hint">{h.runMode === "batch" ? "Fulde logs: ~/.t2t/logs/run.log på din computer." : "Fulde logs: docker compose logs -f (roteres automatisk: 5 × 10 MB pr. container)."}</p>
      </Card>
    </>
  );
}
