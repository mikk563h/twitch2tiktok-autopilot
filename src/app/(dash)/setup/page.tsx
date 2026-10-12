import Link from "next/link";
import type { ReactNode } from "react";
import { getSettings, getState } from "@/lib/settings";
import { config } from "@/lib/config";
import { sql } from "@/lib/db";
import { tokenInfo } from "@/lib/tokens";
import { redis } from "@/lib/queue";
import { workerStatus, diskUsage } from "@/lib/pipeline/maintenance";
import { tiktokAccountState, TIKTOK_STATE_LABELS } from "@/lib/tiktok/state";
import { twitchRedirectUri } from "@/lib/twitch/oauth";
import { redirectUri as tiktokRedirectUri, TIKTOK_SCOPES } from "@/lib/tiktok/api";
import { TWITCH_DOWNLOAD_SCOPES } from "@/lib/twitch/api";
import { getClip } from "@/lib/clips";
import { DENIED_KEY } from "@/lib/twitch/download";
import { AutoRefresh, ActionForm, SubmitButton } from "@/components/client";
import { PageHeader, StatusBadge, ago, bytes, Notice, type Tone } from "@/components/ui";
import { testTwitch, testAi, testTikTok, testTwitchDownload, confirmRights, runTestClip, completeSetup, scanNow } from "../../actions";

function Step({ n, title, tone, status, children }: { n: number; title: string; tone: Tone; status: string; children: ReactNode }) {
  const ring: Record<Tone, string> = { ok: "border-ok bg-ok/15 text-ok", warn: "border-warn bg-warn/10 text-warn", bad: "border-bad bg-bad/10 text-bad", info: "border-info bg-info/10 text-info", muted: "border-border bg-surface-2 text-muted" };
  return (
    <li className="relative flex gap-4 pb-8 last:pb-0">
      <div className="absolute left-[17px] top-10 bottom-0 w-px bg-border last:hidden" />
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold ${ring[tone]}`}>{tone === "ok" ? "✓" : n}</div>
      <div className="card card-pad min-w-0 flex-1">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{title}</h3>
          <span className={`text-xs font-medium ${tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : "text-muted"}`}>{status}</span>
        </div>
        <div className="space-y-3 text-sm text-muted">{children}</div>
      </div>
    </li>
  );
}

const Code = ({ children }: { children: ReactNode }) => <code className="rounded bg-bg px-1.5 py-0.5 font-mono text-xs text-fg">{children}</code>;

export default async function SetupPage() {
  const s = await getSettings();
  let dbOk = false; let redisOk = false;
  try { await sql()`SELECT 1`; dbOk = true; } catch { /* */ }
  if (config.runMode === "workers") { try { redisOk = (await redis().ping()) === "PONG"; } catch { /* */ } } else redisOk = true;
  const [workers, disk, twitchUser, tiktokTok, tt, aiOk, twitchOk, twitchUserOk, tiktokOk, [clipCount], settingsRows] = await Promise.all([
    workerStatus(), config.runMode === "workers" ? diskUsage().catch(() => null) : Promise.resolve(null), tokenInfo("twitch_user"), tokenInfo("tiktok"), tiktokAccountState(),
    getState<string>("ai.lastOkAt"), getState<string>("twitch.apiOkAt"), getState<string>("twitch.userApiOkAt"), getState<string>("tiktok.lastOkAt"),
    sql()`SELECT count(*)::int AS n FROM clips`, sql()`SELECT key FROM settings`,
  ]);
  const notEditor = !!(await getState<{ at: string }>(DENIED_KEY));
  const saved = new Set(settingsRows.map((r) => r.key as string));
  const testClip = s.setup.testClipId ? await getClip(s.setup.testClipId) : null;
  const workersOk = workers.every((w) => w.alive);
  const scopes = (twitchUser?.scopes as string[] | undefined) ?? [];
  const hasEditorScope = scopes.some((x) => TWITCH_DOWNLOAD_SCOPES.includes(x));
  const busy = testClip && ["QUEUED", "DOWNLOADING", "DOWNLOADED", "ANALYZING", "EDITING", "UPLOADING", "PROCESSING"].includes(testClip.status);

  return (
    <>
      {busy && <AutoRefresh ms={3000} />}
      <PageHeader title="Setup Wizard" subtitle="Gennemgå trinene i rækkefølge. Et trin bliver kun grønt, når det faktisk er testet og virker." />
      {s.setup.completedAt && <div className="mb-6"><Notice tone="ok">Opsætningen blev gennemført {ago(s.setup.completedAt)}. Du kan altid vende tilbage hertil.</Notice></div>}
      <ol className="max-w-4xl">
        <Step n={1} title="Serverstatus" tone={dbOk && redisOk && workersOk ? "ok" : "bad"} status={dbOk && redisOk && workersOk ? "Alt kører" : "Problemer"}>
          <p>Database: {dbOk ? "✓" : "✗"}{config.runMode === "workers" && <> · Redis: {redisOk ? "✓" : "✗"}</>} · {config.runMode === "batch" ? "Autopilot" : "Workers"}: {workers.map((w) => `${w.worker} ${w.alive ? "✓" : "✗"}`).join(", ")}{disk && ` · Fri disk: ${bytes(disk.free)}`}</p>
          {!workersOk && (config.runMode === "batch"
            ? <p className="text-bad">Ingen kørsel for nylig. Autopiloten kører hvert 15. minut, når din computer er tændt og vågen. Clips, der kommer mens den er slukket, indhentes automatisk.</p>
            : <p className="text-bad">Start alle containere: <Code>docker compose up -d</Code> og tjek <Code>docker compose ps</Code>.</p>)}
        </Step>

        <Step n={2} title="Twitch Developer App" tone={twitchOk ? "ok" : config.twitchClientId ? "warn" : "bad"} status={twitchOk ? `API virker (${ago(twitchOk)})` : config.twitchClientId ? "Ikke testet" : "Mangler"}>
          <p>Opret en app på <a className="text-accent-2 underline" href="https://dev.twitch.tv/console/apps" target="_blank" rel="noreferrer">dev.twitch.tv/console/apps</a> → “Register Your Application”. Kategori: <i>Application Integration</i>. Client type: <i>Confidential</i>.</p>
          <p>OAuth Redirect URL: <Code>{twitchRedirectUri()}</Code></p>
          <p>Sæt <Code>TWITCH_CLIENT_ID</Code> og <Code>TWITCH_CLIENT_SECRET</Code> {config.runMode === "batch" ? "i både Vercel (Environment Variables) og ~/.t2t/t2t.env på din computer" : <>i <Code>.env</Code> og genstart (<Code>./scripts/deploy.sh</Code>)</>}.</p>
          {config.twitchClientId && <ActionForm action={testTwitch}><SubmitButton className="btn-ghost">Test Twitch API</SubmitButton></ActionForm>}
        </Step>

        <Step n={3} title="Twitch OAuth (valgfri)" tone={twitchUser ? (twitchUser.status === "ok" ? (notEditor ? "muted" : "ok") : "bad") : "muted"} status={twitchUser ? `Forbundet som ${twitchUser.account_name}` : "Ikke forbundet — offentlig download bruges"}>
          <p>Forbind den Twitch-konto, der er <b>broadcaster</b> (sondergaardlol selv) eller <b>editor</b> på kanalen. Så bruges Twitchs officielle download-API. Uden forbindelse hentes de offentlige clip-filer direkte.</p>
          <div className="flex gap-2"><a href="/api/oauth/twitch/start?role=editor" className="btn-ghost">Forbind som editor</a><a href="/api/oauth/twitch/start?role=broadcaster" className="btn-ghost">Forbind som broadcaster</a></div>
        </Step>

        <Step n={4} title="Twitch broadcaster/editor-rettigheder (valgfri)" tone={notEditor ? "muted" : twitchUserOk && hasEditorScope ? "ok" : twitchUser ? "warn" : "muted"} status={notEditor ? "Ikke editor — offentlig download bruges (virker fint)" : twitchUserOk && hasEditorScope ? "Officiel download bekræftet" : twitchUser ? "Ikke bekræftet" : "Springes over — offentlig download bruges"}>
          <p>Kræver scope <Code>editor:manage:clips</Code> (editor) eller <Code>channel:manage:clips</Code> (broadcaster), og at kontoen er editor på kanalen (sættes af kanalejeren under Creator Dashboard → Settings → Roles).</p>
          {twitchUser && <ActionForm action={testTwitchDownload}><SubmitButton className="btn-ghost">Test download-rettighed</SubmitButton></ActionForm>}
        </Step>

        <Step n={5} title="AI API-nøgle (Claude, valgfri)" tone={aiOk ? "ok" : config.anthropicApiKey ? "warn" : "muted"} status={aiOk ? `Virker (${ago(aiOk)})` : config.anthropicApiKey ? "Ikke testet" : "Slået fra — Twitch-titler bruges (gratis)"}>
          <p>Hent en nøgle på <a className="text-accent-2 underline" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a> og sæt <Code>ANTHROPIC_API_KEY</Code> i <Code>.env</Code>. Model: <Code>{config.aiModel}</Code>. Transskription kører lokalt med whisper.cpp — ingen ekstra nøgle.</p>
          {config.anthropicApiKey && <ActionForm action={testAi}><SubmitButton className="btn-ghost">Test AI</SubmitButton></ActionForm>}
        </Step>

        <Step n={6} title="TikTok Developer App" tone={config.tiktokClientKey ? "ok" : "bad"} status={config.tiktokClientKey ? "Nøgler sat" : "Mangler"}>
          <p>Opret en app på <a className="text-accent-2 underline" href="https://developers.tiktok.com/apps" target="_blank" rel="noreferrer">developers.tiktok.com</a>. Tilføj produkterne <b>Login Kit</b> og <b>Content Posting API</b> (slå <i>Direct Post</i> til). Scopes: <Code>{TIKTOK_SCOPES.join(", ")}</Code>.</p>
          <p>Redirect URI (Login Kit → Web): <Code>{tiktokRedirectUri()}</Code>. Domænet skal verificeres i portalen.</p>
          <p>Sæt <Code>TIKTOK_CLIENT_KEY</Code> og <Code>TIKTOK_CLIENT_SECRET</Code> i <Code>.env</Code>. Mens appen er i sandbox, skal din TikTok-konto tilføjes som <i>target user</i>.</p>
        </Step>

        <Step n={7} title="TikTok OAuth" tone={tiktokOk && tiktokTok?.status === "ok" ? "ok" : tiktokTok ? "warn" : "bad"} status={tiktokOk && tiktokTok ? `Forbundet: ${tiktokTok.account_name ?? ""}` : tiktokTok ? "Forbundet, ikke testet" : "Ikke forbundet"}>
          <div className="flex gap-2"><a href="/api/oauth/tiktok/start" className="btn-ghost">Forbind TikTok</a>{tiktokTok && <ActionForm action={testTikTok}><SubmitButton className="btn-ghost">Test (creator info)</SubmitButton></ActionForm>}</div>
        </Step>

        <Step n={8} title="TikTok Direct Post-godkendelse" tone={tt.state === "PUBLIC_APPROVED" ? "ok" : tt.state === "PRIVATE_ONLY" ? "warn" : "bad"} status={TIKTOK_STATE_LABELS[tt.state]}>
          <p>{tt.detail}</p>
          <p>Ikke-auditerede apps kan kun poste <b>privat (SELF_ONLY)</b>. Offentlig auto-publicering kræver, at TikTok auditerer appen (ansøg i Developer Portal → App review). TikTok vurderer selv, om en integration, der genudgiver indhold, kan godkendes — systemet omgår det ikke.</p>
        </Step>

        <Step n={9} title="Publiceringsindstillinger" tone={s.tiktok.consentAt && (s.tiktok.privacyLevel || s.tiktok.mode !== "direct") ? "ok" : "warn"} status={s.tiktok.consentAt ? `${s.tiktok.mode} · ${s.tiktok.privacyLevel ?? "—"}` : "Ikke valgt"}>
          <p>Vælg tilstand, synlighed (ingen standard), interaktioner, indholdsoplysning, og giv samtykke under <Link className="text-accent-2 underline" href="/accounts">Accounts</Link>.</p>
        </Step>

        <Step n={10} title="Faste hashtags" tone={saved.has("hashtags") ? "ok" : "muted"} status={s.hashtags.fixed.map((t) => `#${t}`).join(" ") || "ingen"}>
          <p>Ret dem i <Link className="text-accent-2 underline" href="/hashtags">Hashtag Manager</Link> og tryk Gem for at bekræfte.</p>
        </Step>

        <Step n={11} title="Videoeditor" tone={saved.has("editor") ? "ok" : "muted"} status={saved.has("editor") ? `Layout: ${s.editor.layout}` : "Standard (ikke gemt)"}>
          <p>Gennemgå layout, undertekster og lyd i <Link className="text-accent-2 underline" href="/editor">Video Editor</Link>.</p>
        </Step>

        <Step n={12} title="Testclip" tone={testClip && ["READY", "PUBLISHED", "NEEDS_USER_ACTION"].includes(testClip.status) ? "ok" : testClip?.status === "FAILED" ? "bad" : testClip ? "info" : "muted"} status={testClip ? `#${testClip.id}` : "Ikke kørt"}>
          <p>{clipCount.n} clips registreret. {clipCount.n === 0 && "Kør en scanning først (kræver Twitch-nøgler)."}</p>
          <div className="flex flex-wrap gap-2">
            <ActionForm action={scanNow}><SubmitButton className="btn-ghost">Scan Twitch nu</SubmitButton></ActionForm>
            <ActionForm action={runTestClip}><SubmitButton className="btn-ghost" pendingText="Starter…">Kør testclip (download → AI → render)</SubmitButton></ActionForm>
          </div>
          {testClip && (
            <div className="flex items-center gap-3 rounded-lg border border-border p-3">
              <StatusBadge status={testClip.status} />
              <span className="flex-1 truncate text-fg">{testClip.final_title ?? testClip.twitch_title}</span>
              <Link className="text-accent-2 underline" href={`/clips/${testClip.id}`}>Åbn</Link>
            </div>
          )}
          {testClip?.last_error && <p className="text-bad">{testClip.last_error}</p>}
        </Step>

        <Step n={13} title="Rettigheder og aktivering" tone={s.setup.rightsConfirmedAt && s.setup.completedAt ? "ok" : "warn"} status={s.setup.completedAt ? "Aktiveret" : "Afventer"}>
          {s.setup.rightsConfirmedAt ? (
            <p className="text-ok">Rettigheder bekræftet af {s.setup.rightsConfirmedBy} {ago(s.setup.rightsConfirmedAt)}.</p>
          ) : (
            <ActionForm action={confirmRights} className="space-y-3">
              <label className="flex items-start gap-2 text-fg"><input type="checkbox" name="confirm" className="mt-1 accent-[#8b5cf6]" />
                <span>Jeg bekræfter, at jeg er autoriseret af rettighedshaveren til at hente clips fra Twitch-kanalen <b>{config.twitchChannel}</b> og genudgive dem på den forbundne TikTok-konto, og at indholdet overholder TikToks retningslinjer.</span></label>
              <input name="name" placeholder="Dit fulde navn" className="input max-w-xs" />
              <SubmitButton className="btn-ghost">Bekræft rettigheder</SubmitButton>
            </ActionForm>
          )}
          <ActionForm action={completeSetup} className="space-y-3">
            <label className="flex items-center gap-2 text-fg"><input type="checkbox" name="enableMonitor" defaultChecked className="accent-[#8b5cf6]" /> Slå automatisk overvågning og redigering til</label>
            <p>Automatisk publicering slås til separat under <Link className="text-accent-2 underline" href="/automation">Automation</Link>, når TikTok-trinene er grønne.</p>
            <SubmitButton>Afslut opsætning</SubmitButton>
          </ActionForm>
        </Step>
      </ol>
    </>
  );
}
