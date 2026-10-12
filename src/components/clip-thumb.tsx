/* eslint-disable @next/next/no-img-element */
import type { Clip } from "@/lib/clips";

export function ClipThumb({ clip, className = "h-16 w-28" }: { clip: Pick<Clip, "id" | "render_thumb_path" | "thumbnail_url" | "twitch_title">; className?: string }) {
  const src = clip.render_thumb_path ? `/api/media/${clip.id}/thumb` : clip.thumbnail_url;
  return src ? (
    <img src={src} alt="" loading="lazy" className={`${className} shrink-0 rounded-md border border-border bg-surface-2 object-cover`} />
  ) : (
    <div className={`${className} shrink-0 rounded-md border border-border bg-surface-2`} />
  );
}
