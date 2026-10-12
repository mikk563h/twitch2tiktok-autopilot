import Link from "next/link";
import { notFound } from "next/navigation";
import { clipDetail } from "@/lib/dashboard";
import { getSettings } from "@/lib/settings";
import { captionFor } from "@/lib/pipeline/upload";
import type { StoredAnalysis, RenderOverrides } from "@/lib/pipeline/process";
import type { Transcript } from "@/lib/media/whisper";
import { AutoRefresh, ActionForm, SubmitButton, RangeField, FacecamPicker, CopyText } from "@/components/client";
import { Card, PageHeader, StatusBadge, ago, dt, Notice } from "@/components/ui";
import { rerenderClip, retryClip, uploadNow, resolveAction, queueClip } from "../../../actions";

export default async function ClipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await clipDetail(Number(id));
  if (!data) notFound();
  const { clip, events, attempts } = data;
  const settings = await getSettings();
  const analysis = clip.analysis as unknown as StoredAnalysis | null;
  const transcript = clip.transcript as unknown as Transcript | null;
  const ov = (clip.render_overrides ?? {}) as RenderOverrides;
  const plan = (clip.render_info as { plan?: { layout?: string; focusX?: number; blurZoom?: number; foregroundY?: number; facecam?: { x: number; y: number; w: number; h: number } | null } } | null)?.plan;
  const caption = clip.final_title ? captionFor(clip, settings) : null;
  const busy = ["DOWNLOADING", "ANALYZING", "EDITING", "UPLOADING", "PROCESSING"].includes(clip.status);
  const sentToTikTok = ["UPLOADING", "PROCESSING", "PUBLISHED"].includes(clip.status);

  return (
    <>
      {busy && <AutoRefresh ms={3000} />}
      <PageHeader
        title={clip.final_title ?? clip.twitch_title ?? `Clip #${clip.id}`}
        subtitle={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={clip.status} /> <span>#{clip.id} · {clip.game_name ?? "ukendt spil"} · oprettet {dt(clip.twitch_created_at)} af {clip.creator_name ?? "?"}</span></span>}
        actions={<Link href="/clips" className="btn-ghost">← Tilbage</Link>}
      />

      {clip.status_reason && clip.status !== "PUBLISHED" && <div className="mb-4"><Notice tone={["FAILED", "BLOCKED_PERMISSION"].includes(clip.status) ? "bad" : "warn"}>{clip.status_reason}</Notice></div>}

      <div className="mb-6 flex flex-wrap gap-2">
        {clip.status === "BASELINE" && <ActionForm action={queueClip}><input type="hidden" name="id" value={clip.id} /><SubmitButton>Behandl dette clip</SubmitButton></ActionForm>}
        {["FAILED", "RETRY_WAIT", "BLOCKED_PERMISSION"].includes(clip.status) || (clip.status === "NEEDS_USER_ACTION" && !clip.tiktok_publish_id) ? (
          <ActionForm action={retryClip}><input type="hidden" name="id" value={clip.id} /><SubmitButton>Prøv igen</SubmitButton></ActionForm>
        ) : null}
        {clip.status === "READY" && <ActionForm action={uploadNow}><input type="hidden" name="id" value={clip.id} /><SubmitButton confirm="Upload dette clip til TikTok nu?">Upload til TikTok nu</SubmitButton></ActionForm>}
        {clip.status === "NEEDS_USER_ACTION" && clip.tiktok_publish_id && (
          <>
            <ActionForm action={resolveAction} className="flex gap-2"><input type="hidden" name="id" value={clip.id} /><input type="hidden" name="outcome" value="published" /><input name="url" placeholder="TikTok-link (valgfrit)" className="input w-56" /><SubmitButton>Er publiceret</SubmitButton></ActionForm>
            <ActionForm action={resolveAction}><input type="hidden" name="id" value={clip.id} /><input type="hidden" name="outcome" value="not_published" /><SubmitButton className="btn-ghost" confirm="Bekræft at videoen IKKE findes på TikTok. Den uploades så igen.">Ikke publiceret — upload igen</SubmitButton></ActionForm>
          </>
        )}
        {clip.render_path && <a className="btn-ghost" href={`/api/media/${clip.id}/render?download=1`}>Download redigeret MP4</a>}
        {clip.tiktok_url && <a className="btn-ghost text-ok" href={clip.tiktok_url} target="_blank" rel="noreferrer">Åbn på TikTok ↗</a>}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <div className="grid gap-6 md:grid-cols-[1fr_260px]">
            <Card title="Original">
              {clip.source_path ? <video src={`/api/media/${clip.id}/source`} controls preload="metadata" className="aspect-video w-full rounded-lg" />
                : clip.embed_url ? <iframe src={`${clip.embed_url}&parent=${new URL(process.env.APP_URL ?? "http://localhost").hostname}`} className="aspect-video w-full rounded-lg" allowFullScreen />
                : <div className="aspect-video rounded-lg bg-surface-2" />}
            </Card>
            <Card title="TikTok-version">
              {clip.render_path ? <video src={`/api/media/${clip.id}/render`} controls preload="metadata" className="aspect-[9/16] w-full rounded-lg" />
                : <div className="flex aspect-[9/16] items-center justify-center rounded-lg bg-surface-2 p-4 text-center text-xs text-faint">{busy ? "Arbejder…" : process.env.REDIS_URL ? "Ikke renderet endnu" : clip.render_info ? "Gratis-mode: videofiler gemmes ikke mellem kørsler. Videoen genskabes automatisk ved upload." : "Ikke renderet endnu"}</div>}
            </Card>
          </div>

          <Card title="Titel & beskrivelse">
            <dl className="grid gap-3 text-sm sm:grid-cols-[160px_1fr]">
              <dt className="text-muted">Brugt titel</dt><dd className="font-medium">{clip.final_title ?? "—"} {clip.title_source && <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] uppercase text-muted">{clip.title_source}</span>}</dd>
              <dt className="text-muted">AI-titel</dt><dd>{clip.ai_title ?? "—"}</dd>
              <dt className="text-muted">Twitch-titel</dt><dd>{clip.twitch_title || "—"}</dd>
              {analysis?.title && <><dt className="text-muted">Beslutning</dt><dd className="text-muted">{analysis.title.reason}</dd></>}
              {analysis?.title?.candidates?.length ? <><dt className="text-muted">Forslag</dt><dd className="space-y-1">{analysis.title.candidates.map((c, i) => <div key={i} className={c.ok ? "text-ok" : "text-muted"}>{c.ok ? "✓" : "✗"} {c.title}{c.reason ? <span className="text-faint"> — {c.reason}</span> : null}</div>)}</dd></> : null}
            </dl>
            {caption && (
              <div className="mt-4">
                <div className="mb-1.5 flex items-center justify-between"><span className="label mb-0">Caption der sendes til TikTok</span><CopyText text={caption} /></div>
                <pre className="whitespace-pre-wrap rounded-lg border border-border bg-bg p-3 font-sans text-sm">{caption}</pre>
                <p className="hint">{caption.length} / {settings.hashtags.captionMaxLength} tegn</p>
              </div>
            )}
          </Card>

          {analysis && (
            <Card title="AI-analyse">
              {analysis.ai ? (
                <div className="space-y-3 text-sm">
                  <p><span className="text-muted">Hvad sker der: </span>{analysis.ai.observations}</p>
                  {analysis.ai.spoken_summary && <p><span className="text-muted">Tale: </span>{analysis.ai.spoken_summary}</p>}
                  <p className="text-xs text-muted">Confidence {analysis.ai.confidence.toFixed(2)} · forstået: {analysis.ai.understood ? "ja" : "nej"} · sjovt: {analysis.ai.is_funny ? "ja" : "nej"} · facecam: {analysis.ai.facecam.present ? `ja (${analysis.ai.facecam.confidence.toFixed(2)})` : "nej"} · AI-hashtags: {analysis.ai.hashtags.map((h) => `#${h}`).join(" ") || "—"} · model {analysis.aiModel}</p>
                </div>
              ) : <Notice tone="warn">AI-analyse ikke tilgængelig: {analysis.aiError ?? "slået fra"}</Notice>}
              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-accent-2">Transskription ({transcript?.language ?? "—"}, {transcript?.words.length ?? 0} ord)</summary>
                <p className="mt-2 text-sm text-muted">{transcript?.text || analysis.transcriptError || "(ingen tale)"}</p>
              </details>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card title="Editor">
            {sentToTikTok ? <Notice tone="muted">Clippet er sendt til TikTok og kan ikke længere ændres.</Notice> : (
              <ActionForm action={rerenderClip} className="space-y-4">
                <input type="hidden" name="id" value={clip.id} />
                <div>
                  <label className="label">Titel (tom = automatisk)</label>
                  <input name="manualTitle" defaultValue={clip.manual_title ?? ""} placeholder={clip.final_title ?? ""} maxLength={settings.ai.titleMaxLength} className="input" />
                </div>
                <div>
                  <label className="label">Layout</label>
                  <select name="layout" defaultValue={ov.layout ?? "auto"} className="input">
                    <option value="auto">Automatisk ({plan?.layout ?? settings.editor.layout})</option>
                    <option value="blur">Gameplay med sløret baggrund</option>
                    <option value="crop">Smart crop (fuld skærm)</option>
                    <option value="split">Split: facecam + gameplay</option>
                  </select>
                </div>
                <RangeField name="focusX" label="Vandret fokus" min={0} max={1} step={0.01} defaultValue={ov.focusX ?? plan?.focusX ?? 0.5} format="pct" hint="Hvor i billedet handlingen er (bruges ved crop/zoom)" />
                <RangeField name="blurZoom" label="Zoom (sløret layout)" min={1} max={2} step={0.05} defaultValue={ov.blurZoom ?? settings.editor.blurZoom} format="x" />
                <RangeField name="foregroundY" label="Lodret placering" min={0} max={1} step={0.01} defaultValue={ov.foregroundY ?? settings.editor.foregroundY} format="pct" />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="subtitles" defaultChecked={ov.subtitles ?? settings.editor.subtitles.enabled} className="accent-[#8b5cf6]" /> Undertekster</label>
                <div>
                  <div className="label">Facecam (split-layout)</div>
                  <FacecamPicker image={clip.thumbnail_url} initial={ov.facecamRect ?? plan?.facecam ?? settings.editor.facecamRect} enabledName="useFacecam" enabledDefault={!!ov.facecamRect} />
                </div>
                <SubmitButton pendingText="Sætter i kø…">Genrender med disse indstillinger</SubmitButton>
              </ActionForm>
            )}
          </Card>

          <Card title="Upload-forsøg">
            {attempts.length === 0 ? <p className="text-sm text-muted">Ingen endnu.</p> : (
              <ul className="space-y-3 text-xs">
                {attempts.map((a) => (
                  <li key={String(a.id)} className="rounded-lg border border-border p-3">
                    <div className="flex justify-between"><span className="font-mono">{String(a.idempotency_key)}</span><span className="font-semibold">{String(a.state)}</span></div>
                    <div className="mt-1 text-muted">publish_id: {String(a.publish_id ?? "—")} · {String(a.mode)} {a.privacy_level ? `· ${a.privacy_level}` : ""}</div>
                    <div className="text-muted">TikTok: {String(a.tiktok_status ?? "—")} {a.fail_reason ? `· ${a.fail_reason}` : ""} · {dt(a.created_at as Date)}</div>
                    {a.error ? <div className="mt-1 text-bad">{String(a.error)}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Historik">
            <ol className="max-h-[520px] space-y-2.5 overflow-y-auto text-xs">
              {events.map((e) => (
                <li key={String(e.id)} className="flex gap-2">
                  <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${e.level === "error" ? "bg-bad" : e.level === "warn" ? "bg-warn" : "bg-accent"}`} />
                  <div><div className={e.level === "error" ? "text-bad" : e.level === "warn" ? "text-warn" : ""}>{String(e.message)}</div><div className="text-faint">{ago(e.created_at as Date)}</div></div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
