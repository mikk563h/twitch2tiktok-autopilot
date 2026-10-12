import Link from "next/link";
import { listClips, statusCounts } from "@/lib/dashboard";
import { CLIP_STATUSES, STATUS_LABELS } from "@/lib/clips";
import { AutoRefresh, ActionForm, SubmitButton } from "@/components/client";
import { PageHeader, StatusBadge, ago, Empty } from "@/components/ui";
import { ClipThumb } from "@/components/clip-thumb";
import { queueClip } from "../../actions";

export default async function ClipsPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; page?: string }> }) {
  const sp = await searchParams;
  const status = sp.status && (CLIP_STATUSES as readonly string[]).includes(sp.status) ? sp.status : undefined;
  const [{ rows, hasMore, page }, counts] = await Promise.all([listClips({ status, q: sp.q, page: Number(sp.page ?? 1) }), statusCounts()]);
  const link = (p: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    const merged = { status, q: sp.q, ...p };
    for (const [k, v] of Object.entries(merged)) if (v) u.set(k, v);
    return `/clips?${u}`;
  };
  return (
    <>
      <AutoRefresh ms={10000} />
      <PageHeader title="Clip Library" subtitle="Alle registrerede clips. Historiske clips (baseline) uploades kun hvis du sætter dem i kø." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href={link({ status: undefined, page: undefined })} className={`rounded-full border px-3 py-1 text-xs ${!status ? "border-accent bg-accent-soft text-fg" : "border-border text-muted hover:text-fg"}`}>Alle aktive</Link>
        {CLIP_STATUSES.filter((s) => counts[s]).map((s) => (
          <Link key={s} href={link({ status: s, page: undefined })} className={`rounded-full border px-3 py-1 text-xs ${status === s ? "border-accent bg-accent-soft text-fg" : "border-border text-muted hover:text-fg"}`}>
            {STATUS_LABELS[s]} <span className="text-faint">{counts[s]}</span>
          </Link>
        ))}
        <form className="ml-auto" action="/clips">
          {status && <input type="hidden" name="status" value={status} />}
          <input name="q" defaultValue={sp.q} placeholder="Søg titel, spil, id…" className="input w-64" />
        </form>
      </div>
      <div className="card overflow-x-auto">
        {rows.length === 0 ? <div className="p-5"><Empty>Ingen clips matcher.</Empty></div> : (
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr><th className="px-4 py-3">Clip</th><th className="px-4 py-3">Titler</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Video</th><th className="px-4 py-3">TikTok</th></tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="table-row align-top">
                  <td className="px-4 py-3">
                    <Link href={`/clips/${c.id}`} className="flex gap-3">
                      <ClipThumb clip={c} />
                      <div className="text-xs text-muted">
                        <div className="font-mono text-faint">#{c.id}</div>
                        <div>{c.game_name ?? "—"}</div>
                        <div>{ago(c.twitch_created_at)}</div>
                        <div>{c.duration ? `${c.duration.toFixed(0)}s` : ""} · {c.view_count ?? 0} visn.</div>
                      </div>
                    </Link>
                  </td>
                  <td className="max-w-md px-4 py-3">
                    <Link href={`/clips/${c.id}`} className="block hover:text-accent-2">
                      <div className="font-medium">{c.final_title ?? <span className="text-faint">(ikke analyseret endnu)</span>}</div>
                      <div className="mt-1 text-xs text-muted">Twitch: {c.twitch_title || "(ingen)"}</div>
                      {c.title_source && <div className="mt-1 text-[11px] uppercase tracking-wide text-faint">kilde: {c.title_source === "ai" ? "AI" : c.title_source === "twitch" ? "Twitch-titel (fallback)" : "manuel"}</div>}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status} />
                    {c.status_reason && c.status !== "PUBLISHED" && <div className="mt-1.5 max-w-56 text-xs text-muted">{c.status_reason}</div>}
                    {c.status === "BASELINE" && (
                      <ActionForm action={queueClip} className="mt-2"><input type="hidden" name="id" value={c.id} /><SubmitButton className="btn-ghost text-xs">Sæt i kø</SubmitButton></ActionForm>
                    )}
                  </td>
                  <td className="space-y-1 px-4 py-3 text-xs">
                    {c.url && <a className="block text-accent-2 hover:underline" href={c.url} target="_blank" rel="noreferrer">Twitch-clip ↗</a>}
                    {c.source_path && <a className="block text-accent-2 hover:underline" href={`/api/media/${c.id}/source`} target="_blank">Original ↗</a>}
                    {c.render_path && <a className="block text-accent-2 hover:underline" href={`/api/media/${c.id}/render`} target="_blank">Redigeret ↗</a>}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {c.tiktok_url ? <a className="text-ok hover:underline" href={c.tiktok_url} target="_blank" rel="noreferrer">Åbn på TikTok ↗</a> : c.published_at ? <span className="text-ok">Publiceret</span> : <span className="text-faint">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="mt-4 flex justify-between text-sm">
        {page > 1 ? <Link className="btn-ghost" href={link({ page: String(page - 1) })}>← Forrige</Link> : <span />}
        {hasMore && <Link className="btn-ghost" href={link({ page: String(page + 1) })}>Næste →</Link>}
      </div>
    </>
  );
}
