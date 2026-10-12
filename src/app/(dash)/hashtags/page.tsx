import { getSettings } from "@/lib/settings";
import { sql } from "@/lib/db";
import { buildHashtags, composeCaption } from "@/lib/ai/titles";
import type { StoredAnalysis } from "@/lib/pipeline/process";
import { ActionForm, SubmitButton, TagEditor } from "@/components/client";
import { Card, PageHeader } from "@/components/ui";
import { saveHashtags } from "../../actions";

export default async function HashtagsPage() {
  const s = await getSettings();
  const [sample] = await sql()`SELECT final_title, twitch_title, analysis FROM clips WHERE analysis IS NOT NULL ORDER BY updated_at DESC LIMIT 1`;
  const aiTags = ((sample?.analysis as StoredAnalysis | undefined)?.ai?.hashtags) ?? ["counterstrike", "cs2", "clutch"];
  const title = (sample?.final_title as string | undefined) ?? "Eksempel: Han clutcher 1v4 med en pistol";
  const tags = buildHashtags(s.hashtags.fixed, aiTags, { max: s.hashtags.maxTotal, aiEnabled: s.hashtags.aiEnabled });
  const preview = composeCaption(title, tags, s.hashtags.captionMaxLength);
  return (
    <>
      <PageHeader title="Hashtag Manager" subtitle="Faste hashtags tilføjes altid først. AI-hashtags fylder op til maksimum, baseret på det faktiske klip." />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card title="Indstillinger">
          <ActionForm action={saveHashtags} className="space-y-5">
            <div>
              <label className="label">Faste hashtags (altid med, i denne rækkefølge)</label>
              <TagEditor name="fixed" initial={s.hashtags.fixed} />
              <p className="hint">Skriv et hashtag og tryk Enter. Brug ↑ for at prioritere. Dubletter fjernes automatisk; kun bogstaver, tal og _.</p>
            </div>
            <label className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
              <input type="checkbox" name="aiEnabled" defaultChecked={s.hashtags.aiEnabled} className="h-4 w-4 accent-[#8b5cf6]" />
              <span><span className="font-medium">AI-genererede hashtags</span><br /><span className="text-xs text-muted">Claude foreslår tags ud fra spillet og det der sker i klippet. Irrelevante/generiske tags (fyp, viral) frasorteres i prompten.</span></span>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label className="label">Maks antal hashtags i alt</label><input type="number" name="maxTotal" min={0} max={30} defaultValue={s.hashtags.maxTotal} className="input" /><p className="hint">Faste tags har altid forrang.</p></div>
              <div><label className="label">Maks caption-længde</label><input type="number" name="captionMaxLength" min={100} max={2200} defaultValue={s.hashtags.captionMaxLength} className="input" /><p className="hint">TikTok tillader op til 2200 tegn (UTF-16).</p></div>
            </div>
            <SubmitButton>Gem hashtags</SubmitButton>
          </ActionForm>
        </Card>
        <Card title="Caption preview">
          <div className="rounded-xl border border-border bg-black p-4">
            <div className="mb-2 text-xs text-faint">@{"din_konto"}</div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{preview.caption.split(/(#[\p{L}\p{N}_]+)/u).map((p, i) => p.startsWith("#") ? <span key={i} className="font-semibold text-white">{p}</span> : <span key={i}>{p}</span>)}</p>
          </div>
          <p className="hint">{preview.caption.length} tegn · {preview.tags.length} hashtags · baseret på {sample ? "seneste analyserede clip" : "et eksempel"}</p>
          <div className="mt-4 space-y-1 text-xs text-muted">
            <div><span className="text-fg">Faste:</span> {s.hashtags.fixed.map((t) => `#${t}`).join(" ") || "—"}</div>
            <div><span className="text-fg">AI (eksempel):</span> {s.hashtags.aiEnabled ? aiTags.map((t) => `#${t}`).join(" ") : "slået fra"}</div>
          </div>
        </Card>
      </div>
    </>
  );
}
