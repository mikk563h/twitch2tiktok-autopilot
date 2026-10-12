import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { run } from "../proc";
import { probe, type MediaInfo } from "./probe";
import { buildAss, OUT_H, OUT_W, type SubtitleStyle } from "./subtitles";
import { clamp } from "./analyze";
import type { Word } from "./whisper";

export type Layout = "blur" | "crop" | "split";
export interface Rect { x: number; y: number; w: number; h: number }

export interface RenderPlan {
  layout: Layout;
  /** 0..1 horizontal action centre in the source. */
  focusX: number;
  blurZoom: number;
  foregroundY: number;
  facecam: Rect | null;
  splitTopRatio: number;
  fps: number;
  crf: number;
  subtitles: { words: Word[]; style: SubtitleStyle } | null;
  audio: { normalize: boolean; targetLufs: number };
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Escapes a value for use inside a single-quoted ffmpeg filter option. */
export function filterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/'/g, "'\\''").replace(/:/g, "\\:");
}

/** Where the gameplay sits in the blur layout (shared by the filter and subtitle placement). */
export function blurGeometry(info: Pick<MediaInfo, "width" | "height">, plan: Pick<RenderPlan, "blurZoom" | "foregroundY">) {
  const fgW = even(OUT_W * plan.blurZoom);
  const fgH = even((fgW * info.height) / info.width);
  const visW = Math.min(fgW, OUT_W);
  const visH = Math.min(fgH, OUT_H);
  const oy = Math.round((OUT_H - visH) * clamp(plan.foregroundY, 0, 1));
  return { fgW, fgH, visW, visH, oy };
}

/**
 * Subtitle centre line. In the blur layout captions go into the blurred band below (or above)
 * the gameplay so they never cover game information; clamped to stay clear of TikTok's UI.
 */
export function subtitleY(info: Pick<MediaInfo, "width" | "height">, plan: RenderPlan, style: SubtitleStyle): number | undefined {
  if (style.centerY) return style.centerY;
  const layout = plan.layout === "split" && !plan.facecam ? "blur" : plan.layout;
  if (layout !== "blur" || style.position === "center") return undefined;
  const { visH, oy } = blurGeometry(info, plan);
  const gap = Math.round(style.fontSize * 1.1);
  if (style.position === "lower") {
    const below = oy + visH + gap;
    return below <= OUT_H - 420 ? below : undefined; // no room below → default position
  }
  const above = oy - gap;
  return above >= 220 ? above : undefined;
}

/** Builds the video part of the filtergraph. Pure function — unit tested. */
export function buildVideoFilter(info: MediaInfo, plan: RenderPlan, assFile: string | null): string {
  const W = OUT_W;
  const H = OUT_H;
  const sw = info.width;
  const sh = info.height;
  const parts: string[] = [];
  let layout = plan.layout;
  if (layout === "split" && !plan.facecam) layout = "blur";

  if (layout === "crop") {
    const cw = Math.min(sw, even((sh * 9) / 16));
    const ch = cw === sw ? Math.min(sh, even((sw * 16) / 9)) : sh;
    const x = even(clamp(plan.focusX * sw - cw / 2, 0, sw - cw));
    const y = even((sh - ch) / 2);
    parts.push(`[0:v]crop=${cw}:${ch}:${x}:${y},scale=${W}:${H}:flags=lanczos,setsar=1[vbase]`);
  } else if (layout === "split") {
    const f = plan.facecam!;
    const fx = even(clamp(f.x, 0, 1) * sw);
    const fy = even(clamp(f.y, 0, 1) * sh);
    const fw = even(Math.min(sw - fx, f.w * sw));
    const fh = even(Math.min(sh - fy, f.h * sh));
    const topH = even(H * plan.splitTopRatio);
    const botH = H - topH;
    const gw = Math.min(sw, even((sh * W) / botH));
    const gx = even(clamp(plan.focusX * sw - gw / 2, 0, sw - gw));
    parts.push(`[0:v]split=2[cam][game]`);
    parts.push(`[cam]crop=${fw}:${fh}:${fx}:${fy},scale=${W}:${topH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${topH},setsar=1[top]`);
    parts.push(`[game]crop=${gw}:${sh}:${gx}:0,scale=${W}:${botH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${botH},setsar=1[bot]`);
    parts.push(`[top][bot]vstack=inputs=2[vbase]`);
  } else {
    // Blurred, darkened full-frame background with the (optionally zoomed) gameplay on top.
    const { fgW, fgH, visW, visH, oy } = blurGeometry(info, plan);
    const cx = even(clamp(plan.focusX * fgW - visW / 2, 0, fgW - visW));
    const cy = even((fgH - visH) / 2);
    parts.push(`[0:v]split=2[bgsrc][fgsrc]`);
    parts.push(`[bgsrc]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=6,eq=brightness=-0.07:saturation=1.15,scale=${W}:${H},setsar=1[bg]`);
    parts.push(`[fgsrc]scale=${fgW}:${fgH}:flags=lanczos,crop=${visW}:${visH}:${cx}:${cy},setsar=1[fg]`);
    parts.push(`[bg][fg]overlay=(W-w)/2:${oy}[vbase]`);
  }
  const tail = [`fps=${plan.fps}`, "format=yuv420p"];
  if (assFile) tail.push(`ass=filename='${filterPath(assFile)}':fontsdir='${filterPath(config.fontsDir)}'`);
  parts.push(`[vbase]${tail.join(",")}[vout]`);
  return parts.join(";");
}

interface LoudnessMeasure { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string }

/** First loudnorm pass. Returns null for silent clips (nothing to normalise). */
export async function measureLoudness(file: string, target: number): Promise<LoudnessMeasure | null> {
  const { stderr } = await run(config.ffmpegPath, ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"], { timeoutMs: 5 * 60_000 });
  const m = stderr.match(/\{[\s\S]*?"target_offset"[\s\S]*?\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]) as LoudnessMeasure;
  if (!Number.isFinite(Number(j.input_i)) || Number(j.input_i) < -60) return null;
  return j;
}

export function buildAudioFilter(plan: RenderPlan, m: LoudnessMeasure | null): string {
  const chain = ["aresample=async=1:first_pts=0"];
  if (plan.audio.normalize && m) {
    chain.push(`loudnorm=I=${plan.audio.targetLufs}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`);
  }
  // Safety limiter so nothing clips even if loudnorm falls back to dynamic mode.
  chain.push("alimiter=limit=0.95:level=disabled", "aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo");
  return `[0:a]${chain.join(",")}[aout]`;
}

export interface RenderResult { file: string; thumb: string; info: MediaInfo; layout: Layout; ffmpegArgs: string[] }

export function targetFps(srcFps: number, setting: "source" | "30" | "60"): number {
  if (setting === "30") return 30;
  // "60" and "source" both follow the source (max 60) — frames are never invented.
  const r = Math.round(srcFps);
  return Math.min(60, Math.max(24, r)); // 50 fps stays 50, 25 stays 25
}

/** Renders the vertical TikTok video and validates the result with ffprobe. */
export async function renderVertical(src: string, info: MediaInfo, plan: RenderPlan, outFile: string, workDir: string): Promise<RenderResult> {
  await fsp.mkdir(workDir, { recursive: true });
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  let assFile: string | null = null;
  if (plan.subtitles && plan.subtitles.words.length) {
    assFile = path.join(workDir, "subs.ass");
    const style = { ...plan.subtitles.style, centerY: subtitleY(info, plan, plan.subtitles.style) };
    await fsp.writeFile(assFile, buildAss(plan.subtitles.words, style, info.duration), "utf8");
  }
  const loud = info.hasAudio && plan.audio.normalize ? await measureLoudness(src, plan.audio.targetLufs) : null;
  const vf = buildVideoFilter(info, plan, assFile);
  const inputs = ["-i", src];
  let af: string;
  if (info.hasAudio) {
    af = buildAudioFilter(plan, loud);
  } else {
    inputs.push("-f", "lavfi", "-t", info.duration.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
    af = "[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo[aout]";
  }
  const tmp = `${outFile}.tmp.mp4`;
  const args = [
    "-hide_banner", "-v", "error", "-y", ...inputs,
    "-filter_complex", `${vf};${af}`,
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "medium", "-crf", String(plan.crf), "-profile:v", "high", "-level:v", plan.fps > 30 ? "4.2" : "4.1",
    "-pix_fmt", "yuv420p", "-g", String(plan.fps * 2), "-r", String(plan.fps),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-t", info.duration.toFixed(3), "-movflags", "+faststart", tmp,
  ];
  await run(config.ffmpegPath, args, { timeoutMs: 20 * 60_000 });
  const out = await probe(tmp);
  const problems: string[] = [];
  if (out.width !== OUT_W || out.height !== OUT_H) problems.push(`opløsning ${out.width}x${out.height}`);
  if (out.videoCodec !== "h264") problems.push(`videocodec ${out.videoCodec}`);
  if (out.audioCodec !== "aac") problems.push(`lydcodec ${out.audioCodec}`);
  if (Math.abs(out.duration - info.duration) > 0.6) problems.push(`varighed ${out.duration.toFixed(2)}s vs kilde ${info.duration.toFixed(2)}s`);
  if (problems.length) throw new Error(`Renderet fil er ugyldig: ${problems.join(", ")}`);
  await fsp.rename(tmp, outFile);
  const thumb = outFile.replace(/\.mp4$/, ".jpg");
  await run(config.ffmpegPath, ["-v", "error", "-y", "-ss", Math.min(1, out.duration / 2).toFixed(2), "-i", outFile, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "5", thumb], { timeoutMs: 60_000 });
  return { file: outFile, thumb, info: out, layout: plan.layout === "split" && !plan.facecam ? "blur" : plan.layout, ffmpegArgs: args };
}
