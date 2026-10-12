/**
 * Batch runner for the free setup (GitHub Actions + Vercel + Neon). One invocation does
 * everything the long-running workers would do, then exits. The database is the queue.
 *
 *   node --import tsx scripts/run-once.ts plan   # scan Twitch, housekeeping; prints work=true|false
 *   node --import tsx scripts/run-once.ts work   # download/analyse/render, upload, poll status
 *   node --import tsx scripts/run-once.ts        # both
 *
 * Splitting lets the workflow skip installing FFmpeg/whisper when there is nothing to do.
 */
import fs from "node:fs";
import os from "node:os";
import { sql, closeDb } from "@/lib/db";
import { migrate } from "@/lib/migrate";
import { getSettings } from "@/lib/settings";
import { takeRequests, type JobRequest } from "@/lib/queue";
import { record, errMsg, log } from "@/lib/log";
import { runIncrementalScan, runHistoricalImport } from "@/lib/twitch/monitor";
import { TwitchNotConfigured } from "@/lib/twitch/api";
import { processClip } from "@/lib/pipeline/process";
import { uploadClip, checkPublishStatus, nextAllowedPostTime } from "@/lib/pipeline/upload";
import { reconcile, housekeeping, evaluateAlerts } from "@/lib/pipeline/maintenance";
import { config } from "@/lib/config";

const phase = (process.argv[2] ?? "all") as "plan" | "work" | "all";
const BUDGET_MS = Number(process.env.RUN_BUDGET_MIN ?? 45) * 60_000;
const started = Date.now();
const INSTANCE = `gha-${process.env.GITHUB_RUN_ID ?? os.hostname()}-${process.pid}-${Date.now().toString(36)}`;
const timeLeft = () => BUDGET_MS - (Date.now() - started);
const summary: Record<string, unknown> = { phase, instance: INSTANCE };

async function beat(extra: Record<string, unknown> = {}) {
  const db = sql();
  await db`INSERT INTO worker_heartbeats (worker, hostname, pid, version, started_at, last_beat_at, info)
           VALUES ('autopilot', ${os.hostname()}, ${process.pid}, ${config.appVersion}, ${new Date(started)}, now(), ${db.json({ instance: INSTANCE, ...summary, ...extra } as never)})
           ON CONFLICT (worker) DO UPDATE SET hostname = EXCLUDED.hostname, pid = EXCLUDED.pid, version = EXCLUDED.version,
             started_at = EXCLUDED.started_at, last_beat_at = now(), info = EXCLUDED.info`;
}

function output(key: string, value: string) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`${key}=${value}`);
}

const PROCESSABLE = ["DISCOVERED", "QUEUED", "DOWNLOADING", "DOWNLOADED", "ANALYZING", "EDITING"];

async function pendingWork(): Promise<{ process: number; upload: number; poll: number }> {
  const s = await getSettings();
  const [r] = await sql()`
    SELECT count(*) FILTER (WHERE status = ANY(${PROCESSABLE}) AND (${s.automation.autoEdit} OR status <> 'DISCOVERED'))::int AS process,
           count(*) FILTER (WHERE status IN ('READY','UPLOADING') AND (next_retry_at IS NULL OR next_retry_at <= now()))::int AS upload,
           count(*) FILTER (WHERE status = 'PROCESSING')::int AS poll
    FROM clips`;
  const slot = await nextAllowedPostTime(s);
  const canPost = s.automation.autoPublish && s.tiktok.mode !== "manual" && !slot.at;
  return { process: r.process, upload: canPost ? r.upload : 0, poll: r.poll };
}

async function plan(requests: JobRequest[]) {
  const settings = await getSettings();
  for (const req of requests) {
    if (req.name === "historical") {
      try {
        const r = await runHistoricalImport(new Date(req.start), new Date(req.end));
        summary.historical = r.queued;
      } catch (err) {
        await record("error", "twitch", `Historisk import fejlede: ${errMsg(err)}`);
      }
    }
  }
  const scanRequested = requests.some((r) => r.name === "scan-now");
  if (settings.automation.monitorEnabled || scanRequested) {
    try {
      summary.scan = await runIncrementalScan();
    } catch (err) {
      if (err instanceof TwitchNotConfigured) summary.scan = "Twitch ikke konfigureret";
      else await record("error", "twitch", `Twitch-scan fejlede: ${errMsg(err)}`);
    }
  }
  summary.reconcile = await reconcile();
  await housekeeping();
  return pendingWork();
}

async function pollUntilSettled(clipId: number, maxMs: number) {
  const until = Date.now() + Math.min(maxMs, timeLeft());
  for (let i = 0; Date.now() < until; i++) {
    const r = await checkPublishStatus(clipId, i);
    if (r.status !== "PROCESSING") return r.status;
    await new Promise((res) => setTimeout(res, Math.min(r.nextDelayMs ?? 10_000, 20_000)));
  }
  return "PROCESSING"; // keeps polling on the next run — never re-uploads
}

async function work(requests: JobRequest[]) {
  const settings = await getSettings();
  const counts = { processed: 0, uploaded: 0, polled: 0, failed: 0 };
  // 1) Status of uploads started by earlier runs.
  for (const r of await sql()`SELECT id FROM clips WHERE status = 'PROCESSING' ORDER BY updated_at`) {
    await pollUntilSettled(Number(r.id), 60_000);
    counts.polled++;
  }
  // 2) Download → analyse → render, oldest first.
  const tried = new Set<number>();
  while (timeLeft() > 5 * 60_000) {
    const [next] = await sql()`SELECT id FROM clips WHERE status = ANY(${PROCESSABLE})
      AND (${settings.automation.autoEdit} OR status <> 'DISCOVERED') AND NOT (id = ANY(${[...tried]}::bigint[]))
      ORDER BY COALESCE(twitch_created_at, created_at) LIMIT 1`;
    if (!next) break;
    const id = Number(next.id);
    tried.add(id);
    const st = await processClip(id, INSTANCE);
    if (st === "READY") counts.processed++;
    else if (st !== "skipped") counts.failed++;
    await beat({ counts });
  }
  // 3) Uploads: forced ones from the dashboard first, then the queue in order (rate limits apply).
  const forced = requests.filter((r): r is Extract<JobRequest, { name: "upload-now" }> => r.name === "upload-now").map((r) => r.clipId);
  const uploadOne = async (id: number, force: boolean) => {
    let st = await uploadClip(id, { force });
    if (st === "DOWNLOADED") {
      // Render files don't survive between runs (ephemeral runner) — rebuild, then upload.
      await processClip(id, INSTANCE);
      st = await uploadClip(id, { force });
    }
    if (st === "PROCESSING") {
      counts.uploaded++;
      await pollUntilSettled(id, 5 * 60_000);
    }
    return st;
  };
  for (const id of forced) if (timeLeft() > 3 * 60_000) await uploadOne(id, true);
  if (settings.automation.autoPublish && settings.tiktok.mode !== "manual") {
    const seen = new Set<number>();
    while (timeLeft() > 3 * 60_000) {
      const [next] = await sql()`SELECT id FROM clips WHERE status IN ('READY','UPLOADING') AND (next_retry_at IS NULL OR next_retry_at <= now())
        AND NOT (id = ANY(${[...seen]}::bigint[])) ORDER BY COALESCE(twitch_created_at, created_at) LIMIT 1`;
      if (!next) break;
      const id = Number(next.id);
      seen.add(id);
      const st = await uploadOne(id, false);
      if (st === "READY" || st === "skipped") break; // waiting for a posting slot / rate limit
      await beat({ counts });
    }
  }
  summary.work = counts;
}

async function main() {
  if (config.runMode !== "batch") log.warn("REDIS_URL er sat — run-once er beregnet til batch-mode (GitHub Actions)");
  await migrate();
  await beat({ status: "running" });
  const requests = phase === "work" ? [] : await takeRequests();
  // Forced uploads requested in the plan phase must survive until the work phase.
  const forced = requests.filter((r) => r.name === "upload-now");
  if (phase === "plan" && forced.length) {
    const db = sql();
    await db`INSERT INTO kv_state (key, value) VALUES ('batch.forced', ${db.json(forced as never)})
             ON CONFLICT (key) DO UPDATE SET value = kv_state.value || EXCLUDED.value, updated_at = now()`;
  }
  let pending = { process: 0, upload: 0, poll: 0 };
  if (phase !== "work") {
    pending = await plan(requests);
    summary.pending = pending;
    output("work", String(pending.process + pending.upload + pending.poll + forced.length > 0));
  }
  if (phase !== "plan") {
    const carried = phase === "work" ? ((await sql()`DELETE FROM kv_state WHERE key = 'batch.forced' RETURNING value`)[0]?.value as JobRequest[] | undefined) ?? [] : forced;
    await work(carried);
    await evaluateAlerts();
  } else if (pending.process + pending.upload + pending.poll + forced.length === 0) {
    await evaluateAlerts(); // idle run: still check health + send heartbeat
  }
  // Media files live on the ephemeral runner only; forget their paths so nothing points at them.
  if (phase !== "plan" && process.env.RUN_EPHEMERAL === "1") await sql()`UPDATE clips SET source_path = NULL, render_path = NULL, render_thumb_path = NULL WHERE source_path IS NOT NULL OR render_path IS NOT NULL OR render_thumb_path IS NOT NULL`;
  await beat({ status: "done", durationS: Math.round((Date.now() - started) / 1000) });
  console.log(JSON.stringify(summary));
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error("run-once fejlede:", err);
    try { await record("error", "autopilot", `Kørsel fejlede: ${errMsg(err)}`); await closeDb(); } catch { /* ignore */ }
    process.exit(1);
  });
