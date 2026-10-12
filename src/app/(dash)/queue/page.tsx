import Link from "next/link";
import { queueData } from "@/lib/dashboard";
import { getSettings } from "@/lib/settings";
import { nextAllowedPostTime } from "@/lib/pipeline/upload";
import { AutoRefresh, ActionForm, SubmitButton } from "@/components/client";
import { Card, PageHeader, StatusBadge, ago, dt, Empty, Notice } from "@/components/ui";
import { ClipThumb } from "@/components/clip-thumb";
import { retryClip, uploadNow, resolveAction } from "../../actions";

export default async function QueuePage() {
  const [{ active, recentPublished }, settings] = await Promise.all([queueData(), getSettings()]);
  const slot = await nextAllowedPostTime(settings);
  const needs = active.filter((c) => ["NEEDS_USER_ACTION", "BLOCKED_PERMISSION", "FAILED"].includes(c.status));
  const rest = active.filter((c) => !needs.includes(c));
  return (
    <>
      <AutoRefresh ms={5000} />
      <PageHeader title="Upload Queue" subtitle={`${active.length} clip(s) i arbejde · poster maks ${settings.automation.maxPostsPer24h} pr. døgn med mindst ${settings.automation.minMinutesBetweenPosts} min imellem`} />
      <div className="mb-6 grid gap-3 md:grid-cols-2">
        <Notice tone={settings.automation.autoPublish ? "ok" : "warn"}>Automatisk publicering er {settings.automation.autoPublish ? "slået TIL" : "slået FRA — klare videoer venter her"}.</Notice>
        <Notice tone={slot.at ? "warn" : "ok"}>{slot.at ? `${slot.reason}. Næste post tidligst ${dt(slot.at)}.` : "Næste klare clip kan postes nu."}</Notice>
      </div>

      {needs.length > 0 && (
        <Card title={`Kræver opmærksomhed (${needs.length})`} className="mb-6">
          <ul className="divide-y divide-border/70">
            {needs.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start gap-4 py-4">
                <ClipThumb clip={c} />
                <div className="min-w-0 flex-1">
                  <Link href={`/clips/${c.id}`} className="font-medium hover:text-accent-2">{c.final_title ?? c.twitch_title}</Link>
                  <div className="mt-1"><StatusBadge status={c.status} /></div>
                  <p className="mt-1.5 text-sm text-muted">{c.status_reason ?? c.last_error}</p>
                  <p className="mt-1 text-xs text-faint">Forsøg: {c.attempts} · senest opdateret {ago(c.updated_at)}</p>
                </div>
                <div className="flex flex-col gap-2">
                  {c.status === "NEEDS_USER_ACTION" && c.tiktok_publish_id ? (
                    <>
                      <ActionForm action={resolveAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="outcome" value="published" /><SubmitButton className="btn-primary text-xs">Er publiceret</SubmitButton></ActionForm>
                      <ActionForm action={resolveAction}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="outcome" value="not_published" /><SubmitButton className="btn-ghost text-xs" confirm="Bekræft at videoen IKKE findes på TikTok.">Ikke publiceret</SubmitButton></ActionForm>
                    </>
                  ) : (
                    <ActionForm action={retryClip}><input type="hidden" name="id" value={c.id} /><SubmitButton className="btn-ghost text-xs">Prøv igen</SubmitButton></ActionForm>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Aktive jobs">
        {rest.length === 0 ? <Empty>Køen er tom.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr><th className="pb-3">Clip</th><th className="pb-3">Status</th><th className="pb-3">Forsøg</th><th className="pb-3">Seneste fejl</th><th className="pb-3">Næste retry</th><th className="pb-3" /></tr>
              </thead>
              <tbody>
                {rest.map((c) => (
                  <tr key={c.id} className="table-row align-top">
                    <td className="py-3 pr-4"><Link href={`/clips/${c.id}`} className="flex items-center gap-3 hover:text-accent-2"><ClipThumb clip={c} className="h-10 w-16" /><span className="line-clamp-2 max-w-xs">{c.final_title ?? c.twitch_title}</span></Link></td>
                    <td className="py-3 pr-4"><StatusBadge status={c.status} />{c.status_reason && <div className="mt-1 max-w-52 text-xs text-muted">{c.status_reason}</div>}</td>
                    <td className="py-3 pr-4 tabular-nums">{c.attempts}</td>
                    <td className="max-w-xs py-3 pr-4 text-xs text-bad">{c.last_error ?? ""}</td>
                    <td className="py-3 pr-4 text-xs text-muted">{c.next_retry_at ? ago(c.next_retry_at) : "—"}</td>
                    <td className="py-3">{c.status === "READY" && <ActionForm action={uploadNow}><input type="hidden" name="id" value={c.id} /><SubmitButton className="btn-ghost text-xs" confirm="Upload nu, uden om køens tidsplan?">Upload nu</SubmitButton></ActionForm>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Senest publiceret" className="mt-6">
        {recentPublished.length === 0 ? <Empty>Intet publiceret endnu.</Empty> : (
          <ul className="space-y-2 text-sm">
            {recentPublished.map((p) => (
              <li key={String(p.id)} className="flex justify-between gap-4">
                <Link href={`/clips/${p.id}`} className="truncate hover:text-accent-2">{String(p.final_title)}</Link>
                <span className="whitespace-nowrap text-xs text-muted">{ago(p.published_at as Date)} {p.tiktok_url ? <a href={String(p.tiktok_url)} className="ml-2 text-ok" target="_blank" rel="noreferrer">TikTok ↗</a> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
