import { getSettings, getState, setState } from "../settings";
import { loadToken } from "../tokens";
import { config } from "../config";

/**
 * The six account states the dashboard distinguishes. Derived only from real signals
 * (stored token, scopes, TikTok error codes seen, verified posts) — never optimistic.
 */
export type TikTokAccountState =
  | "NOT_CONNECTED"
  | "CONNECTED_NO_DIRECT_POST"
  | "PRIVATE_ONLY"
  | "PUBLIC_APPROVED"
  | "RATE_LIMITED"
  | "OWNER_ACTION_REQUIRED";

export const TIKTOK_STATE_LABELS: Record<TikTokAccountState, string> = {
  NOT_CONNECTED: "Ikke forbundet",
  CONNECTED_NO_DIRECT_POST: "Forbundet, men uden Direct Post-godkendelse",
  PRIVATE_ONLY: "Privat testupload muligt (SELF_ONLY)",
  PUBLIC_APPROVED: "Offentlig automatisk publicering godkendt",
  RATE_LIMITED: "Midlertidigt blokeret af rate limit",
  OWNER_ACTION_REQUIRED: "Kræver handling fra kontoejeren",
};

export interface TikTokRuntimeState {
  /** Set when TikTok returned unaudited_client_can_only_post_to_private_accounts. */
  unauditedSeenAt?: string;
  /** First verified PUBLISH_COMPLETE with a public privacy level. */
  publicVerifiedAt?: string;
  lastPrivatePostAt?: string;
  blockedUntil?: string;
  blockedReason?: string;
  ownerActionReason?: string;
  ownerActionAt?: string;
}

const KEY = "tiktok.runtime";

export async function getTikTokRuntime(): Promise<TikTokRuntimeState> {
  return (await getState<TikTokRuntimeState>(KEY)) ?? {};
}

export async function patchTikTokRuntime(patch: Partial<TikTokRuntimeState>) {
  const cur = await getTikTokRuntime();
  const next = { ...cur, ...patch };
  for (const k of Object.keys(next) as Array<keyof TikTokRuntimeState>) if (next[k] === undefined) delete next[k];
  await setState(KEY, next);
}

export async function tiktokAccountState(): Promise<{ state: TikTokAccountState; detail: string; runtime: TikTokRuntimeState }> {
  const runtime = await getTikTokRuntime();
  if (!config.tiktokClientKey || !config.tiktokClientSecret) return { state: "NOT_CONNECTED", detail: "TikTok Developer App-nøgler mangler i .env", runtime };
  const token = await loadToken("tiktok").catch(() => null);
  if (!token) return { state: "NOT_CONNECTED", detail: "Ingen TikTok-konto forbundet", runtime };
  if (token.status !== "ok") return { state: "OWNER_ACTION_REQUIRED", detail: token.statusMessage ?? "Forbind TikTok igen", runtime };
  if (token.refreshExpiresAt && token.refreshExpiresAt.getTime() < Date.now()) return { state: "OWNER_ACTION_REQUIRED", detail: "Refresh-token er udløbet — forbind TikTok igen", runtime };
  if (runtime.ownerActionReason) return { state: "OWNER_ACTION_REQUIRED", detail: runtime.ownerActionReason, runtime };
  if (runtime.blockedUntil && Date.parse(runtime.blockedUntil) > Date.now()) {
    return { state: "RATE_LIMITED", detail: `${runtime.blockedReason ?? "Rate limit"} — prøver igen ${new Date(runtime.blockedUntil).toLocaleString("da-DK")}`, runtime };
  }
  const settings = await getSettings();
  const needed = settings.tiktok.mode === "inbox" ? "video.upload" : "video.publish";
  if (!token.scopes.includes(needed)) return { state: "CONNECTED_NO_DIRECT_POST", detail: `Tokenet mangler scope ${needed}. Tilføj produktet i TikTok Developer Portal og forbind igen.`, runtime };
  if (settings.tiktok.mode === "inbox") return { state: "PRIVATE_ONLY", detail: "Inbox-tilstand: videoer lander som udkast i TikTok-appen", runtime };
  if (runtime.publicVerifiedAt) return { state: "PUBLIC_APPROVED", detail: `Offentlig post verificeret ${new Date(runtime.publicVerifiedAt).toLocaleString("da-DK")}`, runtime };
  if (runtime.unauditedSeenAt || !settings.tiktok.appAudited) {
    return { state: "PRIVATE_ONLY", detail: runtime.unauditedSeenAt ? "TikTok meldte: ikke-auditeret app — kun SELF_ONLY tilladt" : "Appen er ikke markeret som auditeret — kun private posts indtil TikTok godkender den", runtime };
  }
  return { state: "PRIVATE_ONLY", detail: "Appen er markeret som auditeret, men ingen offentlig post er verificeret endnu", runtime };
}
