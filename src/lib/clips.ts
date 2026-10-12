import { sql } from "./db";
import { toJson } from "./log";

export const CLIP_STATUSES = [
  "BASELINE", "DISCOVERED", "QUEUED", "DOWNLOADING", "DOWNLOADED", "ANALYZING", "EDITING", "READY",
  "UPLOADING", "PROCESSING", "PUBLISHED", "RETRY_WAIT", "BLOCKED_PERMISSION", "NEEDS_USER_ACTION", "FAILED",
] as const;
export type ClipStatus = (typeof CLIP_STATUSES)[number];

/** Statuses where the render pipeline owns the clip. */
export const PIPELINE_STATUSES: ClipStatus[] = ["DISCOVERED", "QUEUED", "DOWNLOADING", "DOWNLOADED", "ANALYZING", "EDITING"];
/** Statuses where the uploader owns the clip. */
export const UPLOAD_STATUSES: ClipStatus[] = ["READY", "UPLOADING", "PROCESSING"];

export const STATUS_LABELS: Record<ClipStatus, string> = {
  BASELINE: "Historisk (ikke i kø)",
  DISCOVERED: "Opdaget",
  QUEUED: "I kø",
  DOWNLOADING: "Downloader",
  DOWNLOADED: "Downloadet",
  ANALYZING: "Analyserer",
  EDITING: "Redigerer",
  READY: "Klar",
  UPLOADING: "Uploader",
  PROCESSING: "TikTok behandler",
  PUBLISHED: "Publiceret",
  RETRY_WAIT: "Venter på retry",
  BLOCKED_PERMISSION: "Mangler rettighed",
  NEEDS_USER_ACTION: "Kræver handling",
  FAILED: "Fejlet",
};

export interface Clip {
  id: number;
  twitch_clip_id: string;
  broadcaster_id: string;
  broadcaster_name: string | null;
  url: string | null;
  embed_url: string | null;
  creator_name: string | null;
  video_id: string | null;
  game_id: string | null;
  game_name: string | null;
  language: string | null;
  twitch_title: string | null;
  view_count: number | null;
  twitch_created_at: Date | null;
  thumbnail_url: string | null;
  duration: number | null;
  status: ClipStatus;
  status_reason: string | null;
  origin: string;
  priority: number;
  source_path: string | null;
  render_path: string | null;
  render_thumb_path: string | null;
  download_method: string | null;
  media_info: Record<string, unknown> | null;
  transcript: Record<string, unknown> | null;
  analysis: Record<string, unknown> | null;
  render_overrides: Record<string, unknown>;
  render_info: Record<string, unknown> | null;
  ai_title: string | null;
  manual_title: string | null;
  title_source: string | null;
  final_title: string | null;
  hashtags: string[] | null;
  caption: string | null;
  attempts: number;
  retry_stage: string | null;
  next_retry_at: Date | null;
  last_error: string | null;
  locked_by: string | null;
  locked_at: Date | null;
  tiktok_publish_id: string | null;
  tiktok_post_id: string | null;
  tiktok_url: string | null;
  published_at: Date | null;
  files_cleaned_at: Date | null;
  discovered_at: Date;
  created_at: Date;
  updated_at: Date;
}

export async function getClip(id: number): Promise<Clip | null> {
  const [row] = await sql()`SELECT * FROM clips WHERE id = ${id}`;
  return (row as unknown as Clip) ?? null;
}

export async function addEvent(clipId: number, message: string, opts: { from?: string | null; to?: string | null; level?: string; data?: unknown } = {}) {
  const db = sql();
  await db`INSERT INTO clip_events (clip_id, from_status, to_status, level, message, data)
           VALUES (${clipId}, ${opts.from ?? null}, ${opts.to ?? null}, ${opts.level ?? "info"}, ${message}, ${opts.data === undefined ? null : db.json(toJson(opts.data))})`;
}

/**
 * Atomic, guarded status transition. Only succeeds when the clip is currently in one of
 * `from` — this is what prevents two workers from processing the same clip.
 * Returns the updated clip, or null when the guard did not match.
 */
export async function transition(
  clipId: number,
  from: ClipStatus[],
  to: ClipStatus,
  patch: Record<string, unknown> = {},
  message?: string,
): Promise<Clip | null> {
  const db = sql();
  const fields = { ...patch, status: to, updated_at: new Date() };
  const [row] = await db`
    UPDATE clips SET ${db(fields as never)}
    WHERE id = ${clipId} AND status = ANY(${from as string[]})
    RETURNING *`;
  if (!row) return null;
  await addEvent(clipId, message ?? `Status: ${STATUS_LABELS[to]}`, { to, data: patch.status_reason ? { reason: patch.status_reason } : undefined });
  return row as unknown as Clip;
}

export async function patchClip(clipId: number, patch: Record<string, unknown>): Promise<void> {
  const db = sql();
  await db`UPDATE clips SET ${db({ ...patch, updated_at: new Date() } as never)} WHERE id = ${clipId}`;
}

/** Exponential backoff with ±25 % jitter. */
export function backoffMs(attempt: number, baseMs = 30_000, maxMs = 6 * 3600_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exp * 0.25 * (Math.random() * 2 - 1);
  return Math.max(1000, Math.round(exp + jitter));
}

export const MAX_ATTEMPTS = 8;

/**
 * Records a failure. Transient errors go to RETRY_WAIT with a backoff; after MAX_ATTEMPTS
 * or for permanent errors the clip goes to FAILED (manual retry from the dashboard).
 */
export async function failClip(
  clip: Pick<Clip, "id" | "status" | "attempts">,
  stage: "process" | "upload" | "status",
  err: unknown,
  opts: { permanent?: boolean; retryAt?: Date; status?: ClipStatus; reason?: string } = {},
): Promise<ClipStatus> {
  const message = err instanceof Error ? err.message : String(err);
  const attempts = clip.attempts + 1;
  let status: ClipStatus;
  let nextRetry: Date | null = null;
  if (opts.status) {
    status = opts.status;
    nextRetry = opts.retryAt ?? null;
  } else if (opts.permanent || attempts >= MAX_ATTEMPTS) {
    status = "FAILED";
  } else {
    status = "RETRY_WAIT";
    nextRetry = opts.retryAt ?? new Date(Date.now() + backoffMs(attempts));
  }
  await sql()`
    UPDATE clips SET status = ${status}, attempts = ${attempts}, retry_stage = ${stage},
      next_retry_at = ${nextRetry}, last_error = ${message.slice(0, 2000)},
      status_reason = ${opts.reason ?? message.slice(0, 500)}, locked_by = NULL, locked_at = NULL, updated_at = now()
    WHERE id = ${clip.id}`;
  await addEvent(clip.id, `${stage}: ${message}`, { from: clip.status, to: status, level: status === "RETRY_WAIT" ? "warn" : "error", data: { attempts, nextRetry } });
  return status;
}

/** Statuses a clip should resume from when a RETRY_WAIT/FAILED job is retried. */
export function resumeStatusFor(stage: string | null, clip: Pick<Clip, "render_path" | "source_path" | "tiktok_publish_id">): ClipStatus {
  if (stage === "upload" || stage === "status") return clip.tiktok_publish_id ? "PROCESSING" : "READY";
  if (clip.render_path) return "READY";
  if (clip.source_path) return "DOWNLOADED";
  return "QUEUED";
}
