/**
 * REAL end-to-end check against the live services (no mocks). Does not touch the clips table.
 *   node --import tsx scripts/live-e2e.ts            # read-only + local processing
 *   node --import tsx scripts/live-e2e.ts --upload   # also ONE private (SELF_ONLY) TikTok upload
 * Each step reports PASS / FAIL / SKIP with the reason.
 */
import fs from "node:fs";
import path from "node:path";
import { config, paths } from "@/lib/config";
import { run } from "@/lib/proc";
import { probe } from "@/lib/media/probe";
import { analyzeMotion, extractAudio, extractFrames } from "@/lib/media/analyze";
import { transcribe, type Transcript } from "@/lib/media/whisper";
import { renderVertical, targetFps } from "@/lib/media/render";
import { analyzeClip, verifyTitle, type ClipAnalysis } from "@/lib/ai/claude";
import { validateTitle, fallbackTitle, buildHashtags, composeCaption } from "@/lib/ai/titles";
import { defaultSettings } from "@/lib/settings";
import { closeDb } from "@/lib/db";

const results: Array<[string, "PASS" | "FAIL" | "SKIP", string]> = [];
const step = async <T>(name: string, fn: () => Promise<T>, skip?: string): Promise<T | null> => {
  if (skip) { results.push([name, "SKIP", skip]); console.log(`- SKIP ${name}: ${skip}`); return null; }
  const t = Date.now();
  try {
    const r = await fn();
    const msg = typeof r === "string" ? r : "";
    results.push([name, "PASS", `${msg} (${((Date.now() - t) / 1000).toFixed(1)}s)`]);
    console.log(`✓ PASS ${name} ${msg}`);
    return r;
  } catch (err) {
    results.push([name, "FAIL", err instanceof Error ? err.message : String(err)]);
    console.log(`✗ FAIL ${name}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
};

const upload = process.argv.includes("--upload");
const work = path.join(paths.work, `live-e2e-${Date.now()}`);
fs.mkdirSync(work, { recursive: true });
const settings = defaultSettings();
const hasTwitch = !!(config.twitchClientId && config.twitchClientSecret);
const hasDb = !!process.env.DATABASE_URL;

let clipUrl: string | null = null;
let clipTitle: string | null = null;
let clipId: string | null = null;

if (hasTwitch && hasDb) {
  const { getUserByLogin, helix } = await import("@/lib/twitch/api");
  await step("Twitch Helix: kanal + seneste clips", async () => {
    const u = await getUserByLogin(config.twitchChannel);
    if (!u) throw new Error("kanal ikke fundet");
    const p = new URLSearchParams({ broadcaster_id: u.id, started_at: new Date(Date.now() - 30 * 86400_000).toISOString(), ended_at: new Date().toISOString(), first: "100" });
    const { data } = await helix<{ id: string; url: string; title: string; created_at: string }>("/clips", p);
    if (!data.length) throw new Error("ingen clips de sidste 30 dage");
    const newest = [...data].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    clipUrl = newest.url; clipTitle = newest.title; clipId = newest.id;
    return `${u.display_name}: ${data.length} clips, nyeste "${newest.title}"`;
  });
} else {
  await step("Twitch Helix", async () => "", "TWITCH_CLIENT_ID/SECRET eller DATABASE_URL mangler — finder clip via yt-dlp i stedet");
  await step("Find offentligt clip (yt-dlp)", async () => {
    const { stdout } = await run(config.ytDlpPath, ["--flat-playlist", "-J", "--playlist-end", "5", `https://www.twitch.tv/${config.twitchChannel}/clips?filter=clips&range=7d`], { timeoutMs: 120_000 });
    const j = JSON.parse(stdout.toString()) as { entries?: Array<{ url: string; title: string; id: string }> };
    const e = j.entries?.[0];
    if (!e) throw new Error("ingen clips fundet de sidste 7 dage");
    clipUrl = e.url; clipTitle = e.title; clipId = e.id;
    return `"${e.title}"`;
  });
}

const src = path.join(work, "source.mp4");
const downloaded = clipUrl ? await step("Download clip", async () => {
  if (hasTwitch && hasDb) {
    const { officialDownloadAvailable } = await import("@/lib/twitch/download");
    const a = await officialDownloadAvailable();
    if (a.ok) {
      const { getClipDownloadUrls, getUserByLogin } = await import("@/lib/twitch/api");
      const u = await getUserByLogin(config.twitchChannel);
      const [d] = await getClipDownloadUrls(u!.id, a.editorId!, [clipId!]);
      const res = await fetch(d.landscape_download_url!);
      fs.writeFileSync(src, Buffer.from(await res.arrayBuffer()));
      return "officiel Twitch API";
    }
  }
  await run(config.ytDlpPath, ["--no-playlist", "-q", "-f", "best[ext=mp4]/best", "-o", src, clipUrl!], { timeoutMs: 300_000 });
  return "offentligt clip (yt-dlp)";
}) : null;

let transcript: Transcript | null = null;
let analysis: ClipAnalysis | null = null;
if (downloaded) {
  const info = await probe(src);
  console.log(`  kilde: ${info.width}x${info.height} @ ${info.fps} fps, ${info.duration.toFixed(1)} s, lyd: ${info.hasAudio}`);
  const motion = await step("Bevægelsesanalyse", async () => { const m = await analyzeMotion(src, info); return `fokus x=${m.focusX.toFixed(2)}, crop-dækning ${(m.cropCoverage * 100).toFixed(0)}%`; });
  void motion;
  transcript = await step("Speech-to-text (whisper.cpp)", async () => {
    const wav = await extractAudio(src, info, path.join(work, "a.wav"));
    if (!wav) throw new Error("ingen lyd");
    const t = await transcribe(wav, "auto", work);
    console.log(`  [${t.language}] ${t.text.slice(0, 300)}`);
    return t;
  }, fs.existsSync(config.whisperBin) || config.whisperBin === "whisper-cli" ? undefined : "whisper-cli ikke fundet");
  const frames = await extractFrames(src, info, settings.ai.frameCount, path.join(work, "frames"));
  analysis = await step("Claude vision-analyse", async () => {
    const r = await analyzeClip({ frames, transcript, twitchTitle: clipTitle, gameName: null, broadcaster: config.twitchChannel, duration: info.duration, maxTitleLength: settings.ai.titleMaxLength, allowEmoji: false, recentTitles: [] });
    console.log(`  observationer: ${r.analysis.observations.slice(0, 300)}`);
    console.log(`  forslag: "${r.analysis.title}" (confidence ${r.analysis.confidence}, facecam ${r.analysis.facecam.present})`);
    return r.analysis;
  }, config.anthropicApiKey ? undefined : "ANTHROPIC_API_KEY mangler");
  let title = fallbackTitle(clipTitle, settings.ai.titleMaxLength);
  if (analysis) {
    await step("Titelvalidering + faktatjek", async () => {
      const v = validateTitle(analysis!.title, { maxLength: 70, allowEmoji: false, forbidden: settings.ai.forbiddenTitles, recent: [] });
      if (!v.ok) return `afvist (${v.reason}) → Twitch-titel bruges`;
      const f = await verifyTitle(v.title, analysis!, transcript, clipTitle);
      if (f.supported) title = v.title;
      return f.supported ? `godkendt: "${v.title}"` : `faktatjek afviste (${f.problems}) → Twitch-titel`;
    });
  }
  const out = path.join(work, "tiktok.mp4");
  const rendered = await step("FFmpeg-render 1080x1920", async () => {
    const facecam = analysis?.facecam.present && analysis.facecam.confidence >= 0.75 ? analysis.facecam : null;
    const r = await renderVertical(src, info, {
      layout: facecam ? "split" : "blur", focusX: analysis?.action_focus_x ?? 0.5, blurZoom: 1.2, foregroundY: 0.5, facecam, splitTopRatio: 0.36,
      fps: targetFps(info.fps, "source"), crf: 20, audio: { normalize: true, targetLufs: -14 },
      subtitles: transcript?.words.length ? { words: transcript.words, style: { fontName: "Montserrat ExtraBold", fontSize: 78, position: "lower", highlight: true, highlightColor: "#FFD43B", uppercase: false, maxWordsPerLine: 3 } } : null,
    }, out, path.join(work, "render"));
    return `${r.layout}, ${r.info.width}x${r.info.height}, ${r.info.fps} fps, ${(r.info.sizeBytes / 1024 / 1024).toFixed(1)} MB → ${out}`;
  });
  const caption = composeCaption(title ?? "Testclip", buildHashtags(settings.hashtags.fixed, analysis?.hashtags ?? [], { max: 6, aiEnabled: true }), 2200).caption;
  console.log(`  caption:\n${caption.split("\n").map((l) => `    ${l}`).join("\n")}`);

  if (hasDb && config.tiktokClientKey) {
    const { creatorInfo, chunkPlan, initDirectPost, uploadChunks, fetchStatus } = await import("@/lib/tiktok/api");
    const ci = await step("TikTok creator info", async () => { const c = await creatorInfo(); return `@${c.creator_username}, tilladt: ${c.privacy_level_options.join(", ")}`; });
    if (rendered && ci) {
      await step("TikTok PRIVAT testupload (SELF_ONLY)", async () => {
        const size = fs.statSync(out).size;
        const plan = chunkPlan(size);
        const r = await initDirectPost({ title: `[TEST] ${caption}`, privacy_level: "SELF_ONLY", disable_comment: true, disable_duet: true, disable_stitch: true, brand_content_toggle: false, brand_organic_toggle: false }, plan);
        await uploadChunks(r.upload_url, out, plan, async () => {});
        for (let i = 0; i < 40; i++) {
          await new Promise((res) => setTimeout(res, 6000));
          const st = await fetchStatus(r.publish_id);
          if (st.status === "PUBLISH_COMPLETE") return `publish_id ${r.publish_id}: PUBLISH_COMPLETE (privat — tjek din profil)`;
          if (st.status === "FAILED") throw new Error(`TikTok FAILED: ${st.fail_reason}`);
        }
        throw new Error(`stadig ikke færdig efter 4 min (publish_id ${r.publish_id})`);
      }, upload ? undefined : "kør med --upload for at lave én privat testupload");
    }
  } else {
    await step("TikTok", async () => "", "TIKTOK_CLIENT_KEY eller DATABASE_URL mangler");
  }
}

console.log("\nRESULTAT");
for (const [n, s, m] of results) console.log(`${s.padEnd(4)}  ${n}${m ? ` — ${m}` : ""}`);
console.log(`\nArbejdsmappe: ${work}`);
if (hasDb) await closeDb();
process.exit(results.some((r) => r[1] === "FAIL") ? 1 : 0);
