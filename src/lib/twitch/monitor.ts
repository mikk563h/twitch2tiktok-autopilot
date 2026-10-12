import { config } from "../config";
import { sql } from "../db";
import { getSettings, getState, setState } from "../settings";
import { enqueueClip } from "../queue";
import { addEvent } from "../clips";
import { record, errMsg } from "../log";
import { getGameNames, getUserByLogin, helix, type TwitchClip } from "./api";

export interface SyncState {
  broadcasterId?: string;
  broadcasterLogin?: string;
  baselineDoneAt?: string;
  lastSuccessEnd?: string;
  lastSuccessAt?: string;
  lastDeepAt?: string;
}

const SYNC_KEY = "twitch.sync";
const PAGE_SIZE = 100;
/** Twitch returns at most ~1000 clips per query; windows that come close get split. */
const SPLIT_THRESHOLD = 900;
const MIN_WINDOW_MS = 5 * 60_000;

export interface ScanStats { requests: number; seen: number; inserted: number }

/**
 * All clips created in [start, end). Results are ordered by view count, not time, so we
 * always page to the end and split dense windows instead of trusting the first page.
 */
export async function fetchClipsWindow(broadcasterId: string, start: Date, end: Date, stats: ScanStats): Promise<TwitchClip[]> {
  const out: TwitchClip[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const p = new URLSearchParams({ broadcaster_id: broadcasterId, started_at: start.toISOString(), ended_at: end.toISOString(), first: String(PAGE_SIZE) });
    if (cursor) p.set("after", cursor);
    const res = await helix<TwitchClip>("/clips", p);
    stats.requests++;
    out.push(...res.data);
    const next = res.pagination?.cursor;
    // Guard against a cursor that does not advance.
    cursor = next && next !== cursor && res.data.length > 0 ? next : undefined;
    pages++;
  } while (cursor && pages < 15);

  if (out.length >= SPLIT_THRESHOLD && end.getTime() - start.getTime() > MIN_WINDOW_MS) {
    const mid = new Date(start.getTime() + (end.getTime() - start.getTime()) / 2);
    const [a, b] = [await fetchClipsWindow(broadcasterId, start, mid, stats), await fetchClipsWindow(broadcasterId, mid, end, stats)];
    return dedupe([...a, ...b]);
  }
  // Twitch treats the window boundaries inclusively; keep only clips really inside it.
  return dedupe(out).filter((c) => {
    const t = Date.parse(c.created_at);
    return t >= start.getTime() - 1000 && t <= end.getTime() + 1000;
  });
}

function dedupe(clips: TwitchClip[]): TwitchClip[] {
  const m = new Map<string, TwitchClip>();
  for (const c of clips) m.set(c.id, c);
  return [...m.values()];
}

/** Splits [start, end) into consecutive windows of at most `chunkMs`. */
export function splitWindows(start: Date, end: Date, chunkMs: number): Array<[Date, Date]> {
  const out: Array<[Date, Date]> = [];
  for (let t = start.getTime(); t < end.getTime(); t += chunkMs) out.push([new Date(t), new Date(Math.min(end.getTime(), t + chunkMs))]);
  return out;
}

/**
 * Inserts clips (unique on twitch_clip_id). Existing rows only get their view count refreshed.
 * Returns the ids of rows that were actually inserted.
 */
export async function registerClips(clips: TwitchClip[], decide: (c: TwitchClip) => { status: "BASELINE" | "DISCOVERED"; origin: string }): Promise<Array<{ id: number; status: string; twitchId: string }>> {
  if (!clips.length) return [];
  let games = new Map<string, string>();
  try {
    games = await getGameNames(clips.map((c) => c.game_id).filter(Boolean));
  } catch {
    /* game names are cosmetic; never block registration */
  }
  const db = sql();
  const inserted: Array<{ id: number; status: string; twitchId: string }> = [];
  await db.begin(async (tx) => {
    for (const c of clips) {
      const d = decide(c);
      const [row] = await tx`
        INSERT INTO clips (twitch_clip_id, broadcaster_id, broadcaster_name, url, embed_url, creator_name, video_id, game_id, game_name,
                           language, twitch_title, view_count, twitch_created_at, thumbnail_url, duration, status, origin)
        VALUES (${c.id}, ${c.broadcaster_id}, ${c.broadcaster_name}, ${c.url}, ${c.embed_url}, ${c.creator_name}, ${c.video_id || null},
                ${c.game_id || null}, ${games.get(c.game_id) ?? null}, ${c.language}, ${c.title}, ${c.view_count}, ${c.created_at},
                ${c.thumbnail_url}, ${c.duration}, ${d.status}, ${d.origin})
        ON CONFLICT (twitch_clip_id) DO UPDATE SET view_count = EXCLUDED.view_count,
          game_name = COALESCE(clips.game_name, EXCLUDED.game_name)
        RETURNING id, status, (xmax = 0) AS inserted`;
      if (row.inserted) inserted.push({ id: Number(row.id), status: row.status as string, twitchId: c.id });
    }
  });
  // One multi-row insert per 500 events (a baseline can register thousands of clips).
  const events = inserted.map((r) => ({
    clip_id: r.id, to_status: r.status,
    message: r.status === "BASELINE" ? "Registreret i baseline (uploades ikke automatisk)" : "Nyt clip opdaget",
  }));
  for (let i = 0; i < events.length; i += 500) {
    await db`INSERT INTO clip_events ${db(events.slice(i, i + 500), "clip_id", "to_status", "message")}`;
  }
  return inserted;
}

async function resolveBroadcaster(state: SyncState): Promise<string> {
  if (state.broadcasterId && state.broadcasterLogin === config.twitchChannel) return state.broadcasterId;
  const user = await getUserByLogin(config.twitchChannel);
  if (!user) throw new Error(`Twitch-kanalen "${config.twitchChannel}" blev ikke fundet`);
  state.broadcasterId = user.id;
  state.broadcasterLogin = config.twitchChannel;
  await setState(SYNC_KEY, state);
  return user.id;
}

export async function getSyncState(): Promise<SyncState> {
  return (await getState<SyncState>(SYNC_KEY)) ?? {};
}

async function withScanLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const conn = await sql().reserve();
  try {
    const [r] = await conn`SELECT pg_try_advisory_lock(hashtext('twitch-scan')) AS ok`;
    if (!r.ok) return null;
    try {
      return await fn();
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtext('twitch-scan'))`;
    }
  } finally {
    conn.release();
  }
}

async function startRun(kind: string, start: Date | null, end: Date) {
  const [r] = await sql()`INSERT INTO scan_runs (kind, window_start, window_end) VALUES (${kind}, ${start}, ${end}) RETURNING id`;
  return Number(r.id);
}

async function finishRun(id: number, stats: ScanStats, ok: boolean, error?: string) {
  await sql()`UPDATE scan_runs SET finished_at = now(), requests = ${stats.requests}, clips_seen = ${stats.seen}, clips_new = ${stats.inserted},
              ok = ${ok}, error = ${error ?? null} WHERE id = ${id}`;
}

/**
 * First start: every clip that already exists is registered as BASELINE so the back
 * catalogue is never auto-uploaded. Historical import can queue them later.
 */
export async function runBaseline(now = new Date()): Promise<ScanStats> {
  const state = await getSyncState();
  const broadcasterId = await resolveBroadcaster(state);
  const stats: ScanStats = { requests: 0, seen: 0, inserted: 0 };
  const runId = await startRun("baseline", null, now);
  try {
    // All-time list (top ~1000 by views) plus a windowed sweep of the last 60 days.
    const all: TwitchClip[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = new URLSearchParams({ broadcaster_id: broadcasterId, first: String(PAGE_SIZE) });
      if (cursor) p.set("after", cursor);
      const res = await helix<TwitchClip>("/clips", p);
      stats.requests++;
      all.push(...res.data);
      cursor = res.pagination?.cursor && res.data.length ? res.pagination.cursor : undefined;
    } while (cursor && ++pages < 12);
    for (const [s, e] of splitWindows(new Date(now.getTime() - 60 * 86400_000), now, 7 * 86400_000)) {
      all.push(...(await fetchClipsWindow(broadcasterId, s, e, stats)));
    }
    const clips = dedupe(all);
    stats.seen = clips.length;
    const ins = await registerClips(clips, () => ({ status: "BASELINE", origin: "baseline" }));
    stats.inserted = ins.length;
    await setState(SYNC_KEY, { ...state, broadcasterId, baselineDoneAt: now.toISOString(), lastSuccessEnd: now.toISOString(), lastSuccessAt: new Date().toISOString(), lastDeepAt: now.toISOString() });
    await finishRun(runId, stats, true);
    await record("info", "twitch", `Baseline gennemført: ${clips.length} eksisterende clips registreret`);
    return stats;
  } catch (err) {
    await finishRun(runId, stats, false, errMsg(err));
    throw err;
  }
}

/**
 * Regular scan: from the last successful window end (minus an overlap, to catch clips that
 * Twitch indexes late) up to now. After downtime the window simply grows — that is the
 * automatic backfill. Periodically a deeper lookback re-checks the last few days.
 */
export async function runIncrementalScan(now = new Date()): Promise<(ScanStats & { kind: string }) | null> {
  return withScanLock(async () => {
    const settings = await getSettings();
    let state = await getSyncState();
    if (!state.baselineDoneAt) {
      const s = await runBaseline(now);
      return { ...s, kind: "baseline" };
    }
    state = await getSyncState();
    const broadcasterId = await resolveBroadcaster(state);
    const overlapMs = settings.automation.overlapMinutes * 60_000;
    const lastEnd = state.lastSuccessEnd ? new Date(state.lastSuccessEnd) : new Date(state.baselineDoneAt!);
    let start = new Date(lastEnd.getTime() - overlapMs);
    let kind = now.getTime() - lastEnd.getTime() > 3 * settings.automation.pollIntervalSec * 1000 + overlapMs ? "backfill" : "incremental";
    const deepDue = !state.lastDeepAt || now.getTime() - Date.parse(state.lastDeepAt) > settings.automation.deepScanEveryHours * 3600_000;
    if (deepDue) {
      const deepStart = new Date(now.getTime() - settings.automation.deepScanLookbackHours * 3600_000);
      if (deepStart < start) start = deepStart;
      kind = kind === "backfill" ? "backfill" : "deep";
    }
    const stats: ScanStats = { requests: 0, seen: 0, inserted: 0 };
    const runId = await startRun(kind, start, now);
    try {
      const clips: TwitchClip[] = [];
      for (const [s, e] of splitWindows(start, now, 24 * 3600_000)) clips.push(...(await fetchClipsWindow(broadcasterId, s, e, stats)));
      const unique = dedupe(clips);
      stats.seen = unique.length;
      const baselineAt = Date.parse(state.baselineDoneAt!);
      const ins = await registerClips(unique, (c) =>
        Date.parse(c.created_at) < baselineAt ? { status: "BASELINE", origin: "baseline" } : { status: "DISCOVERED", origin: "monitor" },
      );
      stats.inserted = ins.length;
      if (settings.automation.autoEdit) {
        for (const r of ins) if (r.status === "DISCOVERED") await enqueueClip("process", r.id);
      }
      await setState(SYNC_KEY, { ...state, broadcasterId, lastSuccessEnd: now.toISOString(), lastSuccessAt: new Date().toISOString(), ...(deepDue ? { lastDeepAt: now.toISOString() } : {}) });
      await finishRun(runId, stats, true);
      if (kind === "backfill") await record("warn", "twitch", `Backfill efter pause: scannede fra ${start.toISOString()} og fandt ${stats.inserted} nye clips`);
      return { ...stats, kind };
    } catch (err) {
      await finishRun(runId, stats, false, errMsg(err));
      throw err;
    }
  });
}

/** Historical import from the dashboard: register and queue every clip created in the range. */
export async function runHistoricalImport(start: Date, end: Date): Promise<{ queued: number; stats: ScanStats }> {
  const state = await getSyncState();
  const broadcasterId = await resolveBroadcaster(state);
  const stats: ScanStats = { requests: 0, seen: 0, inserted: 0 };
  const runId = await startRun("historical", start, end);
  try {
    const clips: TwitchClip[] = [];
    for (const [s, e] of splitWindows(start, end, 7 * 86400_000)) clips.push(...(await fetchClipsWindow(broadcasterId, s, e, stats)));
    const unique = dedupe(clips);
    stats.seen = unique.length;
    stats.inserted = (await registerClips(unique, () => ({ status: "BASELINE", origin: "baseline" }))).length;
    const ids = unique.map((c) => c.id);
    const rows = await sql()`
      UPDATE clips SET status = 'QUEUED', origin = 'historical', updated_at = now()
      WHERE twitch_clip_id = ANY(${ids}) AND status = 'BASELINE' RETURNING id`;
    for (const r of rows) {
      await addEvent(Number(r.id), "Sat i kø via historisk import", { from: "BASELINE", to: "QUEUED" });
      await enqueueClip("process", Number(r.id));
    }
    await finishRun(runId, stats, true);
    return { queued: rows.length, stats };
  } catch (err) {
    await finishRun(runId, stats, false, errMsg(err));
    throw err;
  }
}

/** Re-reads current view counts from Twitch (100 ids per request) and stores them. */
export async function refreshViewCounts(twitchIds: string[]): Promise<number> {
  const db = sql();
  let updated = 0;
  for (let i = 0; i < twitchIds.length; i += 100) {
    const p = new URLSearchParams({ first: "100" });
    twitchIds.slice(i, i + 100).forEach((id) => p.append("id", id));
    const { data } = await helix<TwitchClip>("/clips", p);
    const rows = data.filter((c) => twitchIds.includes(c.id)).map((c) => ({ id: c.id, views: c.view_count }));
    if (!rows.length) continue;
    await db`UPDATE clips SET view_count = v.views::int FROM (VALUES ${db(rows.map((r) => [r.id, r.views]))}) AS v(id, views)
             WHERE clips.twitch_clip_id = v.id`;
    updated += rows.length;
  }
  return updated;
}
