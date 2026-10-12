import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { paths } from "../config";
import { sql } from "../db";
import { getSettings, type Settings } from "../settings";
import { addEvent, failClip, getClip, patchClip, transition, type Clip, type ClipStatus } from "../clips";
import { enqueueClip } from "../queue";
import { record, errMsg, toJson } from "../log";
import { downloadClip, PermissionError } from "../twitch/download";
import { analyzeMotion, extractAudio, extractFrames, type MotionAnalysis } from "../media/analyze";
import { probe, type MediaInfo } from "../media/probe";
import { transcribe, type Transcript } from "../media/whisper";
import { renderVertical, targetFps, type Layout, type Rect, type RenderPlan } from "../media/render";
import { AiNotConfigured, analyzeClip, verifyTitle, type ClipAnalysis } from "../ai/claude";
import { buildHashtags, composeCaption, fallbackTitle, validateTitle } from "../ai/titles";

const ANALYSIS_VERSION = 1;
const PROCESSABLE: ClipStatus[] = ["DISCOVERED", "QUEUED", "DOWNLOADING", "DOWNLOADED", "ANALYZING", "EDITING"];

export interface StoredAnalysis {
  version: number;
  motion: MotionAnalysis;
  ai: ClipAnalysis | null;
  aiError: string | null;
  aiModel: string | null;
  aiUsage: unknown;
  transcriptError: string | null;
  title: { source: "ai" | "twitch" | "manual"; reason: string; candidates: Array<{ title: string; ok: boolean; reason?: string }> };
  analyzedAt: string;
}

export interface RenderOverrides {
  layout?: Layout | "auto";
  focusX?: number;
  blurZoom?: number;
  foregroundY?: number;
  facecamRect?: Rect | null;
  subtitles?: boolean;
}

/** Claims the clip for this worker instance. */
async function claim(clipId: number, worker: string): Promise<boolean> {
  // A lock is only respected while its holder is alive (fresh heartbeat with that instance id).
  const rows = await sql()`UPDATE clips SET locked_by = ${worker}, locked_at = now()
    WHERE id = ${clipId} AND (locked_by IS NULL OR locked_by = ${worker} OR locked_at < now() - interval '30 minutes'
      OR NOT EXISTS (SELECT 1 FROM worker_heartbeats h WHERE h.info->>'instance' = clips.locked_by AND h.last_beat_at > now() - interval '90 seconds'))
    RETURNING id`;
  return rows.length > 0;
}

async function release(clipId: number, worker: string) {
  await sql()`UPDATE clips SET locked_by = NULL, locked_at = NULL WHERE id = ${clipId} AND locked_by = ${worker}`;
}

function clipWorkDir(clip: Clip) {
  return path.join(paths.work, String(clip.id));
}

export async function recentTitles(excludeId: number): Promise<string[]> {
  const rows = await sql()`SELECT final_title FROM clips WHERE final_title IS NOT NULL AND id <> ${excludeId} ORDER BY updated_at DESC LIMIT 30`;
  return rows.map((r) => r.final_title as string);
}

/**
 * AI title with validation and verification; falls back to the Twitch title.
 * Returns null title when neither exists (clip then goes to the error queue).
 */
export async function decideTitle(
  clip: Pick<Clip, "id" | "twitch_title" | "manual_title" | "game_name" | "broadcaster_name" | "duration">,
  ai: ClipAnalysis | null,
  transcript: Transcript | null,
  settings: Settings,
  deps: { retry?: (rejected: { title: string; reason: string }) => Promise<ClipAnalysis | null>; verify?: typeof verifyTitle; recent?: string[] } = {},
): Promise<{ title: string | null; source: "ai" | "twitch" | "manual"; reason: string; candidates: StoredAnalysis["title"]["candidates"] }> {
  const candidates: StoredAnalysis["title"]["candidates"] = [];
  if (clip.manual_title?.trim()) return { title: clip.manual_title.trim(), source: "manual", reason: "manuel titel sat i dashboardet", candidates };
  const fb = () => {
    const t = fallbackTitle(clip.twitch_title, settings.ai.titleMaxLength);
    return t ? { title: t, source: "twitch" as const } : { title: null, source: "twitch" as const };
  };
  if (!ai) return { ...fb(), reason: "ingen AI-analyse — bruger Twitch-titel", candidates };
  if (!ai.understood || ai.confidence < settings.ai.confidenceThreshold) {
    candidates.push({ title: ai.title, ok: false, reason: `AI usikker (confidence ${ai.confidence.toFixed(2)})` });
    return { ...fb(), reason: `AI var usikker (confidence ${ai.confidence.toFixed(2)}) — bruger Twitch-titel`, candidates };
  }
  const recent = deps.recent ?? (await recentTitles(clip.id));
  const opts = { maxLength: settings.ai.titleMaxLength, allowEmoji: settings.ai.emoji, forbidden: settings.ai.forbiddenTitles, recent };
  let current: ClipAnalysis | null = ai;
  for (let round = 0; round < 2 && current; round++) {
    const check = validateTitle(current.title, opts);
    if (check.ok && settings.ai.verifyTitle && deps.verify !== undefined) {
      try {
        const v = await deps.verify(check.title, current, transcript, clip.twitch_title);
        if (!v.supported) {
          candidates.push({ title: check.title, ok: false, reason: `faktatjek: ${v.problems}` });
          current = round === 0 && deps.retry ? await deps.retry({ title: check.title, reason: `faktatjek fandt: ${v.problems}` }) : null;
          continue;
        }
      } catch (err) {
        candidates.push({ title: check.title, ok: false, reason: `faktatjek fejlede: ${errMsg(err)}` });
        return { ...fb(), reason: "faktatjek kunne ikke gennemføres — bruger Twitch-titel", candidates };
      }
    }
    if (check.ok) {
      candidates.push({ title: check.title, ok: true });
      return { title: check.title, source: "ai", reason: "AI-titel valideret", candidates };
    }
    candidates.push({ title: check.title, ok: false, reason: check.reason });
    current = round === 0 && deps.retry ? await deps.retry({ title: check.title, reason: check.reason! }) : null;
    if (current && (!current.understood || current.confidence < settings.ai.confidenceThreshold)) current = null;
  }
  return { ...fb(), reason: "AI-titlen bestod ikke valideringen — bruger Twitch-titel", candidates };
}

export function chooseFacecam(settings: Settings, ov: RenderOverrides, ai: ClipAnalysis | null): Rect | null {
  if (ov.facecamRect !== undefined) return ov.facecamRect;
  const mode = settings.editor.facecamMode;
  if (mode === "off") return null;
  if (mode === "manual") return settings.editor.facecamRect;
  const f = ai?.facecam;
  if (!f || !f.present || f.confidence < 0.75) return null;
  if (f.w < 0.06 || f.h < 0.06 || f.w > 0.55 || f.h > 0.6 || f.x + f.w > 1.02 || f.y + f.h > 1.02) return null;
  const pad = 0.01;
  return { x: Math.max(0, f.x - pad), y: Math.max(0, f.y - pad), w: Math.min(1 - Math.max(0, f.x - pad), f.w + 2 * pad), h: Math.min(1 - Math.max(0, f.y - pad), f.h + 2 * pad) };
}

export function buildPlan(settings: Settings, info: MediaInfo, a: StoredAnalysis, transcript: Transcript | null, ov: RenderOverrides): RenderPlan {
  const e = settings.editor;
  const facecam = chooseFacecam(settings, ov, a.ai);
  let layout = (ov.layout ?? e.layout) as Layout | "auto";
  if (layout === "auto") layout = facecam ? "split" : "blur";
  if (info.height > info.width && layout !== "blur") layout = "blur"; // already vertical source
  let focusX = 0.5;
  if (ov.focusX !== undefined) focusX = ov.focusX;
  else if (e.cropMode === "smart") focusX = a.ai ? a.motion.focusX * 0.6 + a.ai.action_focus_x * 0.4 : a.motion.focusX;
  const subsOn = ov.subtitles ?? e.subtitles.enabled;
  const topH = Math.round(1920 * e.splitTopRatio);
  return {
    layout,
    focusX,
    blurZoom: ov.blurZoom ?? e.blurZoom,
    foregroundY: ov.foregroundY ?? e.foregroundY,
    facecam: layout === "split" ? facecam : null,
    splitTopRatio: e.splitTopRatio,
    fps: targetFps(info.fps, e.fps),
    crf: e.crf,
    audio: e.audio,
    subtitles: subsOn && transcript?.words.length
      ? {
          words: transcript.words,
          style: {
            fontName: "Montserrat ExtraBold",
            fontSize: e.subtitles.fontSize,
            position: e.subtitles.position,
            highlight: e.subtitles.highlight,
            highlightColor: e.subtitles.highlightColor,
            uppercase: e.subtitles.uppercase,
            maxWordsPerLine: e.subtitles.maxWordsPerLine,
            // In split layout "center" sits on the seam between facecam and gameplay.
            centerY: layout === "split" && e.subtitles.position === "center" ? topH : undefined,
          },
        }
      : null,
  };
}

async function stageDownload(clip: Clip, settings: Settings): Promise<Clip> {
  if (clip.source_path && fs.existsSync(clip.source_path)) return clip;
  const c = (await transition(clip.id, ["DISCOVERED", "QUEUED", "DOWNLOADING", "DOWNLOADED", "ANALYZING", "EDITING"], "DOWNLOADING", {}, "Downloader clip fra Twitch")) ?? clip;
  const res = await downloadClip(c, settings);
  return (await transition(clip.id, ["DOWNLOADING"], "DOWNLOADED", { source_path: res.file, media_info: toJson(res.info), download_method: res.method },
    `Downloadet (${res.method === "official" ? "officiel Twitch API" : "offentligt clip"}, ${res.info.width}x${res.info.height}, ${res.info.duration.toFixed(1)}s)`))!;
}

async function stageAnalyze(clip: Clip, settings: Settings): Promise<Clip> {
  const existing = clip.analysis as unknown as StoredAnalysis | null;
  if (existing?.version === ANALYSIS_VERSION && clip.final_title) return clip;
  if (existing?.version === ANALYSIS_VERSION) {
    // Only the title changed (manual edit): recompute title + caption without paying for a new analysis.
    const transcript = clip.transcript as unknown as Transcript | null;
    const decision = await decideTitle(clip, existing.ai, transcript, settings);
    if (!decision.title) throw Object.assign(new Error("Hverken AI-titel eller Twitch-titel er tilgængelig — sæt en titel manuelt"), { permanent: true });
    const tags = buildHashtags(settings.hashtags.fixed, existing.ai?.hashtags ?? [], { max: settings.hashtags.maxTotal, aiEnabled: settings.hashtags.aiEnabled });
    const { caption, tags: kept } = composeCaption(decision.title, tags, settings.hashtags.captionMaxLength);
    await patchClip(clip.id, {
      final_title: decision.title, title_source: decision.source, hashtags: kept, caption,
      analysis: toJson({ ...existing, title: { source: decision.source, reason: decision.reason, candidates: decision.candidates } }),
    });
    await addEvent(clip.id, `Titel (${decision.source}): ${decision.title}`);
    return (await getClip(clip.id))!;
  }
  await transition(clip.id, ["DOWNLOADED", "ANALYZING", "EDITING"], "ANALYZING", {}, "Analyserer video, lyd og indhold");
  const src = clip.source_path!;
  const info = await probe(src);
  const work = clipWorkDir(clip);
  await fsp.mkdir(work, { recursive: true });

  const motion = await analyzeMotion(src, info);

  let transcript: Transcript | null = null;
  let transcriptError: string | null = null;
  try {
    const wav = await extractAudio(src, info, path.join(work, "audio.wav"));
    if (wav) transcript = await transcribe(wav, settings.editor.subtitles.language, work);
  } catch (err) {
    transcriptError = errMsg(err);
    await addEvent(clip.id, `Transskription fejlede: ${transcriptError}`, { level: "warn" });
  }

  let ai: ClipAnalysis | null = null;
  let aiError: string | null = null;
  let aiModel: string | null = null;
  let aiUsage: unknown = null;
  const frames = settings.ai.enabled ? await extractFrames(src, info, settings.ai.frameCount, path.join(work, "frames")) : [];
  const recent = await recentTitles(clip.id);
  const callAi = async (rejected?: { title: string; reason: string }) => {
    const r = await analyzeClip({
      frames, transcript, twitchTitle: clip.twitch_title, gameName: clip.game_name, broadcaster: clip.broadcaster_name,
      duration: info.duration, maxTitleLength: settings.ai.titleMaxLength, allowEmoji: settings.ai.emoji, recentTitles: recent, rejectedTitle: rejected,
    });
    aiModel = r.model;
    aiUsage = r.usage;
    return r.analysis;
  };
  if (settings.ai.enabled) {
    try {
      ai = await callAi();
    } catch (err) {
      aiError = err instanceof AiNotConfigured ? "AI-nøgle mangler" : errMsg(err);
      await addEvent(clip.id, `AI-analyse fejlede: ${aiError} — bruger Twitch-titel`, { level: "warn" });
    }
  }
  const decision = await decideTitle(clip, ai, transcript, settings, {
    recent,
    verify: ai ? verifyTitle : undefined,
    retry: ai ? async (rej) => { try { return await callAi(rej); } catch { return null; } } : undefined,
  });
  const analysis: StoredAnalysis = {
    version: ANALYSIS_VERSION, motion, ai, aiError, aiModel, aiUsage, transcriptError,
    title: { source: decision.source, reason: decision.reason, candidates: decision.candidates }, analyzedAt: new Date().toISOString(),
  };
  if (!decision.title) {
    await patchClip(clip.id, { analysis: toJson(analysis), transcript: toJson(transcript), media_info: toJson(info) });
    throw Object.assign(new Error("Hverken AI-titel eller Twitch-titel er tilgængelig — sæt en titel manuelt"), { permanent: true });
  }
  const tags = buildHashtags(settings.hashtags.fixed, ai?.hashtags ?? [], { max: settings.hashtags.maxTotal, aiEnabled: settings.hashtags.aiEnabled });
  const { caption, tags: kept } = composeCaption(decision.title, tags, settings.hashtags.captionMaxLength);
  await patchClip(clip.id, {
    analysis: toJson(analysis), transcript: toJson(transcript), media_info: toJson(info),
    ai_title: ai?.title ?? null, final_title: decision.title, title_source: decision.source, hashtags: kept, caption,
    game_name: clip.game_name ?? ai?.game ?? null,
  });
  await addEvent(clip.id, `Titel (${decision.source}): ${decision.title}`, { data: { reason: decision.reason } });
  return (await getClip(clip.id))!;
}

async function stageRender(clip: Clip, settings: Settings): Promise<Clip> {
  if (clip.render_path && fs.existsSync(clip.render_path)) {
    return (await transition(clip.id, ["ANALYZING", "EDITING", "DOWNLOADED"], "READY", {}, "Video er klar")) ?? clip;
  }
  await transition(clip.id, ["ANALYZING", "DOWNLOADED", "EDITING"], "EDITING", {}, "Redigerer til 9:16");
  const info = await probe(clip.source_path!);
  const plan = buildPlan(settings, info, clip.analysis as unknown as StoredAnalysis, clip.transcript as unknown as Transcript | null, clip.render_overrides as RenderOverrides);
  const out = path.join(paths.renders, `${clip.id}-${Date.now()}.mp4`);
  const res = await renderVertical(clip.source_path!, info, plan, out, path.join(clipWorkDir(clip), "render"));
  const { subtitles, ...planInfo } = plan;
  return (await transition(clip.id, ["EDITING"], "READY", {
    render_path: res.file, render_thumb_path: res.thumb,
    render_info: toJson({ plan: { ...planInfo, subtitles: subtitles ? { words: subtitles.words.length, style: subtitles.style } : null }, output: res.info, renderedAt: new Date().toISOString() }),
    status_reason: null, last_error: null,
  }, `Redigeret (${res.layout}, ${plan.fps} fps${subtitles ? ", undertekster" : ""})`))!;
}

/** Runs (or resumes) the whole pre-upload pipeline for one clip. Every stage is idempotent. */
export async function processClip(clipId: number, worker: string): Promise<ClipStatus | "skipped"> {
  const settings = await getSettings();
  let clip = await getClip(clipId);
  if (!clip || !PROCESSABLE.includes(clip.status)) return "skipped";
  if (!(await claim(clipId, worker))) return "skipped";
  try {
    if (clip.status === "DISCOVERED") clip = (await transition(clipId, ["DISCOVERED"], "QUEUED", {}, "Sat i behandlingskø")) ?? clip;
    clip = await stageDownload(clip, settings);
    clip = await stageAnalyze(clip, settings);
    clip = await stageRender(clip, settings);
    await patchClip(clipId, { attempts: 0, retry_stage: null, next_retry_at: null });
    if (settings.automation.autoPublish && settings.tiktok.mode !== "manual") await enqueueClip("upload", clipId);
    return clip.status;
  } catch (err) {
    const fresh = (await getClip(clipId)) ?? clip;
    if (err instanceof PermissionError) {
      return failClip(fresh, "process", err, { status: "BLOCKED_PERMISSION", reason: err.message });
    }
    const permanent = (err as { permanent?: boolean }).permanent === true;
    await record("error", "pipeline", `Clip ${clipId}: ${errMsg(err)}`, { clipId });
    return failClip(fresh, "process", err, { permanent });
  } finally {
    await release(clipId, worker);
  }
}

/** Dashboard action: re-render with new settings (keeps download and analysis). */
export async function requestRerender(clipId: number, overrides?: RenderOverrides, manualTitle?: string | null) {
  const clip = await getClip(clipId);
  if (!clip) throw new Error("Clip findes ikke");
  if (["UPLOADING", "PROCESSING", "PUBLISHED"].includes(clip.status)) throw new Error("Clippet er allerede sendt til TikTok og kan ikke genrenderes");
  const patch: Record<string, unknown> = { render_path: null, render_thumb_path: null, attempts: 0, next_retry_at: null, last_error: null, status_reason: null };
  if (overrides) patch.render_overrides = toJson(overrides);
  if (manualTitle !== undefined) {
    patch.manual_title = manualTitle?.trim() || null;
    patch.final_title = null; // forces the title/caption to be recomputed
  }
  const target: ClipStatus = clip.source_path ? "DOWNLOADED" : "QUEUED";
  const db = sql();
  await db`UPDATE clips SET ${db({ ...patch, status: target, updated_at: new Date() } as never)} WHERE id = ${clipId}`;
  await addEvent(clipId, "Manuel genrendering anmodet", { from: clip.status, to: target });
  await enqueueClip("process", clipId);
}
