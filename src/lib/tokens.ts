import { sql } from "./db";
import { decrypt, encrypt } from "./crypto";

export type Provider = "twitch_user" | "twitch_app" | "tiktok";

export interface StoredToken {
  provider: Provider;
  accountId: string | null;
  accountName: string | null;
  scopes: string[];
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
  meta: Record<string, unknown>;
  status: "ok" | "refresh_failed" | "revoked";
  statusMessage: string | null;
  updatedAt: Date;
}

export async function loadToken(provider: Provider): Promise<StoredToken | null> {
  const [r] = await sql()`SELECT * FROM oauth_tokens WHERE provider = ${provider}`;
  if (!r) return null;
  return {
    provider,
    accountId: r.account_id as string | null,
    accountName: r.account_name as string | null,
    scopes: (r.scopes as string[]) ?? [],
    accessToken: decrypt(r.access_token_enc as string),
    refreshToken: r.refresh_token_enc ? decrypt(r.refresh_token_enc as string) : null,
    expiresAt: r.expires_at as Date | null,
    refreshExpiresAt: r.refresh_expires_at as Date | null,
    meta: (r.meta as Record<string, unknown>) ?? {},
    status: r.status as StoredToken["status"],
    statusMessage: r.status_message as string | null,
    updatedAt: r.updated_at as Date,
  };
}

/** Token metadata without decrypting secrets (safe for dashboard rendering). */
export async function tokenInfo(provider: Provider) {
  const [r] = await sql()`SELECT provider, account_id, account_name, scopes, expires_at, refresh_expires_at, meta, status, status_message, updated_at
                          FROM oauth_tokens WHERE provider = ${provider}`;
  return r ?? null;
}

export async function saveToken(t: Omit<StoredToken, "updatedAt" | "status" | "statusMessage"> & { status?: StoredToken["status"] }) {
  const db = sql();
  await db`
    INSERT INTO oauth_tokens (provider, account_id, account_name, scopes, access_token_enc, refresh_token_enc, expires_at, refresh_expires_at, meta, status, status_message, updated_at)
    VALUES (${t.provider}, ${t.accountId}, ${t.accountName}, ${t.scopes}, ${encrypt(t.accessToken)}, ${t.refreshToken ? encrypt(t.refreshToken) : null},
            ${t.expiresAt}, ${t.refreshExpiresAt}, ${db.json(t.meta as never)}, ${t.status ?? "ok"}, NULL, now())
    ON CONFLICT (provider) DO UPDATE SET
      account_id = EXCLUDED.account_id, account_name = EXCLUDED.account_name, scopes = EXCLUDED.scopes,
      access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
      expires_at = EXCLUDED.expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at, meta = EXCLUDED.meta,
      status = EXCLUDED.status, status_message = NULL, updated_at = now()`;
}

export async function markToken(provider: Provider, status: StoredToken["status"], message: string | null) {
  await sql()`UPDATE oauth_tokens SET status = ${status}, status_message = ${message}, updated_at = now() WHERE provider = ${provider}`;
}

export async function deleteToken(provider: Provider) {
  await sql()`DELETE FROM oauth_tokens WHERE provider = ${provider}`;
}
