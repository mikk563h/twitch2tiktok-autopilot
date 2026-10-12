import { config } from "../config";
import { saveToken } from "../tokens";
import { TwitchError } from "./api";

export function twitchRedirectUri() {
  return `${config.appUrl}/api/oauth/twitch/callback`;
}

export function twitchAuthorizeUrl(state: string, role: "broadcaster" | "editor") {
  const scope = role === "broadcaster" ? "channel:manage:clips" : "editor:manage:clips";
  const p = new URLSearchParams({ response_type: "code", client_id: config.twitchClientId ?? "", redirect_uri: twitchRedirectUri(), scope, state, force_verify: "true" });
  return `${config.twitchAuthBase}/authorize?${p}`;
}

export async function exchangeTwitchCode(code: string) {
  const res = await fetch(`${config.twitchAuthBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.twitchClientId ?? "", client_secret: config.twitchClientSecret ?? "", code, grant_type: "authorization_code", redirect_uri: twitchRedirectUri() }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string[]; message?: string };
  if (!res.ok || !body.access_token) throw new TwitchError(`Twitch OAuth fejlede: ${body.message ?? res.status}`, res.status);
  const v = await fetch(`${config.twitchAuthBase}/validate`, { headers: { Authorization: `OAuth ${body.access_token}` } });
  const info = (await v.json().catch(() => ({}))) as { login?: string; user_id?: string; scopes?: string[] };
  if (!v.ok || !info.user_id) throw new TwitchError("Kunne ikke validere Twitch-token", v.status);
  await saveToken({
    provider: "twitch_user", accountId: info.user_id, accountName: info.login ?? null, scopes: info.scopes ?? body.scope ?? [],
    accessToken: body.access_token, refreshToken: body.refresh_token ?? null, expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
    refreshExpiresAt: null, meta: { isBroadcaster: info.login?.toLowerCase() === config.twitchChannel },
  });
  return info;
}
