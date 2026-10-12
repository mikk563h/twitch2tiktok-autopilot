import fs from "node:fs";
import { config } from "../config";
import { sql } from "../db";
import { loadToken, markToken, saveToken, type StoredToken } from "../tokens";
import { setState } from "../settings";

export const TIKTOK_SCOPES = (process.env.TIKTOK_SCOPES ?? "user.info.basic,video.publish,video.upload").split(",").map((s) => s.trim()).filter(Boolean);

export class TikTokError extends Error {
  constructor(message: string, public code: string, public httpStatus: number, public logId?: string) {
    super(message);
  }
  /** No HTTP response at all (network/timeout) — outcome unknown. */
  get isNetwork() { return this.httpStatus === 0; }
}

export class TikTokNotConfigured extends Error {}

function creds() {
  if (!config.tiktokClientKey || !config.tiktokClientSecret) throw new TikTokNotConfigured("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET er ikke sat");
  return { key: config.tiktokClientKey, secret: config.tiktokClientSecret };
}

export function redirectUri() {
  return `${config.appUrl}/api/oauth/tiktok/callback`;
}

export function authorizeUrl(state: string): string {
  const { key } = creds();
  const p = new URLSearchParams({ client_key: key, scope: TIKTOK_SCOPES.join(","), response_type: "code", redirect_uri: redirectUri(), state });
  return `${config.tiktokAuthUrl}?${p}`;
}

interface TokenResponse {
  access_token?: string; expires_in?: number; open_id?: string; refresh_token?: string; refresh_expires_in?: number; scope?: string;
  error?: string; error_description?: string; log_id?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${config.tiktokApiBase}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) throw new TikTokError(`TikTok token-fejl: ${body.error_description ?? body.error ?? res.status}`, body.error ?? "token_error", res.status, body.log_id);
  return body;
}

async function persist(body: TokenResponse, prev?: StoredToken | null) {
  const t: Omit<StoredToken, "updatedAt" | "status" | "statusMessage"> = {
    provider: "tiktok",
    accountId: body.open_id ?? prev?.accountId ?? null,
    accountName: prev?.accountName ?? null,
    scopes: body.scope ? body.scope.split(",") : prev?.scopes ?? [],
    accessToken: body.access_token!,
    refreshToken: body.refresh_token ?? prev?.refreshToken ?? null,
    expiresAt: new Date(Date.now() + (body.expires_in ?? 86400) * 1000),
    refreshExpiresAt: body.refresh_expires_in ? new Date(Date.now() + body.refresh_expires_in * 1000) : prev?.refreshExpiresAt ?? null,
    meta: prev?.meta ?? {},
  };
  await saveToken(t);
  return (await loadToken("tiktok"))!;
}

export async function exchangeCode(code: string): Promise<StoredToken> {
  const { key, secret } = creds();
  const body = await tokenRequest({ client_key: key, client_secret: secret, code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  const token = await persist(body);
  try {
    const u = await userInfo(token.accessToken);
    await saveToken({ ...token, accountName: u.display_name ?? null, meta: { ...token.meta, avatar: u.avatar_url, username: u.username } });
  } catch { /* profile info is cosmetic */ }
  return (await loadToken("tiktok"))!;
}

/** Valid access token; refreshes (under an advisory lock) shortly before expiry. */
export async function accessToken(): Promise<string> {
  const t = await loadToken("tiktok");
  if (!t) throw new TikTokError("TikTok-konto er ikke forbundet", "not_connected", 401);
  if (t.status === "revoked") throw new TikTokError(t.statusMessage ?? "TikTok-adgang er tilbagekaldt", "auth_removed", 401);
  if (t.expiresAt && t.expiresAt.getTime() - Date.now() > 10 * 60_000) return t.accessToken;
  return sql().begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('refresh:tiktok'))`;
    const fresh = await loadToken("tiktok");
    if (!fresh) throw new TikTokError("TikTok-konto er ikke forbundet", "not_connected", 401);
    if (fresh.expiresAt && fresh.expiresAt.getTime() - Date.now() > 10 * 60_000) return fresh.accessToken;
    if (!fresh.refreshToken) throw new TikTokError("Ingen refresh-token — forbind TikTok igen", "refresh_failed", 401);
    const { key, secret } = creds();
    try {
      const body = await tokenRequest({ client_key: key, client_secret: secret, grant_type: "refresh_token", refresh_token: fresh.refreshToken });
      return (await persist(body, fresh)).accessToken;
    } catch (err) {
      const msg = `TikTok-token kunne ikke fornyes (${err instanceof Error ? err.message : err}). Forbind TikTok igen.`;
      if (err instanceof TikTokError && err.httpStatus >= 400 && err.httpStatus < 500) await markToken("tiktok", "refresh_failed", msg);
      throw new TikTokError(msg, "refresh_failed", err instanceof TikTokError ? err.httpStatus : 0);
    }
  });
}

interface ApiEnvelope<T> { data?: T; error?: { code: string; message: string; log_id?: string } }

export async function tiktokPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  const tok = token ?? (await accessToken());
  let res: Response;
  try {
    res = await fetch(`${config.tiktokApiBase}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new TikTokError(`Netværksfejl mod TikTok ${path}: ${err instanceof Error ? err.message : err}`, "network_error", 0);
  }
  const j = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
  const code = j.error?.code ?? (res.ok ? "ok" : `http_${res.status}`);
  if (!res.ok || code !== "ok") throw new TikTokError(`TikTok ${path}: ${code} — ${j.error?.message ?? res.statusText}`, code, res.status, j.error?.log_id);
  return j.data as T;
}

export async function userInfo(token?: string) {
  const tok = token ?? (await accessToken());
  const res = await fetch(`${config.tiktokApiBase}/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username`, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20_000) });
  const j = (await res.json().catch(() => ({}))) as ApiEnvelope<{ user: { open_id: string; display_name?: string; avatar_url?: string; username?: string } }>;
  if (!res.ok || (j.error && j.error.code !== "ok")) throw new TikTokError(`TikTok user/info: ${j.error?.code ?? res.status}`, j.error?.code ?? "error", res.status);
  return j.data!.user;
}

export interface CreatorInfo {
  creator_avatar_url: string;
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
}

export async function creatorInfo() {
  const ci = await tiktokPost<CreatorInfo>("/v2/post/publish/creator_info/query/", {});
  await setState("tiktok.lastOkAt", new Date().toISOString()).catch(() => {});
  return ci;
}

export interface ChunkPlan { videoSize: number; chunkSize: number; totalChunks: number }

const MB = 1024 * 1024;
/** TikTok rules: chunks 5–64 MB, final chunk may be up to 128 MB, files < 5 MB in one chunk. */
export function chunkPlan(size: number, preferred = 10 * MB): ChunkPlan {
  if (size <= 0) throw new Error("Tom fil");
  // Up to 64 MB fits in a single chunk (and below 5 MB it must be a single chunk).
  if (size <= 64 * MB) return { videoSize: size, chunkSize: size, totalChunks: 1 };
  const chunkSize = Math.min(64 * MB, Math.max(5 * MB, preferred));
  // floor(): the remainder rides along in the last chunk (< 2 × chunkSize ≤ 128 MB).
  return { videoSize: size, chunkSize, totalChunks: Math.floor(size / chunkSize) };
}

export interface PostInfo {
  title: string;
  privacy_level: string;
  disable_duet: boolean;
  disable_comment: boolean;
  disable_stitch: boolean;
  video_cover_timestamp_ms?: number;
  brand_content_toggle: boolean;
  brand_organic_toggle: boolean;
  is_aigc?: boolean;
}

export function initDirectPost(postInfo: PostInfo, plan: ChunkPlan) {
  return tiktokPost<{ publish_id: string; upload_url: string }>("/v2/post/publish/video/init/", {
    post_info: postInfo,
    source_info: { source: "FILE_UPLOAD", video_size: plan.videoSize, chunk_size: plan.chunkSize, total_chunk_count: plan.totalChunks },
  });
}

export function initInboxUpload(plan: ChunkPlan) {
  return tiktokPost<{ publish_id: string; upload_url: string }>("/v2/post/publish/inbox/video/init/", {
    source_info: { source: "FILE_UPLOAD", video_size: plan.videoSize, chunk_size: plan.chunkSize, total_chunk_count: plan.totalChunks },
  });
}

/**
 * Uploads chunks sequentially. `startChunk` allows resuming. Each chunk is retried a few
 * times; `onChunk` persists progress after every accepted chunk.
 */
export async function uploadChunks(uploadUrl: string, file: string, plan: ChunkPlan, onChunk: (bytesSent: number) => Promise<void>, startChunk = 0) {
  const fd = await fs.promises.open(file, "r");
  try {
    for (let i = startChunk; i < plan.totalChunks; i++) {
      const first = i * plan.chunkSize;
      const last = i === plan.totalChunks - 1 ? plan.videoSize - 1 : first + plan.chunkSize - 1;
      const len = last - first + 1;
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, first);
      let lastErr: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch(uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": "video/mp4", "Content-Length": String(len), "Content-Range": `bytes ${first}-${last}/${plan.videoSize}` },
            body: buf,
            signal: AbortSignal.timeout(5 * 60_000),
          });
          if (res.status === 201 || res.status === 206 || res.ok) {
            lastErr = undefined;
            break;
          }
          lastErr = new TikTokError(`Chunk ${i + 1}/${plan.totalChunks} afvist: HTTP ${res.status}`, `upload_http_${res.status}`, res.status);
          if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        } catch (err) {
          lastErr = new TikTokError(`Chunk ${i + 1}/${plan.totalChunks} netværksfejl: ${err instanceof Error ? err.message : err}`, "network_error", 0);
        }
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
      if (lastErr) throw lastErr;
      await onChunk(last + 1);
    }
  } finally {
    await fd.close();
  }
}

export interface PublishStatus {
  status: "PROCESSING_UPLOAD" | "PROCESSING_DOWNLOAD" | "SEND_TO_USER_INBOX" | "PUBLISH_COMPLETE" | "FAILED" | string;
  fail_reason?: string;
  publicaly_available_post_id?: Array<number | string>;
  uploaded_bytes?: number;
  downloaded_bytes?: number;
}

export function fetchStatus(publishId: string) {
  return tiktokPost<PublishStatus>("/v2/post/publish/status/fetch/", { publish_id: publishId });
}
