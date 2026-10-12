/**
 * Dev tool: renders a local video with every layout so the output can be inspected.
 * Usage: npx tsx scripts/render-sample.ts <input.mp4> <outDir>
 */
import path from "node:path";
import fs from "node:fs";
import { probe } from "@/lib/media/probe";
import { analyzeMotion, extractAudio } from "@/lib/media/analyze";
import { transcribe } from "@/lib/media/whisper";
import { renderVertical, type RenderPlan } from "@/lib/media/render";
import { run } from "@/lib/proc";
import { config } from "@/lib/config";

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) throw new Error("Brug: tsx scripts/render-sample.ts <input.mp4> <outDir>");
fs.mkdirSync(outDir, { recursive: true });
const info = await probe(input);
const motion = await analyzeMotion(input, info);
const wav = await extractAudio(input, info, path.join(outDir, "a.wav"));
const tr = wav ? await transcribe(wav, "auto", path.join(outDir, "w")) : null;
console.log("motion focusX", motion.focusX.toFixed(2), "transcript:", tr?.text);
for (const layout of ["blur", "crop", "split"] as const) {
  const plan: RenderPlan = {
    layout, focusX: motion.focusX, blurZoom: 1.2, foregroundY: 0.5, facecam: layout === "split" ? { x: 0.78, y: 0.037, w: 0.198, h: 0.26 } : null,
    splitTopRatio: 0.36, fps: 30, crf: 23, audio: { normalize: true, targetLufs: -14 },
    subtitles: tr?.words.length ? { words: tr.words, style: { fontName: "Montserrat ExtraBold", fontSize: 78, position: layout === "split" ? "center" : "lower", centerY: layout === "split" ? 691 : undefined, highlight: true, highlightColor: "#FFD43B", uppercase: false, maxWordsPerLine: 3 } } : null,
  };
  const file = path.join(outDir, `${layout}.mp4`);
  await renderVertical(input, info, plan, file, path.join(outDir, `work-${layout}`));
  await run(config.ffmpegPath, ["-v", "error", "-y", "-ss", "2.0", "-i", file, "-frames:v", "1", "-vf", "scale=360:-2", path.join(outDir, `${layout}.png`)]);
  console.log("rendered", file);
}
