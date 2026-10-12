import Link from "next/link";
import { getSettings } from "@/lib/settings";
import { sql } from "@/lib/db";
import { ActionForm, SubmitButton, RangeField, FacecamPicker } from "@/components/client";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { ClipThumb } from "@/components/clip-thumb";
import type { Clip } from "@/lib/clips";
import { saveEditor, saveAi } from "../../actions";

export default async function EditorPage() {
  const s = await getSettings();
  const e = s.editor;
  const recent = (await sql()`SELECT id, final_title, twitch_title, status, render_thumb_path, thumbnail_url FROM clips WHERE status NOT IN ('BASELINE') ORDER BY updated_at DESC LIMIT 6`) as unknown as Clip[];
  const sampleThumb = recent.find((c) => c.thumbnail_url)?.thumbnail_url ?? null;
  return (
    <>
      <PageHeader title="Video Editor" subtitle="Standardindstillinger for alle nye renders. Det enkelte clip kan justeres og genrenderes fra dets egen side." />
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card title="Layout & billede">
            <ActionForm action={saveEditor} className="space-y-6">
              <div className="grid gap-4 md:grid-cols-3">
                {([
                  ["auto", "Automatisk", "Split hvis facecam findes pålideligt, ellers sløret baggrund"],
                  ["blur", "Sløret baggrund", "Hele gameplayet bevares — sikreste valg"],
                  ["crop", "Smart crop", "Fuld skærm, fokus på handlingen (beskærer siderne)"],
                  ["split", "Split facecam", "Webcam øverst, gameplay nederst"],
                ] as const).map(([v, t, d]) => (
                  <label key={v} className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                    <input type="radio" name="layout" value={v} defaultChecked={e.layout === v} className="mt-1 accent-[#8b5cf6]" />
                    <span><span className="text-sm font-medium">{t}</span><br /><span className="text-xs text-muted">{d}</span></span>
                  </label>
                ))}
              </div>
              <div className="grid gap-5 md:grid-cols-3">
                <RangeField name="blurZoom" label="Zoom (sløret)" min={1} max={2} step={0.05} defaultValue={e.blurZoom} format="x" hint="1.0 = hele billedet; højere = større men beskåret" />
                <RangeField name="foregroundY" label="Lodret placering" min={0} max={1} step={0.01} defaultValue={e.foregroundY} format="pct" />
                <RangeField name="splitTopRatio" label="Facecam-højde (split)" min={0.2} max={0.5} step={0.01} defaultValue={e.splitTopRatio} format="pct" />
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <div><label className="label">Crop-fokus</label><select name="cropMode" defaultValue={e.cropMode} className="input"><option value="smart">Smart (bevægelsesanalyse + AI)</option><option value="center">Midten</option></select></div>
                <div><label className="label">Framerate</label><select name="fps" defaultValue={e.fps} className="input"><option value="source">Som kilden (maks 60)</option><option value="60">60 hvis kilden har det</option><option value="30">Altid 30</option></select></div>
                <div><label className="label">Kvalitet (CRF)</label><input type="number" name="crf" min={16} max={30} defaultValue={e.crf} className="input" /><p className="hint">Lavere = bedre kvalitet, større fil. 20 anbefales.</p></div>
              </div>
              <div>
                <label className="label">Facecam</label>
                <select name="facecamMode" defaultValue={e.facecamMode} className="input mb-3 max-w-sm">
                  <option value="auto">Automatisk detektion (AI)</option>
                  <option value="manual">Fast manuel position</option>
                  <option value="off">Fra</option>
                </select>
                <FacecamPicker image={sampleThumb} initial={e.facecamRect} enabledDefault />
                <p className="hint">Den manuelle position bruges kun når “Fast manuel position” er valgt.</p>
              </div>
              <fieldset className="space-y-4 rounded-lg border border-border p-4">
                <legend className="px-1 text-sm font-semibold">Undertekster</legend>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="subsEnabled" defaultChecked={e.subtitles.enabled} className="accent-[#8b5cf6]" /> Brænd undertekster ind (whisper)</label>
                <div className="grid gap-4 md:grid-cols-4">
                  <div><label className="label">Sprog</label><select name="subsLanguage" defaultValue={e.subtitles.language} className="input"><option value="auto">Auto (dansk/engelsk)</option><option value="da">Dansk</option><option value="en">Engelsk</option></select></div>
                  <div><label className="label">Placering</label><select name="subsPosition" defaultValue={e.subtitles.position} className="input"><option value="lower">Nederst (over TikTok-UI)</option><option value="center">Midt</option><option value="upper">Øverst</option></select></div>
                  <div><label className="label">Skriftstørrelse</label><input type="number" name="fontSize" min={40} max={140} defaultValue={e.subtitles.fontSize} className="input" /></div>
                  <div><label className="label">Ord pr. linje</label><input type="number" name="maxWordsPerLine" min={1} max={6} defaultValue={e.subtitles.maxWordsPerLine} className="input" /></div>
                </div>
                <div className="flex flex-wrap items-center gap-5 text-sm">
                  <label className="flex items-center gap-2"><input type="checkbox" name="highlight" defaultChecked={e.subtitles.highlight} className="accent-[#8b5cf6]" /> Fremhæv aktivt ord</label>
                  <label className="flex items-center gap-2">Farve <input type="color" name="highlightColor" defaultValue={e.subtitles.highlightColor} className="h-7 w-10 rounded border border-border bg-transparent" /></label>
                  <label className="flex items-center gap-2"><input type="checkbox" name="uppercase" defaultChecked={e.subtitles.uppercase} className="accent-[#8b5cf6]" /> STORE BOGSTAVER</label>
                </div>
              </fieldset>
              <fieldset className="space-y-3 rounded-lg border border-border p-4">
                <legend className="px-1 text-sm font-semibold">Lyd</legend>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="normalize" defaultChecked={e.audio.normalize} className="accent-[#8b5cf6]" /> Normalisér lydniveau (2-pass EBU R128 + limiter mod clipping)</label>
                <div className="max-w-xs"><label className="label">Mål-loudness (LUFS)</label><input type="number" name="targetLufs" step={0.5} min={-24} max={-9} defaultValue={e.audio.targetLufs} className="input" /></div>
                <p className="hint">Original spil- og mikrofonlyd bevares. Der tilføjes aldrig musik.</p>
              </fieldset>
              <SubmitButton>Gem editor-standarder</SubmitButton>
            </ActionForm>
          </Card>

          <Card title="AI-titler">
            <ActionForm action={saveAi} className="space-y-4">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="aiEnabled" defaultChecked={s.ai.enabled} className="accent-[#8b5cf6]" /> Brug AI (Claude) til at se klippet og skrive titlen</label>
              <div className="grid gap-4 md:grid-cols-3">
                <div><label className="label">Maks titellængde</label><input type="number" name="titleMaxLength" min={20} max={150} defaultValue={s.ai.titleMaxLength} className="input" /></div>
                <div><label className="label">Frames pr. clip</label><input type="number" name="frameCount" min={3} max={16} defaultValue={s.ai.frameCount} className="input" /></div>
                <div><label className="label">Min. confidence</label><input type="number" name="confidenceThreshold" step={0.05} min={0} max={1} defaultValue={s.ai.confidenceThreshold} className="input" /><p className="hint">Under dette bruges Twitch-titlen.</p></div>
              </div>
              <div className="flex flex-wrap gap-5 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" name="emoji" defaultChecked={s.ai.emoji} className="accent-[#8b5cf6]" /> Tillad én relevant emoji</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="verifyTitle" defaultChecked={s.ai.verifyTitle} className="accent-[#8b5cf6]" /> Faktatjek titlen i et separat AI-kald</label>
              </div>
              <div><label className="label">Forbudte titler (én pr. linje)</label><textarea name="forbiddenTitles" rows={6} defaultValue={s.ai.forbiddenTitles.join("\n")} className="input font-mono text-xs" /><p className="hint">Titler der ligner disse afvises — også generiske floskler og gentagelser af tidligere titler.</p></div>
              <SubmitButton>Gem AI-indstillinger</SubmitButton>
            </ActionForm>
          </Card>
        </div>
        <Card title="Rediger et clip">
          <ul className="space-y-3">
            {recent.map((c) => (
              <li key={c.id}><Link href={`/clips/${c.id}`} className="flex items-center gap-3 rounded-lg p-1.5 hover:bg-surface-2"><ClipThumb clip={c} className="h-12 w-20" /><div className="min-w-0"><div className="truncate text-sm">{c.final_title ?? c.twitch_title}</div><StatusBadge status={c.status} /></div></Link></li>
            ))}
          </ul>
          <Link href="/clips" className="mt-4 block text-sm text-accent-2 hover:underline">Alle clips →</Link>
        </Card>
      </div>
    </>
  );
}
