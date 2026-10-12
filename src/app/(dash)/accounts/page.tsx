/* eslint-disable @next/next/no-img-element */
import { getSettings } from "@/lib/settings";
import { config } from "@/lib/config";
import { tokenInfo } from "@/lib/tokens";
import { tiktokAccountState, TIKTOK_STATE_LABELS } from "@/lib/tiktok/state";
import { creatorInfo, TIKTOK_SCOPES, redirectUri as tiktokRedirect, type CreatorInfo } from "@/lib/tiktok/api";
import { twitchRedirectUri } from "@/lib/twitch/oauth";
import { TWITCH_DOWNLOAD_SCOPES } from "@/lib/twitch/api";
import { errMsg } from "@/lib/log";
import { ActionForm, SubmitButton } from "@/components/client";
import { Card, PageHeader, StatusLine, Notice, dt, type Tone } from "@/components/ui";
import { disconnect, saveTikTokSettings, testTikTok, testTwitch, testAi, testTwitchDownload } from "../../actions";

const PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Alle (offentlig)",
  MUTUAL_FOLLOW_FRIENDS: "Venner (gensidige følgere)",
  FOLLOWER_OF_CREATOR: "Følgere",
  SELF_ONLY: "Kun mig (privat)",
};

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const s = await getSettings();
  const [twitchUser, tiktokTok, tt] = await Promise.all([tokenInfo("twitch_user"), tokenInfo("tiktok"), tiktokAccountState()]);
  let ci: CreatorInfo | null = null;
  let ciError: string | null = null;
  if (tiktokTok && tiktokTok.status === "ok") {
    try { ci = await creatorInfo(); } catch (err) { ciError = errMsg(err); }
  }
  const twitchScopes = (twitchUser?.scopes as string[] | undefined) ?? [];
  const hasDownloadScope = twitchScopes.some((x) => TWITCH_DOWNLOAD_SCOPES.includes(x));
  const ttTone: Tone = tt.state === "PUBLIC_APPROVED" ? "ok" : ["PRIVATE_ONLY", "RATE_LIMITED"].includes(tt.state) ? "warn" : "bad";
  const privacyOptions = ci?.privacy_level_options ?? Object.keys(PRIVACY_LABELS);
  const missing: string[] = [];
  if (!config.twitchClientId) missing.push("Twitch Developer App (TWITCH_CLIENT_ID/SECRET i .env)");
  if (!config.anthropicApiKey) missing.push("Anthropic API-nøgle (ANTHROPIC_API_KEY) — uden den bruges Twitch-titler");
  if (!config.tiktokClientKey) missing.push("TikTok Developer App (TIKTOK_CLIENT_KEY/SECRET i .env)");
  if (!tiktokTok) missing.push("TikTok-konto forbundet via OAuth");
  if (tt.state === "CONNECTED_NO_DIRECT_POST") missing.push("Content Posting API / Direct Post-scope i TikTok-appen");
  if (tt.state !== "PUBLIC_APPROVED" && s.tiktok.mode === "direct") missing.push("TikTok audit af appen (kræves for offentlige posts)");
  if (!s.tiktok.consentAt) missing.push("Dit samtykke til automatisk publicering");
  if (!s.setup.rightsConfirmedAt) missing.push("Rettighedsbekræftelse (Setup Wizard)");

  return (
    <>
      <PageHeader title="Account Settings" subtitle="Forbindelser, API-status og publiceringsindstillinger" />
      {sp.ok && <div className="mb-4"><Notice tone="ok">{sp.ok === "tiktok" ? "TikTok er forbundet." : "Twitch er forbundet."}</Notice></div>}
      {sp.error && <div className="mb-4"><Notice tone="bad">Fejl: {sp.error}</Notice></div>}
      {missing.length > 0 && (
        <div className="mb-6"><Notice tone="warn"><b>Manglende godkendelser:</b><ul className="mt-1 list-disc pl-5">{missing.map((m) => <li key={m}>{m}</li>)}</ul></Notice></div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Twitch">
          <div className="space-y-4">
            <StatusLine tone={config.twitchClientId ? "ok" : "bad"} title={config.twitchClientId ? "Developer App konfigureret" : "Developer App mangler"} detail={`Kanal: ${config.twitchChannel} · Redirect URL: ${twitchRedirectUri()}`} />
            <StatusLine
              tone={twitchUser ? (twitchUser.status === "ok" && hasDownloadScope ? "ok" : "warn") : "muted"}
              title={twitchUser ? `Forbundet som ${twitchUser.account_name}` : "Ingen editor/broadcaster-konto (valgfri)"}
              detail={twitchUser ? `Scopes: ${twitchScopes.join(", ") || "ingen"}${twitchUser.status !== "ok" ? ` · ${twitchUser.status_message}` : ""}` : "Uden konto hentes offentlige clips direkte. Med en editor- eller broadcaster-konto bruges Twitchs officielle Get Clips Download API."} />
            <div className="flex flex-wrap gap-2">
              <a className="btn-primary" href="/api/oauth/twitch/start?role=editor">Forbind som editor</a>
              <a className="btn-ghost" href="/api/oauth/twitch/start?role=broadcaster">Forbind som broadcaster</a>
              {twitchUser && <ActionForm action={disconnect}><input type="hidden" name="provider" value="twitch_user" /><SubmitButton className="btn-danger" confirm="Fjern Twitch-forbindelsen?">Afbryd</SubmitButton></ActionForm>}
            </div>
            <div className="flex flex-wrap gap-2">
              <ActionForm action={testTwitch}><SubmitButton className="btn-ghost text-xs">Test Twitch API</SubmitButton></ActionForm>
              {twitchUser && <ActionForm action={testTwitchDownload}><SubmitButton className="btn-ghost text-xs">Test officiel download</SubmitButton></ActionForm>}
            </div>
          </div>
        </Card>

        <Card title="AI (Claude)">
          <div className="space-y-4">
            <StatusLine tone={config.anthropicApiKey ? "ok" : "bad"} title={config.anthropicApiKey ? "API-nøgle sat" : "ANTHROPIC_API_KEY mangler"} detail={`Model: ${config.aiModel} · Transskription: lokal whisper.cpp (${config.whisperModel})`} />
            <ActionForm action={testAi}><SubmitButton className="btn-ghost text-xs">Test AI-forbindelse</SubmitButton></ActionForm>
          </div>
        </Card>

        <Card title="TikTok" className="lg:col-span-2">
          <div className="grid gap-6 md:grid-cols-[1fr_1.4fr]">
            <div className="space-y-4">
              <StatusLine tone={ttTone} title={TIKTOK_STATE_LABELS[tt.state]} detail={tt.detail} />
              {ci && (
                <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                  {ci.creator_avatar_url && <img src={ci.creator_avatar_url} alt="" className="h-10 w-10 rounded-full" />}
                  <div><div className="text-sm font-medium">{ci.creator_nickname}</div><div className="text-xs text-muted">@{ci.creator_username} · maks {ci.max_video_post_duration_sec}s video</div></div>
                </div>
              )}
              {ciError && <Notice tone="bad">Creator info: {ciError}</Notice>}
              {tiktokTok && <p className="text-xs text-muted">Scopes: {(tiktokTok.scopes as string[]).join(", ")} · token fornyes automatisk · refresh-token udløber {dt(tiktokTok.refresh_expires_at as Date)}</p>}
              <div className="flex flex-wrap gap-2">
                <a className="btn-primary" href="/api/oauth/tiktok/start">{tiktokTok ? "Forbind igen" : "Forbind TikTok"}</a>
                {tiktokTok && <ActionForm action={testTikTok}><SubmitButton className="btn-ghost">Test</SubmitButton></ActionForm>}
                {tiktokTok && <ActionForm action={disconnect}><input type="hidden" name="provider" value="tiktok" /><SubmitButton className="btn-danger" confirm="Fjern TikTok-forbindelsen?">Afbryd</SubmitButton></ActionForm>}
              </div>
              <p className="text-xs text-faint">Redirect URI til TikTok Developer Portal: <code className="font-mono">{tiktokRedirect()}</code><br />Scopes der anmodes om: {TIKTOK_SCOPES.join(", ")}</p>
            </div>

            <ActionForm action={saveTikTokSettings} className="space-y-4">
              <h3 className="text-sm font-semibold">Publiceringsindstillinger</h3>
              <div>
                <label className="label">Tilstand</label>
                <select name="mode" defaultValue={s.tiktok.mode} className="input">
                  <option value="direct">Direct Post (publicér direkte)</option>
                  <option value="inbox">Upload som udkast til TikTok-indbakken</option>
                  <option value="manual">Manuel (kun klargør videoer)</option>
                </select>
              </div>
              <div>
                <label className="label">Hvem kan se videoerne?</label>
                <select name="privacyLevel" defaultValue={s.tiktok.privacyLevel ?? ""} className="input" required={false}>
                  <option value="" disabled>— Vælg synlighed —</option>
                  {privacyOptions.map((p) => <option key={p} value={p}>{PRIVACY_LABELS[p] ?? p}</option>)}
                </select>
                <p className="hint">{ci ? "Mulighederne kommer direkte fra din TikTok-konto." : "Forbind TikTok for at se kontoens tilladte muligheder."} Ikke-auditerede apps kan kun poste “Kun mig”.</p>
              </div>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className={`flex items-center gap-2 ${ci?.comment_disabled ? "opacity-50" : ""}`}><input type="checkbox" name="allowComment" defaultChecked={s.tiktok.allowComment} disabled={ci?.comment_disabled} className="accent-[#8b5cf6]" /> Tillad kommentarer</label>
                <label className={`flex items-center gap-2 ${ci?.duet_disabled ? "opacity-50" : ""}`}><input type="checkbox" name="allowDuet" defaultChecked={s.tiktok.allowDuet} disabled={ci?.duet_disabled} className="accent-[#8b5cf6]" /> Tillad Duet</label>
                <label className={`flex items-center gap-2 ${ci?.stitch_disabled ? "opacity-50" : ""}`}><input type="checkbox" name="allowStitch" defaultChecked={s.tiktok.allowStitch} disabled={ci?.stitch_disabled} className="accent-[#8b5cf6]" /> Tillad Stitch</label>
              </div>
              <fieldset className="space-y-2 rounded-lg border border-border p-3 text-sm">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Indholdsoplysning</legend>
                <label className="flex items-center gap-2"><input type="checkbox" name="brandOrganic" defaultChecked={s.tiktok.brandOrganic} className="accent-[#8b5cf6]" /> Promoverer dit eget brand (“Promotional content”)</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="brandContent" defaultChecked={s.tiktok.brandContent} className="accent-[#8b5cf6]" /> Betalt partnerskab (“Paid partnership”)</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="isAigc" defaultChecked={s.tiktok.isAigc} className="accent-[#8b5cf6]" /> Markér som AI-genereret indhold</label>
              </fieldset>
              <fieldset className="space-y-2 rounded-lg border border-accent/30 bg-accent-soft p-3 text-sm">
                <label className="flex items-start gap-2"><input type="checkbox" name="musicConfirmation" defaultChecked={!!s.tiktok.musicConfirmationAt} className="mt-0.5 accent-[#8b5cf6]" /> <span>By posting, you agree to TikTok&apos;s <a className="text-accent-2 underline" href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a>.</span></label>
                <label className="flex items-start gap-2"><input type="checkbox" name="consent" defaultChecked={!!s.tiktok.consentAt} className="mt-0.5 accent-[#8b5cf6]" /> <span>Jeg giver udtrykkeligt samtykke til, at hvert nyt færdigredigeret clip automatisk uploades til TikTok-kontoen {ci ? <b>{ci.creator_nickname}</b> : "ovenfor"} med disse indstillinger. Titel kan ændres pr. clip før upload i dashboardet. Det kan tage nogle minutter, før en video vises på profilen.</span></label>
                {s.tiktok.consentAt && <p className="text-xs text-muted">Samtykke givet {dt(s.tiktok.consentAt)}</p>}
              </fieldset>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="appAudited" defaultChecked={s.tiktok.appAudited} className="mt-0.5 accent-[#8b5cf6]" /> <span>TikTok har godkendt (auditeret) min app til offentlige Direct Posts<br /><span className="text-xs text-muted">Systemet markerer først offentlig publicering som godkendt, når en offentlig post faktisk er verificeret.</span></span></label>
              <SubmitButton>Gem publiceringsindstillinger</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
