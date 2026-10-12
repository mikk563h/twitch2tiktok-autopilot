import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { run } from "../proc";
import type { MediaInfo } from "./probe";

export interface MotionAnalysis {
  /** Horizontal centre of on-screen action, 0..1 of frame width. */
  focusX: number;
  /** Vertical centre of on-screen action, 0..1 of frame height. */
  focusY: number;
  /** Share of motion energy inside the best 9:16 window; low = a tight crop would lose action. */
  cropCoverage: number;
  /** Per-column motion energy (normalised), for the editor preview. */
  columns: number[];
  samples: number;
}

const AW = 96;
const AH = 54;

/**
 * Cheap local motion analysis: decode a tiny greyscale version of the clip and accumulate
 * frame differences per column/row. Tells us where gameplay action happens without a GPU.
 */
export async function analyzeMotion(file: string, info: MediaInfo): Promise<MotionAnalysis> {
  const fps = info.duration > 40 ? 2 : 4;
  const { stdout } = await run(config.ffmpegPath, ["-v", "error", "-i", file, "-vf", `fps=${fps},scale=${AW}:${AH}:flags=area,format=gray`, "-f", "rawvideo", "-"], { timeoutMs: 5 * 60_000 });
  const frameSize = AW * AH;
  const n = Math.floor(stdout.length / frameSize);
  const cols = new Float64Array(AW);
  const rows = new Float64Array(AH);
  for (let f = 1; f < n; f++) {
    const a = (f - 1) * frameSize;
    const b = f * frameSize;
    for (let y = 0; y < AH; y++) {
      for (let x = 0; x < AW; x++) {
        const d = Math.abs(stdout[b + y * AW + x] - stdout[a + y * AW + x]);
        if (d < 6) continue; // ignore compression noise
        cols[x] += d;
        rows[y] += d;
      }
    }
  }
  const total = cols.reduce((s, v) => s + v, 0);
  if (n < 2 || total === 0) return { focusX: 0.5, focusY: 0.5, cropCoverage: 1, columns: Array.from(cols), samples: n };

  // Best 9:16 window (in source aspect) by summed column energy.
  const srcAspect = info.width && info.height ? info.width / info.height : 16 / 9;
  const winW = Math.max(1, Math.min(AW, Math.round(AW * ((9 / 16) / srcAspect))));
  let best = 0;
  let bestX = Math.floor((AW - winW) / 2);
  let sum = 0;
  for (let x = 0; x < AW; x++) {
    sum += cols[x];
    if (x >= winW) sum -= cols[x - winW];
    if (x >= winW - 1 && sum > best) {
      best = sum;
      bestX = x - winW + 1;
    }
  }
  // Bias slightly toward centre so near-ties don't pick an edge (HUD/minimap flicker).
  const centreX = (bestX + winW / 2) / AW;
  const focusX = clamp(0.5 + (centreX - 0.5) * 0.85, 0, 1);
  const rowTotal = rows.reduce((s, v) => s + v, 0);
  const focusY = rowTotal ? rows.reduce((s, v, i) => s + v * (i + 0.5), 0) / rowTotal / AH : 0.5;
  const max = Math.max(...cols);
  return { focusX, focusY, cropCoverage: best / total, columns: Array.from(cols, (v) => Math.round((v / max) * 1000) / 1000), samples: n };
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export interface Frame { file: string; t: number }

/** Evenly spaced JPEG frames (skipping the very first/last moments) for the vision model. */
export async function extractFrames(file: string, info: MediaInfo, count: number, outDir: string, width = 768): Promise<Frame[]> {
  await fsp.mkdir(outDir, { recursive: true });
  const frames: Frame[] = [];
  const d = Math.max(0.5, info.duration);
  for (let i = 0; i < count; i++) {
    const t = Math.min(d - 0.1, (d * (i + 0.5)) / count);
    const out = path.join(outDir, `frame-${String(i).padStart(2, "0")}.jpg`);
    await run(config.ffmpegPath, ["-v", "error", "-y", "-ss", t.toFixed(2), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", out], { timeoutMs: 60_000 });
    frames.push({ file: out, t: Math.round(t * 10) / 10 });
  }
  return frames;
}

/** 16 kHz mono WAV for whisper. Returns null when the clip has no audio track. */
export async function extractAudio(file: string, info: MediaInfo, out: string): Promise<string | null> {
  if (!info.hasAudio) return null;
  await run(config.ffmpegPath, ["-v", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out], { timeoutMs: 5 * 60_000 });
  return out;
}
