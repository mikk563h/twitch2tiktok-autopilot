import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config, paths } from "../config";
import { run } from "../proc";
import { probe, type MediaInfo } from "../media/probe";
import { getClipDownloadUrls, TWITCH_DOWNLOAD_SCOPES, TwitchError, userToken } from "./api";
import type { Settings } from "../settings";

export class PermissionError extends Error {}

export type DownloadMethod = "official" | "public";

export async function officialDownloadAvailable(): Promise<{ ok: boolean; reason?: string; editorId?: string }> {
  const t = await userToken().catch(() => null);
  if (!t) return { ok: false, reason: "Ingen Twitch-brugerkonto forbundet" };
  if (t.status !== "ok") return { ok: false, reason: t.statusMessage ?? "Twitch-forbindelsen kræver ny godkendelse" };
  if (!t.scopes.some((s) => TWITCH_DOWNLOAD_SCOPES.includes(s))) return { ok: false, reason: "Twitch-tokenet mangler scope editor:manage:clips eller channel:manage:clips" };
  return { ok: true, editorId: t.accountId ?? undefined };
}

async function downloadUrl(url: string, dest: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download fejlede: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(dest));
}

export interface DownloadResult { file: string; method: DownloadMethod; info: MediaInfo }

/**
 * Downloads the clip to data/sources/<clip>.mp4. Writes to a temp file first and renames,
 * so a crash never leaves a half-written file that looks complete.
 */
export async function downloadClip(clip: { id: number; twitch_clip_id: string; broadcaster_id: string; url: string | null }, settings: Settings): Promise<DownloadResult> {
  await fsp.mkdir(paths.sources, { recursive: true });
  const dest = path.join(paths.sources, `${clip.id}-${clip.twitch_clip_id.replace(/[^\w-]/g, "_").slice(0, 80)}.mp4`);
  const tmp = `${dest}.part`;
  await fsp.rm(tmp, { force: true });

  const wanted = settings.twitch.downloadMethod;
  let method: DownloadMethod = wanted === "public" ? "public" : "official";
  if (method === "official") {
    const avail = await officialDownloadAvailable();
    if (!avail.ok) {
      if (wanted === "official") throw new PermissionError(`Officiel Twitch-download er ikke mulig: ${avail.reason}`);
      method = "public";
    } else {
      try {
        const [d] = await getClipDownloadUrls(clip.broadcaster_id, avail.editorId!, [clip.twitch_clip_id]);
        const url = d?.landscape_download_url ?? d?.portrait_download_url;
        if (!url) throw new Error("Twitch returnerede ingen download-URL for clippet (endnu)");
        await downloadUrl(url, tmp);
      } catch (err) {
        if (err instanceof TwitchError && (err.status === 401 || err.status === 403)) {
          if (wanted === "official") throw new PermissionError(`Twitch afviste download (${err.status}): kontoen er ikke broadcaster/editor for kanalen`);
          method = "public";
        } else {
          throw err;
        }
      }
    }
  }
  if (method === "public") {
    if (!clip.url) throw new Error("Clip mangler URL");
    await run(config.ytDlpPath, ["--no-playlist", "--no-progress", "--quiet", "-f", "best[ext=mp4]/best", "-o", tmp, clip.url], { timeoutMs: 5 * 60_000 });
  }
  const stat = await fsp.stat(tmp).catch(() => null);
  if (!stat || stat.size < 10_000) throw new Error("Downloadet fil er tom eller mangler");
  const info = await probe(tmp);
  if (info.duration < 1) throw new Error("Downloadet video har ingen varighed");
  await fsp.rename(tmp, dest);
  return { file: dest, method, info };
}
