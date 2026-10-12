import { config } from "../config";
import { sql } from "../db";
import { loadToken, saveToken, markToken, type StoredToken } from "../tokens";
import { setState } from "../settings";

export class TwitchError extends Error {
  constructor(message: string, public status: number, public retryAfterMs?: number) {
    super(message);
  }
}

export class TwitchNotConfigured extends Error {}

export interface TwitchClip {
  id: string;
  url: string;
  embed_url: string;
  broadcaster_id: string;
  broadcaster_name: string;
  creator_id: string;
  creator_name: string;
  video_id: string;
  game_id: string;
  language: string;
  title: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
  vod_offset: number | null;
  is_featured?: boolean;
}

/** Scopes that allow the official "Get Clips Download" endpoint. */
export const TWITCH_DOWNLOAD_SCOPES = ["editor:manage:clips", "channel:manage:clips"];

function credentials() {
  const id = config.twitchClientId;
  const secret = config.twitchClientSecret;
  if (!id || !secret) throw new TwitchNotConfigured("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET er ikke sat");
  return { id, secret };
}

/** App access token (client credentials), cached encrypted in the DB and renewed before expiry. */
export async function appToken(force = false): Promise<string> {
  const cached = await loadToken("twitch_app");
  if (!force && cached && cached.expiresAt && cached.expiresAt.getTime() - Date.now() > 10 * 60_000) return cached.accessToken;
  const { id, secret } = credentials();
  const res = await fetch(`${config.twitchAuthBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; message?: string };
  if (!res.ok || !body.access_token) throw new TwitchError(`Twitch app-token fejlede: ${body.message ?? res.status}`, res.status);
  await saveToken({
    provider: "twitch_app", accountId: null, accountName: null, scopes: [], accessToken: body.access_token, refreshToken: null,
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000), refreshExpiresAt: null, meta: {},
  });
  return body.access_token;
}

/** User token (broadcaster or editor), refreshed under an advisory lock so workers don't race. */
export async function userToken(): Promise<StoredToken | null> {
  const t = await loadToken("twitch_user");
  if (!t || !t.refreshToken) return t;
  if (t.expiresAt && t.expiresAt.getTime() - Date.now() > 5 * 60_000) return t;
  return sql().begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('refresh:twitch_user'))`;
    const fresh = await loadToken("twitch_user");
    if (!fresh?.refreshToken) return fresh;
    if (fresh.expiresAt && fresh.expiresAt.getTime() - Date.now() > 5 * 60_000) return fresh;
    const { id, secret } = credentials();
    const res = await fetch(`${config.twitchAuthBase}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "refresh_token", refresh_token: fresh.refreshToken }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string[]; message?: string };
    if (!res.ok || !body.access_token) {
      await markToken("twitch_user", "refresh_failed", `Twitch-token kunne ikke fornyes: ${body.message ?? res.status}. Forbind Twitch igen.`);
      return null;
    }
    const next = { ...fresh, accessToken: body.access_token, refreshToken: body.refresh_token ?? fresh.refreshToken,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000), scopes: body.scope ?? fresh.scopes };
    await saveToken(next);
    return next;
  });
}

let rateLimitedUntil = 0;

/** Helix GET with rate-limit handling (Ratelimit-Remaining / Ratelimit-Reset) and one token refresh on 401. */
export async function helix<T>(path: string, params: URLSearchParams, opts: { token?: "app" | "user" } = {}): Promise<{ data: T[]; pagination?: { cursor?: string } }> {
  const { id } = credentials();
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = rateLimitedUntil - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
    let token: string;
    if (opts.token === "user") {
      const t = await userToken();
      if (!t) throw new TwitchError("Ingen gyldig Twitch-brugerforbindelse", 401);
      token = t.accessToken;
    } else {
      token = await appToken(attempt > 0);
    }
    const res = await fetch(`${config.twitchApiBase}${path}?${params}`, {
      headers: { "Client-Id": id, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const remaining = Number(res.headers.get("ratelimit-remaining"));
    const reset = Number(res.headers.get("ratelimit-reset"));
    if (Number.isFinite(remaining) && remaining <= 2 && Number.isFinite(reset)) rateLimitedUntil = reset * 1000;
    if (res.status === 429) {
      rateLimitedUntil = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 15_000;
      continue;
    }
    if (res.status === 401 && attempt === 0 && opts.token !== "user") continue; // app token renewed on retry
    const body = (await res.json().catch(() => ({}))) as { data?: T[]; pagination?: { cursor?: string }; message?: string };
    if (!res.ok) throw new TwitchError(`Twitch ${path} ${res.status}: ${body.message ?? res.statusText}`, res.status);
    if (opts.token !== "user") await setState("twitch.apiOkAt", new Date().toISOString()).catch(() => {});
    else await setState("twitch.userApiOkAt", new Date().toISOString()).catch(() => {});
    return { data: body.data ?? [], pagination: body.pagination };
  }
  throw new TwitchError(`Twitch ${path}: rate limit`, 429, Math.max(1000, rateLimitedUntil - Date.now()));
}

export async function getUserByLogin(login: string) {
  const { data } = await helix<{ id: string; login: string; display_name: string; profile_image_url: string }>("/users", new URLSearchParams({ login }));
  return data[0] ?? null;
}

const gameCache = new Map<string, string>();
export async function getGameNames(ids: string[]): Promise<Map<string, string>> {
  const missing = [...new Set(ids.filter((i) => i && !gameCache.has(i)))];
  for (let i = 0; i < missing.length; i += 100) {
    const p = new URLSearchParams();
    missing.slice(i, i + 100).forEach((g) => p.append("id", g));
    const { data } = await helix<{ id: string; name: string }>("/games", p);
    data.forEach((g) => gameCache.set(g.id, g.name));
  }
  return new Map(ids.filter((i) => gameCache.has(i)).map((i) => [i, gameCache.get(i)!]));
}

/** Official download URLs (requires editor:manage:clips or channel:manage:clips). */
export async function getClipDownloadUrls(broadcasterId: string, editorId: string, clipIds: string[]) {
  const p = new URLSearchParams({ broadcaster_id: broadcasterId, editor_id: editorId });
  clipIds.slice(0, 10).forEach((c) => p.append("clip_id", c));
  const { data } = await helix<{ clip_id: string; landscape_download_url: string | null; portrait_download_url: string | null }>("/clips/downloads", p, { token: "user" });
  return data;
}
