import { getSettings } from "@/lib/settings";
import { config } from "@/lib/config";
import { ActionForm, SubmitButton } from "@/components/client";
import { Card, PageHeader, Notice } from "@/components/ui";
import { saveAutomation, historicalImport } from "../../actions";

function Toggle({ name, label, desc, checked }: { name: string; label: string; desc: string; checked: boolean }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-border p-4 has-[:checked]:border-accent/60">
      <span><span className="text-sm font-medium">{label}</span><br /><span className="text-xs text-muted">{desc}</span></span>
      <input type="checkbox" name={name} defaultChecked={checked} className="peer sr-only" />
      <span className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full bg-border transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-accent peer-checked:after:translate-x-5" />
    </label>
  );
}

export default async function AutomationPage() {
  const s = await getSettings();
  const a = s.automation;
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  return (
    <>
      <PageHeader title="Automation Settings" subtitle="Styr hvad der sker automatisk. Ændringer træder i kraft inden for et minut." />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card title="Automatisering">
          <ActionForm action={saveAutomation} className="space-y-4">
            <Toggle name="monitorEnabled" label="Automatisk overvågning" desc="Scanner Twitch for nye clips med det valgte interval" checked={a.monitorEnabled} />
            <Toggle name="autoEdit" label="Automatisk videoredigering" desc="Nye clips downloades, analyseres og redigeres med det samme" checked={a.autoEdit} />
            <Toggle name="autoPublish" label="Automatisk publicering" desc="Klare videoer uploades til TikTok inden for grænserne herunder (kræver samtykke og TikTok-godkendelse)" checked={a.autoPublish} />
            <div>
              <label className="label">Hvilke clips uploades</label>
              <select name="selection" defaultValue={a.selection} className="input max-w-xl">
                <option value="newest">Nyeste først — hvert ledigt opslag tager det senest klippede clip (anbefalet)</option>
                <option value="all">Alle, ældste først (køen kan vokse meget på travle dage)</option>
              </select>
              <p className="hint">Med “nyeste først” markeres ældre clips, der ikke nåede med, som “Sprunget over”. De kan stadig sættes i kø manuelt fra Clip Library.</p>
            </div>
            <div className="grid gap-4 pt-2 md:grid-cols-3">
              <div><label className="label">Pollinginterval (sek)</label><input type="number" name="pollIntervalSec" min={30} max={3600} defaultValue={a.pollIntervalSec} className="input" /><p className="hint">{config.runMode === "batch" ? "Gratis-mode: din computer kører hvert 15. minut — denne værdi bruges ikke." : "Min. 30. Ét scan bruger typisk 1–3 API-kald."}</p></div>
              <div><label className="label">Maks posts pr. 24 t</label><input type="number" name="maxPostsPer24h" min={1} max={50} defaultValue={a.maxPostsPer24h} className="input" /><p className="hint">Hold dig under TikToks daglige grænse (typisk ~15 via API).</p></div>
              <div><label className="label">Min. minutter mellem posts</label><input type="number" name="minMinutesBetweenPosts" min={0} max={1440} defaultValue={a.minMinutesBetweenPosts} className="input" /></div>
            </div>
            <details className="rounded-lg border border-border p-4">
              <summary className="cursor-pointer text-sm font-medium">Avanceret: scanning, download og oprydning</summary>
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <div><label className="label">Overlap (min)</label><input type="number" name="overlapMinutes" min={5} max={240} defaultValue={a.overlapMinutes} className="input" /><p className="hint">Hvert scan går så langt tilbage, for clips Twitch indekserer sent.</p></div>
                <div><label className="label">Dyb scan hver (timer)</label><input type="number" name="deepScanEveryHours" min={1} max={48} defaultValue={a.deepScanEveryHours} className="input" /></div>
                <div><label className="label">Dyb scan tilbage (timer)</label><input type="number" name="deepScanLookbackHours" min={6} max={336} defaultValue={a.deepScanLookbackHours} className="input" /></div>
                <div><label className="label">Download-metode</label><select name="downloadMethod" defaultValue={s.twitch.downloadMethod} className="input"><option value="auto">Automatisk (officiel hvis muligt)</option><option value="official">Kun officiel Twitch API</option><option value="public">Kun offentligt clip</option></select></div>
                <div><label className="label">Slet kildefil efter (dage)</label><input type="number" name="sourceDaysAfterPublish" min={0} max={365} defaultValue={s.retention.sourceDaysAfterPublish} className="input" /></div>
                <div><label className="label">Slet redigeret fil efter (dage)</label><input type="number" name="renderDaysAfterPublish" min={0} max={365} defaultValue={s.retention.renderDaysAfterPublish} className="input" /></div>
                <div><label className="label">Advar ved fri disk under (GB)</label><input type="number" name="minFreeDiskGb" min={1} max={500} defaultValue={s.retention.minFreeDiskGb} className="input" /></div>
              </div>
            </details>
            <SubmitButton>Gem</SubmitButton>
          </ActionForm>
        </Card>
        <div className="space-y-6">
          <Card title="Historisk import">
            <p className="mb-4 text-sm text-muted">Ved første start registreres eksisterende clips som baseline og uploades <b>ikke</b>. Her kan du sætte clips fra en periode i kø.</p>
            <ActionForm action={historicalImport} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Fra</label><input type="date" name="start" defaultValue={monthAgo} max={today} className="input" /></div>
                <div><label className="label">Til</label><input type="date" name="end" defaultValue={today} max={today} className="input" /></div>
              </div>
              <SubmitButton className="btn-ghost" confirm="Alle clips i perioden behandles og (hvis auto-publicering er slået til) uploades. Fortsæt?">Importér periode</SubmitButton>
            </ActionForm>
          </Card>
          <Notice tone="info">Alle nye clips behandles — der filtreres ikke på visninger eller AI-vurdering. Hvis TikTok begrænser antallet af posts, venter overskydende clips i køen.</Notice>
        </div>
      </div>
    </>
  );
}
