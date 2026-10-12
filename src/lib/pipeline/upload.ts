import fs from "node:fs";
import { sql } from "../db";
import { getSettings, setState, type Settings } from "../settings";
import { addEvent, failClip, getClip, patchClip, transition, type Clip, type ClipStatus } from "../clips";
import { enqueueClip } from "../queue";
import { record, errMsg } from "../log";
import { buildHashtags, composeCaption } from "../ai/titles";
import type { StoredAnalysis } from "./process";
import {
  chunkPlan, creatorInfo, fetchStatus, initDirectPost, initInboxUpload, uploadChunks, TikTokError, TikTokNotConfigured, type PostInfo,
} from "../tiktok/api";
import { getTikTokRuntime, patchTikTokRuntime } from "../tiktok/state";
import { loadToken } from "../tokens";

const UPLOAD_URL_TTL_MS = 55 * 60_000; // TikTok: upload_url valid for one hour
const STATUS_GIVE_UP_MS = 24 * 3600_000;
/** No persisted progress for this long = the uploading worker is gone. */
const STALE_UPLOAD_MS = 5 * 60_000;
/** Init requests time out after 30 s; older INIT_PENDING rows belong to a dead worker. */
const STALE_INIT_MS = 2 * 60_000;

export interface UploadAttempt {
  id: number;
  clip_id: number;
  idempotency_key: string;
  state: string;
  mode: string;
  privacy_level: string | null;
  publish_id: string | null;
  upload_url_expires_at: Date | null;
  video_size: number | null;
  bytes_sent: number;
  tiktok_status: string | null;
  fail_reason: string | null;
  created_at: Date;
}

async function liveAttempt(clipId: number): Promise<UploadAttempt | null> {
  const [r] = await sql()`SELECT * FROM upload_attempts WHERE clip_id = ${clipId} AND state NOT IN ('FAILED','ABANDONED') ORDER BY id DESC LIMIT 1`;
  return (r as unknown as UploadAttempt) ?? null;
}

async function setAttempt(id: number, patch: Record<string, unknown>) {
  const db = sql();
  await db`UPDATE upload_attempts SET ${db({ ...patch, updated_at: new Date() } as never)} WHERE id = ${id}`;
}

/** Final caption at upload time, so hashtag-setting changes apply to clips still in the queue. */
export function captionFor(clip: Clip, settings: Settings): string {
  const ai = (clip.analysis as unknown as StoredAnalysis | null)?.ai;
  const tags = buildHashtags(settings.hashtags.fixed, ai?.hashtags ?? [], { max: settings.hashtags.maxTotal, aiEnabled: settings.hashtags.aiEnabled });
  return composeCaption(clip.final_title!, tags, settings.hashtags.captionMaxLength).caption;
}

/** Posting quota check from our own records (TikTok's cap is per creator per 24 h). */
export async function nextAllowedPostTime(settings: Settings, now = new Date()): Promise<{ at: Date | null; reason?: string }> {
  const runtime = await getTikTokRuntime();
  if (runtime.blockedUntil && Date.parse(runtime.blockedUntil) > now.getTime()) return { at: new Date(runtime.blockedUntil), reason: runtime.blockedReason ?? "TikTok rate limit" };
  const rows = await sql()`
    SELECT created_at FROM upload_attempts
    WHERE state IN ('INITIALIZED','UPLOADING','UPLOADED','COMPLETE') AND created_at > ${new Date(now.getTime() - 24 * 3600_000)}
    ORDER BY created_at ASC`;
  const times = rows.map((r) => (r.created_at as Date).getTime());
  if (times.length >= settings.automation.maxPostsPer24h) {
    return { at: new Date(times[times.length - settings.automation.maxPostsPer24h] + 24 * 3600_000 + 60_000), reason: `Postgrænse (${settings.automation.maxPostsPer24h}/24t) nået` };
  }
  const last = times[times.length - 1];
  const spacing = settings.automation.minMinutesBetweenPosts * 60_000;
  if (last && now.getTime() - last < spacing) return { at: new Date(last + spacing), reason: `Minimum ${settings.automation.minMinutesBetweenPosts} min mellem posts` };
  return { at: null };
}

/** Preconditions for posting at all. Returns a blocking reason or null. */
export async function uploadBlocker(settings: Settings): Promise<{ status: ClipStatus; reason: string } | null> {
  if (!settings.setup.rightsConfirmedAt) return { status: "BLOCKED_PERMISSION", reason: "Rettighedsbekræftelse mangler i opsætningen" };
  if (!settings.tiktok.consentAt || !settings.tiktok.musicConfirmationAt) return { status: "NEEDS_USER_ACTION", reason: "Samtykke til automatisk publicering og TikTok Music Usage Confirmation mangler (Account Settings)" };
  if (settings.tiktok.mode === "direct" && !settings.tiktok.privacyLevel) return { status: "NEEDS_USER_ACTION", reason: "Vælg synlighed (privacy level) for TikTok-posts" };
  const token = await loadToken("tiktok").catch(() => null);
  if (!token) return { status: "BLOCKED_PERMISSION", reason: "TikTok-konto er ikke forbundet" };
  if (token.status !== "ok") return { status: "BLOCKED_PERMISSION", reason: token.statusMessage ?? "TikTok-forbindelsen kræver ny godkendelse" };
  const scope = settings.tiktok.mode === "inbox" ? "video.upload" : "video.publish";
  if (!token.scopes.includes(scope)) return { status: "BLOCKED_PERMISSION", reason: `TikTok-tokenet mangler scope ${scope}` };
  const runtime = await getTikTokRuntime();
  if (runtime.ownerActionReason) return { status: "NEEDS_USER_ACTION", reason: runtime.ownerActionReason };
  return null;
}

/** Maps TikTok error codes to what we do with the clip and the account. */
async function handleTikTokError(clip: Clip, err: TikTokError, stage: "upload" | "status"): Promise<ClipStatus> {
  const code = err.code;
  if (code === "spam_risk_too_many_posts" || code === "rate_limit_exceeded") {
    const wait = code === "rate_limit_exceeded" ? 90_000 : 3 * 3600_000;
    const until = new Date(Date.now() + wait);
    await patchTikTokRuntime({ blockedUntil: until.toISOString(), blockedReason: code === "rate_limit_exceeded" ? "TikTok API rate limit" : "TikTok daglig postgrænse nået" });
    await sql()`UPDATE clips SET status = 'READY', next_retry_at = ${until}, status_reason = ${`Venter: ${code}`}, updated_at = now() WHERE id = ${clip.id}`;
    await addEvent(clip.id, `TikTok begrænsning (${code}) — venter til ${until.toLocaleString("da-DK")}`, { level: "warn", to: "READY" });
    return "READY";
  }
  if (code === "unaudited_client_can_only_post_to_private_accounts") {
    await patchTikTokRuntime({ unauditedSeenAt: new Date().toISOString() });
    return failClip(clip, stage, err, { status: "BLOCKED_PERMISSION", reason: "TikTok-appen er ikke auditeret: kun SELF_ONLY (privat) er tilladt. Vælg 'Kun mig' eller afvent TikToks audit." });
  }
  if (code === "privacy_level_option_mismatch") {
    return failClip(clip, stage, err, { status: "NEEDS_USER_ACTION", reason: "Den valgte synlighed er ikke tilladt for kontoen — vælg igen i Account Settings" });
  }
  if (code === "spam_risk_user_banned_from_posting") {
    await patchTikTokRuntime({ ownerActionReason: "TikTok har blokeret kontoen fra at poste via API", ownerActionAt: new Date().toISOString() });
    return failClip(clip, stage, err, { status: "NEEDS_USER_ACTION", reason: "TikTok har blokeret kontoen fra at poste" });
  }
  if (["access_token_invalid", "scope_not_authorized", "auth_removed", "refresh_failed", "not_connected", "scope_permission_missed", "reached_active_user_cap"].includes(code)) {
    return failClip(clip, stage, err, { status: "BLOCKED_PERMISSION", reason: `TikTok-adgang: ${code}` });
  }
  if (["file_format_check_failed", "duration_check_failed", "frame_rate_check_failed", "picture_size_check_failed", "invalid_params"].includes(code)) {
    return failClip(clip, stage, err, { permanent: true });
  }
  return failClip(clip, stage, err);
}

/**
 * Starts (or safely resumes) the TikTok upload for one READY clip.
 * Double-publish protection:
 *  - at most one live attempt per clip (unique partial index);
 *  - once a publish_id exists we only ever poll its status — we never init again
 *    unless TikTok itself reports FAILED or the upload provably never completed.
 */
export async function uploadClip(clipId: number, opts: { force?: boolean } = {}): Promise<ClipStatus | "skipped"> {
  const settings = await getSettings();
  let clip = await getClip(clipId);
  if (!clip) return "skipped";

  const existing = await liveAttempt(clipId);
  if (existing?.publish_id && ["INITIALIZED", "UPLOADING", "UPLOADED"].includes(existing.state)) {
    // Another worker is actively uploading (progress is persisted after every chunk).
    const lastProgress = new Date((existing as unknown as { updated_at: Date }).updated_at).getTime();
    if (clip.status === "UPLOADING" && existing.state !== "UPLOADED" && Date.now() - lastProgress < STALE_UPLOAD_MS) return "skipped";
    // Resume path after a crash: never re-init — inspect status first.
    if (clip.status !== "PROCESSING") await transition(clipId, ["READY", "UPLOADING", "RETRY_WAIT"], "PROCESSING", { tiktok_publish_id: existing.publish_id }, "Genoptager: tjekker status for eksisterende TikTok-upload");
    await enqueueClip("status", clipId, { delay: 2000 });
    return "PROCESSING";
  }
  if (existing && existing.state === "INIT_PENDING") {
    // Another worker may be waiting for its init response right now.
    if (Date.now() - new Date(existing.created_at).getTime() < STALE_INIT_MS) return "skipped";
    // Init never returned a publish_id, so no bytes can have been sent — nothing can be published.
    await setAttempt(existing.id, { state: "ABANDONED", error: "init uden svar — ingen data sendt" });
    await addEvent(clipId, "Forrige upload-init fik intet svar; ingen videodata var sendt, så den lukkes sikkert", { level: "warn" });
  }
  if (clip.status !== "READY" && clip.status !== "UPLOADING") return "skipped";
  if (!opts.force && !settings.automation.autoPublish) return "skipped";
  if (settings.tiktok.mode === "manual") {
    await patchClip(clipId, { status_reason: "Manuel tilstand: download videoen fra dashboardet og upload selv" });
    return "skipped";
  }
  const blocker = await uploadBlocker(settings);
  if (blocker) {
    return failClip(clip, "upload", new Error(blocker.reason), { status: blocker.status, reason: blocker.reason });
  }
  const slot = await nextAllowedPostTime(settings);
  if (slot.at) {
    await sql()`UPDATE clips SET next_retry_at = ${slot.at}, status_reason = ${`${slot.reason} — næste forsøg ${slot.at.toLocaleString("da-DK")}`}, updated_at = now() WHERE id = ${clipId} AND status = 'READY'`;
    return "READY";
  }
  if (!clip.render_path || !fs.existsSync(clip.render_path)) {
    await transition(clipId, ["READY"], "DOWNLOADED", { render_path: null }, "Renderet fil mangler — genrenderer");
    await enqueueClip("process", clipId);
    return "DOWNLOADED";
  }
  if (!clip.final_title) return failClip(clip, "upload", new Error("Clippet mangler titel"), { status: "FAILED" });

  // FIFO: only the oldest due READY clip may start, so a long queue is published in order.
  const [older] = await sql()`SELECT id FROM clips WHERE status = 'READY' AND id <> ${clipId} AND (next_retry_at IS NULL OR next_retry_at <= now())
                               AND COALESCE(twitch_created_at, created_at) < ${clip.twitch_created_at ?? clip.created_at} ORDER BY COALESCE(twitch_created_at, created_at) LIMIT 1`;
  if (older && !opts.force && settings.automation.selection !== "newest") {
    await enqueueClip("upload", Number(older.id));
    return "READY";
  }

  const claimed = await transition(clipId, ["READY"], "UPLOADING", { next_retry_at: null, status_reason: null }, "Uploader til TikTok");
  if (!claimed) return "skipped";
  clip = claimed;

  const size = (await fs.promises.stat(clip.render_path!)).size;
  const plan = chunkPlan(size);
  const mode = settings.tiktok.mode as "direct" | "inbox";
  let privacy: string | null = null;
  let postInfo: PostInfo | null = null;
  try {
    if (mode === "direct") {
      const ci = await creatorInfo();
      privacy = settings.tiktok.privacyLevel!;
      if (!ci.privacy_level_options.includes(privacy)) {
        throw new TikTokError(`Synligheden ${privacy} er ikke blandt kontoens muligheder (${ci.privacy_level_options.join(", ")})`, "privacy_level_option_mismatch", 400);
      }
      const duration = Number((clip.media_info as { duration?: number } | null)?.duration ?? clip.duration ?? 0);
      if (ci.max_video_post_duration_sec && duration > ci.max_video_post_duration_sec) {
        throw new TikTokError(`Videoen er længere end kontoens grænse (${ci.max_video_post_duration_sec}s)`, "duration_check_failed", 400);
      }
      postInfo = {
        title: captionFor(clip, settings),
        privacy_level: privacy,
        disable_comment: ci.comment_disabled || !settings.tiktok.allowComment,
        disable_duet: ci.duet_disabled || !settings.tiktok.allowDuet,
        disable_stitch: ci.stitch_disabled || !settings.tiktok.allowStitch,
        brand_content_toggle: settings.tiktok.brandContent,
        brand_organic_toggle: settings.tiktok.brandOrganic,
        is_aigc: settings.tiktok.isAigc,
        video_cover_timestamp_ms: 1000,
      };
    }
  } catch (err) {
    const fresh = (await getClip(clipId))!;
    if (err instanceof TikTokError) return handleTikTokError(fresh, err, "upload");
    return failClip(fresh, "upload", err);
  }

  const [{ n }] = await sql()`SELECT count(*)::int AS n FROM upload_attempts WHERE clip_id = ${clipId}`;
  const key = `clip-${clipId}-attempt-${Number(n) + 1}`;
  let attemptId: number;
  try {
    const [a] = await sql()`INSERT INTO upload_attempts (clip_id, idempotency_key, state, mode, privacy_level, video_size)
                            VALUES (${clipId}, ${key}, 'INIT_PENDING', ${mode}, ${privacy}, ${size}) RETURNING id`;
    attemptId = Number(a.id);
  } catch (err) {
    // Unique index hit: another worker already owns a live attempt for this clip.
    await addEvent(clipId, `Upload sprunget over: der findes allerede et aktivt forsøg (${errMsg(err)})`, { level: "warn" });
    return "skipped";
  }

  let publishId: string;
  let uploadUrl: string;
  try {
    const r = mode === "direct" ? await initDirectPost(postInfo!, plan) : await initInboxUpload(plan);
    publishId = r.publish_id;
    uploadUrl = r.upload_url;
    // Persist publish_id BEFORE sending any bytes: from here on we can always ask TikTok.
    await setAttempt(attemptId, { state: "INITIALIZED", publish_id: publishId, upload_url_expires_at: new Date(Date.now() + UPLOAD_URL_TTL_MS) });
    await patchClip(clipId, { tiktok_publish_id: publishId });
    await addEvent(clipId, `TikTok init OK (publish_id ${publishId}, ${plan.totalChunks} chunk(s), ${mode === "direct" ? privacy : "inbox"})`);
  } catch (err) {
    await setAttempt(attemptId, { state: "FAILED", error: errMsg(err), fail_reason: err instanceof TikTokError ? err.code : null });
    const fresh = (await getClip(clipId))!;
    if (err instanceof TikTokError) return handleTikTokError(fresh, err, "upload");
    if (err instanceof TikTokNotConfigured) return failClip(fresh, "upload", err, { status: "BLOCKED_PERMISSION" });
    return failClip(fresh, "upload", err);
  }

  try {
    await setAttempt(attemptId, { state: "UPLOADING" });
    await uploadChunks(uploadUrl, clip.render_path!, plan, async (sent) => setAttempt(attemptId, { bytes_sent: sent }));
    await setAttempt(attemptId, { state: "UPLOADED" });
    await addEvent(clipId, `Video uploadet (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    // Outcome of the last chunk may be unknown. Do NOT re-upload: let status polling decide.
    await addEvent(clipId, `Upload afbrudt: ${errMsg(err)} — undersøger status hos TikTok før noget andet`, { level: "warn" });
  }
  await transition(clipId, ["UPLOADING"], "PROCESSING", {}, "TikTok behandler videoen");
  await enqueueClip("status", clipId, { delay: 5000 });
  return "PROCESSING";
}

/** Polls publish status. Re-schedules itself with backoff until a terminal TikTok status. */
export async function checkPublishStatus(clipId: number, pollCount = 0): Promise<{ status: ClipStatus | "skipped"; nextDelayMs?: number }> {
  const clip = await getClip(clipId);
  if (!clip || clip.status !== "PROCESSING") return { status: "skipped" };
  const attempt = await liveAttempt(clipId);
  if (!attempt?.publish_id) {
    // No publish_id means nothing was ever sent: safe to go back to READY.
    await transition(clipId, ["PROCESSING"], "READY", { tiktok_publish_id: null }, "Ingen aktiv upload fundet — tilbage i kø");
    return { status: "READY" };
  }
  let st;
  try {
    st = await fetchStatus(attempt.publish_id);
  } catch (err) {
    if (err instanceof TikTokError && !err.isNetwork && err.httpStatus < 500 && err.code !== "rate_limit_exceeded") {
      if (["access_token_invalid", "refresh_failed", "not_connected", "auth_removed"].includes(err.code)) {
        await addEvent(clipId, `Kan ikke tjekke status: ${err.message}`, { level: "warn" });
        return { status: "PROCESSING", nextDelayMs: 15 * 60_000 };
      }
    }
    // Unknown — keep polling, never re-upload.
    return { status: "PROCESSING", nextDelayMs: Math.min(10 * 60_000, 15_000 * 2 ** Math.min(pollCount, 6)) };
  }
  await setAttempt(attempt.id, { tiktok_status: st.status, fail_reason: st.fail_reason ?? null });

  if (st.status === "PUBLISH_COMPLETE") {
    const token = await loadToken("tiktok").catch(() => null);
    const username = (token?.meta as { username?: string } | undefined)?.username;
    const postId = st.publicaly_available_post_id?.[0] ? String(st.publicaly_available_post_id[0]) : null;
    const url = postId && username ? `https://www.tiktok.com/@${username}/video/${postId}` : username ? `https://www.tiktok.com/@${username}` : null;
    await setAttempt(attempt.id, { state: "COMPLETE" });
    await transition(clipId, ["PROCESSING"], "PUBLISHED", { tiktok_post_id: postId, tiktok_url: url, published_at: new Date(), status_reason: null, last_error: null, attempts: 0 },
      `Publiceret på TikTok${attempt.privacy_level ? ` (${attempt.privacy_level})` : ""}${postId ? ` — post ${postId}` : ""}`);
    if (attempt.privacy_level === "PUBLIC_TO_EVERYONE" && postId) await patchTikTokRuntime({ publicVerifiedAt: (await getTikTokRuntime()).publicVerifiedAt ?? new Date().toISOString() });
    else await patchTikTokRuntime({ lastPrivatePostAt: new Date().toISOString() });
    await setState("tiktok.lastPostAt", new Date().toISOString());
    return { status: "PUBLISHED" };
  }
  if (st.status === "SEND_TO_USER_INBOX") {
    await setAttempt(attempt.id, { state: "COMPLETE" });
    await transition(clipId, ["PROCESSING"], "NEEDS_USER_ACTION", { status_reason: "Videoen ligger som udkast i TikTok-appens indbakke — åbn appen og publicér den. Markér derefter som publiceret." },
      "Sendt til TikTok-indbakke (udkast)");
    await setState("tiktok.lastPostAt", new Date().toISOString());
    return { status: "NEEDS_USER_ACTION" };
  }
  if (st.status === "FAILED") {
    // TikTok confirms nothing was published: a new attempt is safe.
    await setAttempt(attempt.id, { state: "FAILED", error: st.fail_reason ?? "FAILED" });
    await patchClip(clipId, { tiktok_publish_id: null });
    const err = new TikTokError(`TikTok afviste videoen: ${st.fail_reason ?? "ukendt årsag"}`, st.fail_reason ?? "failed", 200);
    const fresh = (await getClip(clipId))!;
    return { status: await handleTikTokError(fresh, err, "status") };
  }
  // Still processing.
  const sinceInit = Date.now() - new Date(attempt.created_at).getTime();
  const urlExpired = attempt.upload_url_expires_at && attempt.upload_url_expires_at.getTime() < Date.now();
  if (st.status === "PROCESSING_UPLOAD" && urlExpired && attempt.video_size && (st.uploaded_bytes ?? 0) < attempt.video_size && attempt.state !== "UPLOADED") {
    // The upload provably never finished and can no longer finish: safe to retry from scratch.
    await setAttempt(attempt.id, { state: "ABANDONED", error: `upload ufuldstændig (${st.uploaded_bytes ?? 0}/${attempt.video_size} bytes) og upload-URL udløbet` });
    await transition(clipId, ["PROCESSING"], "READY", { tiktok_publish_id: null }, "Ufuldstændig upload udløbet hos TikTok — prøver igen");
    await enqueueClip("upload", clipId, { delay: 60_000 });
    return { status: "READY" };
  }
  if (sinceInit > STATUS_GIVE_UP_MS) {
    await transition(clipId, ["PROCESSING"], "NEEDS_USER_ACTION", { status_reason: `TikTok har vist "${st.status}" i over 24 timer. Tjek profilen manuelt; vi uploader ikke igen automatisk.` }, "Uafklaret TikTok-status");
    await record("warn", "tiktok", `Clip ${clipId}: status ${st.status} i over 24t`);
    return { status: "NEEDS_USER_ACTION" };
  }
  return { status: "PROCESSING", nextDelayMs: Math.min(5 * 60_000, 10_000 * 2 ** Math.min(pollCount, 5)) };
}

/** Dashboard: the owner confirms an inbox draft / uncertain upload was published (or not). */
export async function resolveUserAction(clipId: number, outcome: "published" | "not_published", url?: string) {
  const clip = await getClip(clipId);
  if (!clip || clip.status !== "NEEDS_USER_ACTION") throw new Error("Clippet afventer ikke handling");
  if (outcome === "published") {
    await transition(clipId, ["NEEDS_USER_ACTION"], "PUBLISHED", { published_at: new Date(), tiktok_url: url || clip.tiktok_url, status_reason: "Markeret som publiceret af kontoejeren" }, "Markeret som publiceret manuelt");
  } else {
    await sql()`UPDATE upload_attempts SET state = 'ABANDONED', error = 'ejer bekræftede: ikke publiceret', updated_at = now() WHERE clip_id = ${clipId} AND state NOT IN ('FAILED','ABANDONED')`;
    await transition(clipId, ["NEEDS_USER_ACTION"], "READY", { tiktok_publish_id: null, attempts: 0, status_reason: null }, "Ejer bekræftede: ikke publiceret — sat i kø igen");
    await enqueueClip("upload", clipId);
  }
}
