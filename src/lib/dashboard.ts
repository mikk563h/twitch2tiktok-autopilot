import { sql } from "./db";
import { config } from "./config";
import type { Clip, ClipStatus } from "./clips";
import { getSyncState } from "./twitch/monitor";
import { tokenInfo } from "./tokens";
import { tiktokAccountState } from "./tiktok/state";
import { workerStatus, diskUsage, lastPostAt } from "./pipeline/maintenance";
import { redis } from "./queue";

export async function statusCounts(): Promise<Record<ClipStatus, number>> {
  const rows = await sql()`SELECT status, count(*)::int AS n FROM clips GROUP BY status`;
  const out = {} as Record<ClipStatus, number>;
  for (const r of rows) out[r.status as ClipStatus] = r.n as number;
  return out;
}

export async function navBadges(): Promise<Record<string, number>> {
  const [r] = await sql()`SELECT count(*) FILTER (WHERE status IN ('BLOCKED_PERMISSION','NEEDS_USER_ACTION','FAILED'))::int AS q FROM clips`;
  return { "/queue": r.q as number };
}

export async function twitchStatus() {
  const sync = await getSyncState();
  const user = await tokenInfo("twitch_user");
  const [lastRun] = await sql()`SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 1`;
  return {
    configured: !!(config.twitchClientId && config.twitchClientSecret),
    channel: config.twitchChannel,
    sync,
    user,
    lastRun: lastRun ?? null,
  };
}

export async function overview() {
  const [counts, twitch, tiktok, workers, recent, alerts, [today]] = await Promise.all([
    statusCounts(),
    twitchStatus(),
    tiktokAccountState(),
    workerStatus(),
    sql()`SELECT * FROM clips WHERE status <> 'BASELINE' ORDER BY COALESCE(twitch_created_at, created_at) DESC LIMIT 8`,
    sql()`SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY last_seen_at DESC LIMIT 6`,
    sql()`SELECT count(*) FILTER (WHERE discovered_at > now() - interval '24 hours' AND status <> 'BASELINE')::int AS discovered,
                 count(*) FILTER (WHERE published_at > now() - interval '24 hours')::int AS published FROM clips`,
  ]);
  return { counts, twitch, tiktok, workers, recent: recent as unknown as Clip[], alerts, today };
}

export async function listClips(opts: { status?: string; q?: string; page?: number; includeBaseline?: boolean }) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = 30;
  const db = sql();
  const statusFilter = opts.status ? db`AND status = ${opts.status}` : opts.includeBaseline ? db`` : db`AND status <> 'BASELINE'`;
  const q = opts.q ? `%${opts.q}%` : null;
  const qFilter = q ? db`AND (twitch_title ILIKE ${q} OR final_title ILIKE ${q} OR twitch_clip_id ILIKE ${q} OR game_name ILIKE ${q})` : db``;
  const rows = await db`SELECT id, twitch_clip_id, twitch_title, final_title, title_source, status, status_reason, game_name, view_count, duration,
                               twitch_created_at, thumbnail_url, render_thumb_path, render_path, source_path, tiktok_url, published_at, url, origin, creator_name
                        FROM clips WHERE true ${statusFilter} ${qFilter}
                        ORDER BY COALESCE(twitch_created_at, created_at) DESC LIMIT ${limit + 1} OFFSET ${(page - 1) * limit}`;
  return { rows: rows.slice(0, limit) as unknown as Clip[], hasMore: rows.length > limit, page };
}

export async function clipDetail(id: number) {
  const [clip] = await sql()`SELECT * FROM clips WHERE id = ${id}`;
  if (!clip) return null;
  const [events, attempts] = await Promise.all([
    sql()`SELECT * FROM clip_events WHERE clip_id = ${id} ORDER BY id DESC LIMIT 100`,
    sql()`SELECT * FROM upload_attempts WHERE clip_id = ${id} ORDER BY id DESC`,
  ]);
  return { clip: clip as unknown as Clip, events, attempts };
}

export async function queueData() {
  const active = await sql()`
    SELECT c.*, (SELECT row_to_json(a) FROM upload_attempts a WHERE a.clip_id = c.id ORDER BY a.id DESC LIMIT 1) AS attempt
    FROM clips c
    WHERE c.status NOT IN ('BASELINE','PUBLISHED')
    ORDER BY CASE c.status WHEN 'NEEDS_USER_ACTION' THEN 0 WHEN 'BLOCKED_PERMISSION' THEN 1 WHEN 'FAILED' THEN 2 WHEN 'UPLOADING' THEN 3 WHEN 'PROCESSING' THEN 4 ELSE 5 END,
             COALESCE(c.twitch_created_at, c.created_at) ASC
    LIMIT 300`;
  const recentPublished = await sql()`SELECT id, final_title, published_at, tiktok_url, render_thumb_path FROM clips WHERE status = 'PUBLISHED' ORDER BY published_at DESC NULLS LAST LIMIT 10`;
  return { active: active as unknown as Array<Clip & { attempt: Record<string, unknown> | null }>, recentPublished };
}

export async function healthData() {
  let redisOk = false;
  let redisInfo = "";
  try {
    if (config.runMode === "batch") throw new Error("ingen redis i batch-mode");
    redisOk = (await redis().ping()) === "PONG";
    const info = await redis().info("memory");
    redisInfo = info.match(/used_memory_human:(\S+)/)?.[1] ?? "";
  } catch { /* shown as down */ }
  let dbOk = false;
  let dbSize = 0;
  try {
    const [r] = await sql()`SELECT pg_database_size(current_database())::bigint AS size`;
    dbOk = true;
    dbSize = Number(r.size);
  } catch { /* shown as down */ }
  const [workers, disk, metrics, logs, alerts, scans, backups, lastPost, sync] = await Promise.all([
    workerStatus(),
    config.runMode === "workers" ? diskUsage().catch(() => null) : Promise.resolve(null),
    sql()`SELECT * FROM system_metrics ORDER BY created_at DESC LIMIT 144`,
    sql()`SELECT * FROM log_entries ORDER BY created_at DESC LIMIT 80`,
    sql()`SELECT * FROM alerts ORDER BY resolved_at IS NULL DESC, last_seen_at DESC LIMIT 20`,
    sql()`SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 15`,
    sql()`SELECT * FROM backup_runs ORDER BY created_at DESC LIMIT 10`,
    lastPostAt(),
    getSyncState(),
  ]);
  return { redisOk, redisInfo, dbOk, dbSize, workers, disk, metrics, logs, alerts, scans, backups, lastPost, sync, version: config.appVersion, runMode: config.runMode };
}
