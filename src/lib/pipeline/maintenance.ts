import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config, paths } from "../config";
import { sql } from "../db";
import { getSettings, getState } from "../settings";
import { addEvent, resumeStatusFor, type Clip } from "../clips";
import { enqueueClip, queue, redis } from "../queue";
import { openAlerts, setAlert } from "../alerts";
import { pingHeartbeat } from "../notify";
import { record } from "../log";
import { getSyncState } from "../twitch/monitor";
import { tiktokAccountState } from "../tiktok/state";
import { uploadBlocker } from "./upload";

export const WORKERS = ["monitor", "render", "uploader"] as const;
/** In batch mode the single scheduled GitHub Actions run is the only "worker". */
export const workerNames = (): string[] => (config.runMode === "batch" ? ["autopilot"] : [...WORKERS]);
/** Batch runs every 15 min (GitHub may delay schedules); stale after this. */
const BATCH_STALE_MS = Number(process.env.BATCH_STALE_MIN ?? 75) * 60_000;
const STALE_WORKER_MS = 2 * 60_000;
const WORKER_GRACE_S = Number(process.env.WORKER_GRACE_S ?? 180);

/**
 * Self-healing loop (runs every minute): re-dispatches every clip whose state says work is
 * pending but has no live job — after crashes, restarts, Redis loss or rate-limit waits.
 */
export async function reconcile(): Promise<Record<string, number>> {
  const db = sql();
  const settings = await getSettings();
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  if (settings.automation.autoEdit) {
    const fresh = await db`SELECT id FROM clips WHERE status IN ('DISCOVERED','QUEUED') ORDER BY COALESCE(twitch_created_at, created_at) LIMIT 200`;
    for (const r of fresh) { await enqueueClip("process", Number(r.id)); bump("process"); }
  }
  // In-progress stages with no progress for 15 min and no live lock → resume (crash recovery).
  const stalled = await db`SELECT id FROM clips WHERE status IN ('DOWNLOADING','DOWNLOADED','ANALYZING','EDITING')
    AND updated_at < now() - interval '15 minutes'
    AND (locked_at IS NULL OR locked_at < now() - interval '30 minutes'
      OR NOT EXISTS (SELECT 1 FROM worker_heartbeats h WHERE h.info->>'instance' = clips.locked_by AND h.last_beat_at > now() - interval '90 seconds'))
    LIMIT 100`;
  for (const r of stalled) { await enqueueClip("process", Number(r.id)); bump("stalled"); }

  // Due retries.
  const due = (await db`SELECT * FROM clips WHERE status = 'RETRY_WAIT' AND next_retry_at <= now() ORDER BY next_retry_at LIMIT 100`) as unknown as Clip[];
  for (const c of due) {
    const to = resumeStatusFor(c.retry_stage, c);
    const [moved] = await db`UPDATE clips SET status = ${to}, next_retry_at = NULL, updated_at = now() WHERE id = ${c.id} AND status = 'RETRY_WAIT' RETURNING id`;
    if (!moved) continue;
    await addEvent(c.id, `Automatisk retry (forsøg ${c.attempts + 1})`, { from: "RETRY_WAIT", to });
    if (to === "PROCESSING") await enqueueClip("status", c.id);
    else if (to === "READY") { if (settings.automation.autoPublish) await enqueueClip("upload", c.id); }
    else await enqueueClip("process", c.id);
    bump("retry");
  }

  // Blocked clips resume automatically once the configuration changed after they were blocked
  // (new consent, reconnected account …) or every 6 hours as a periodic re-check.
  const [cfg] = await db`SELECT GREATEST(
      (SELECT max(updated_at) FROM settings WHERE key IN ('tiktok','setup','twitch')),
      (SELECT max(updated_at) FROM oauth_tokens WHERE provider IN ('tiktok','twitch_user'))) AS changed_at`;
  const changedAt = cfg?.changed_at as Date | null;
  const blocked = (await db`SELECT * FROM clips WHERE (status = 'BLOCKED_PERMISSION' OR (status = 'NEEDS_USER_ACTION' AND tiktok_publish_id IS NULL AND retry_stage = 'upload'))
    AND (updated_at < ${changedAt ?? new Date(0)} OR updated_at < now() - interval '6 hours') LIMIT 50`) as unknown as Clip[];
  for (const c of blocked) {
    if (c.retry_stage === "upload") {
      if (await uploadBlocker(settings)) continue;
      await db`UPDATE clips SET status = 'READY', attempts = 0, status_reason = NULL, updated_at = now() WHERE id = ${c.id} AND status = ${c.status}`;
      await addEvent(c.id, "Blokering ophævet — tilbage i upload-køen", { from: c.status, to: "READY" });
      if (settings.automation.autoPublish) await enqueueClip("upload", c.id);
    } else {
      const to = resumeStatusFor("process", c);
      await db`UPDATE clips SET status = ${to}, attempts = 0, updated_at = now() WHERE id = ${c.id} AND status = ${c.status}`;
      await addEvent(c.id, "Prøver igen efter blokering", { from: c.status, to });
      await enqueueClip("process", c.id);
    }
    bump("unblocked");
  }

  if (settings.automation.autoPublish && settings.tiktok.mode !== "manual") {
    const [next] = await db`SELECT id FROM clips WHERE status = 'READY' AND (next_retry_at IS NULL OR next_retry_at <= now())
                            ORDER BY COALESCE(twitch_created_at, created_at) LIMIT 1`;
    if (next) { await enqueueClip("upload", Number(next.id)); bump("upload"); }
    const stuckUploads = await db`SELECT id FROM clips WHERE status = 'UPLOADING' AND updated_at < now() - interval '30 minutes'`;
    for (const r of stuckUploads) { await enqueueClip("upload", Number(r.id)); bump("upload-resume"); }
  }
  // PROCESSING clips whose status poll chain died.
  const polls = await db`SELECT c.id FROM clips c JOIN upload_attempts a ON a.clip_id = c.id AND a.state NOT IN ('FAILED','ABANDONED')
                         WHERE c.status = 'PROCESSING' AND a.updated_at < now() - interval '20 minutes'`;
  for (const r of polls) { await enqueueClip("status", Number(r.id)); bump("status"); }
  return counts;
}

export async function diskUsage(dir = config.dataDir) {
  await fsp.mkdir(dir, { recursive: true });
  const s = await fsp.statfs(dir);
  return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
}

async function rmQuiet(p: string | null) {
  if (p) await fsp.rm(p, { force: true, recursive: true }).catch(() => {});
}

/** Metrics, retention cleanup and pruning. Runs every 10 minutes. */
export async function housekeeping(): Promise<{ cleaned: number }> {
  const db = sql();
  const settings = await getSettings();
  // Server metrics only make sense on a persistent server (not on an ephemeral CI runner).
  const disk = config.runMode === "workers" ? await diskUsage() : null;
  if (disk) await db`INSERT INTO system_metrics (disk_total, disk_free, mem_total, mem_free, load1, cpu_count)
           VALUES (${disk.total}, ${disk.free}, ${os.totalmem()}, ${os.freemem()}, ${os.loadavg()[0]}, ${os.cpus().length})`;
  await db`DELETE FROM system_metrics WHERE created_at < now() - interval '14 days'`;
  await db`DELETE FROM log_entries WHERE created_at < now() - interval '30 days'`;
  await db`DELETE FROM scan_runs WHERE started_at < now() - interval '30 days'`;

  let cleaned = 0;
  const lowDisk = !!disk && disk.free < settings.retention.minFreeDiskGb * 1024 ** 3;
  // Published clips: drop source + work files after N days, render after M days (sooner when disk is low).
  const done = await db`SELECT id, source_path, render_path, published_at FROM clips
    WHERE status = 'PUBLISHED' AND files_cleaned_at IS NULL AND (source_path IS NOT NULL OR render_path IS NOT NULL)`;
  for (const r of done) {
    const age = Date.now() - new Date(r.published_at as Date).getTime();
    const dropSource = lowDisk || age > settings.retention.sourceDaysAfterPublish * 86400_000;
    const dropRender = lowDisk || age > settings.retention.renderDaysAfterPublish * 86400_000;
    if (dropSource) { await rmQuiet(r.source_path as string); await rmQuiet(path.join(paths.work, String(r.id))); }
    if (dropRender) await rmQuiet(r.render_path as string);
    if (dropSource || dropRender) {
      await db`UPDATE clips SET source_path = ${dropSource ? null : r.source_path}, render_path = ${dropRender ? null : r.render_path},
               files_cleaned_at = ${dropSource && dropRender ? new Date() : null} WHERE id = ${r.id}`;
      cleaned++;
    }
  }
  // Work files (frames, wav) are only needed until the render exists.
  const rendered = await db`SELECT id FROM clips WHERE status IN ('READY','UPLOADING','PROCESSING','PUBLISHED','NEEDS_USER_ACTION') AND updated_at < now() - interval '1 hour'`;
  for (const r of rendered) {
    const dir = path.join(paths.work, String(r.id));
    if (fs.existsSync(dir)) { await rmQuiet(path.join(dir, "frames")); await rmQuiet(path.join(dir, "audio.wav")); await rmQuiet(path.join(dir, "render")); }
  }
  // Orphaned partial files from crashed downloads/renders.
  for (const dir of [paths.sources, paths.renders]) {
    const files = await fsp.readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      if (!/\.(part|tmp\.mp4)$/.test(f)) continue;
      const st = await fsp.stat(path.join(dir, f)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 6 * 3600_000) { await rmQuiet(path.join(dir, f)); cleaned++; }
    }
  }
  return { cleaned };
}

export async function workerStatus() {
  const rows = await sql()`SELECT * FROM worker_heartbeats`;
  const staleMs = config.runMode === "batch" ? BATCH_STALE_MS : STALE_WORKER_MS;
  return workerNames().map((w) => {
    const r = rows.find((x) => x.worker === w);
    const age = r ? Date.now() - new Date(r.last_beat_at as Date).getTime() : Infinity;
    return { worker: w, alive: age < staleMs, lastBeatAt: (r?.last_beat_at as Date | undefined) ?? null, ageMs: age, info: r?.info ?? {}, version: r?.version ?? null, startedAt: r?.started_at ?? null };
  });
}

/** Evaluates alert conditions and sends the outbound heartbeat. Runs every minute. */
export async function evaluateAlerts(): Promise<{ ok: boolean; problems: string[] }> {
  const settings = await getSettings();
  const db = sql();
  const problems: string[] = [];

  const workers = await workerStatus();
  // Grace period after (re)start so a deploy doesn't page because siblings haven't beaten yet.
  const warmingUp = process.uptime() < WORKER_GRACE_S;
  for (const w of workers) {
    const down = !w.alive && !warmingUp;
    await setAlert(`worker-${w.worker}`, down, "critical", `Worker "${w.worker}" har ikke sendt heartbeat ${Number.isFinite(w.ageMs) ? `i ${Math.round(w.ageMs / 1000)} s` : "(aldrig set)"}`);
    if (down) problems.push(`worker ${w.worker} nede`);
  }

  if (settings.automation.monitorEnabled) {
    const sync = await getSyncState();
    const last = sync.lastSuccessAt ? Date.parse(sync.lastSuccessAt) : 0;
    const limit = config.runMode === "batch" ? BATCH_STALE_MS : Math.max(5 * settings.automation.pollIntervalSec * 1000, 5 * 60_000);
    const stale = Date.now() - last > limit;
    await setAlert("twitch-scan-stale", stale, "critical", `Twitch-scanneren har ikke kørt succesfuldt siden ${last ? new Date(last).toLocaleString("da-DK") : "start"} (backfill sker automatisk ved næste vellykkede scan)`);
    if (stale) problems.push("twitch-scan forsinket");
  } else {
    await setAlert("twitch-scan-stale", false, "critical", "");
  }

  const [tu] = await db`SELECT status, status_message FROM oauth_tokens WHERE provider = 'twitch_user'`;
  await setAlert("twitch-token", !!tu && tu.status !== "ok", "warning", `Twitch-forbindelse: ${tu?.status_message ?? "kræver ny godkendelse"}`);

  const tt = await tiktokAccountState();
  const ttBad = tt.state === "OWNER_ACTION_REQUIRED" || (settings.automation.autoPublish && tt.state === "NOT_CONNECTED");
  await setAlert("tiktok-account", ttBad, "warning", `TikTok kræver handling: ${tt.detail}`);

  const [needs] = await db`SELECT count(*) FILTER (WHERE status = 'BLOCKED_PERMISSION')::int AS blocked,
                                  count(*) FILTER (WHERE status = 'NEEDS_USER_ACTION')::int AS action,
                                  count(*) FILTER (WHERE status = 'FAILED' AND updated_at > now() - interval '24 hours')::int AS failed FROM clips`;
  await setAlert("clips-blocked", needs.blocked > 0, "warning", `${needs.blocked} clip(s) mangler rettigheder (se Upload Queue)`);
  await setAlert("clips-need-action", needs.action > 0, "warning", `${needs.action} clip(s) kræver din handling (se Upload Queue)`);
  await setAlert("clips-failed", needs.failed > 0, "warning", `${needs.failed} clip(s) er fejlet permanent det seneste døgn`);

  if (config.runMode === "workers") {
    const disk = await diskUsage();
    const low = disk.free < settings.retention.minFreeDiskGb * 1024 ** 3;
    await setAlert("disk-low", low, "critical", `Lav diskplads: ${(disk.free / 1024 ** 3).toFixed(1)} GB fri`);
    if (low) problems.push("lav diskplads");
  }

  const [bk] = await db`SELECT max(created_at) FILTER (WHERE kind = 'backup' AND ok) AS last_ok, count(*)::int AS n FROM backup_runs`;
  if (bk.n > 0 || process.env.EXPECT_BACKUPS === "1") {
    const lastOk = bk.last_ok as Date | null;
    await setAlert("backup-stale", !lastOk || Date.now() - lastOk.getTime() > 36 * 3600_000, "warning", `Ingen vellykket databasebackup siden ${lastOk ? lastOk.toLocaleString("da-DK") : "aldrig"}`);
  }

  if (config.runMode === "workers") {
    try {
      await redis().ping();
    } catch {
      problems.push("redis utilgængelig");
    }
  }
  const critical = (await openAlerts()).filter((a) => a.severity === "critical");
  const ok = critical.length === 0 && problems.length === 0;
  await pingHeartbeat(ok, ok ? "ok" : `Problemer: ${[...problems, ...critical.map((a) => a.message as string)].join("; ")}`);
  return { ok, problems };
}

/** Keeps BullMQ repeatable jobs in sync with the automation settings. */
export async function syncSchedulers() {
  if (config.runMode === "batch") return; // schedule lives in .github/workflows/autopilot.yml
  const settings = await getSettings();
  const q = queue("monitor");
  if (settings.automation.monitorEnabled) {
    await q.upsertJobScheduler("scan", { every: settings.automation.pollIntervalSec * 1000 }, { name: "scan" });
  } else {
    await q.removeJobScheduler("scan");
  }
  await q.upsertJobScheduler("reconcile", { every: 60_000 }, { name: "reconcile" });
  await q.upsertJobScheduler("alerts", { every: 60_000 }, { name: "alerts" });
  await q.upsertJobScheduler("housekeeping", { every: 10 * 60_000 }, { name: "housekeeping" });
}

export async function lastPostAt(): Promise<string | null> {
  return getState<string>("tiktok.lastPostAt");
}

export async function logRecovery(counts: Record<string, number>) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  if (counts.stalled || counts["upload-resume"] || counts.status) await record("warn", "reconcile", `Genoptog afbrudte jobs: ${JSON.stringify(counts)}`);
  return total;
}
