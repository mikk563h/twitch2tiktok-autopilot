/** Real FFmpeg + real whisper.cpp — no mocks. */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTestClip } from "./helpers";
import { probe } from "@/lib/media/probe";
import { analyzeMotion, extractAudio, extractFrames } from "@/lib/media/analyze";
import { renderVertical, buildVideoFilter, measureLoudness, subtitleY, blurGeometry, targetFps, type RenderPlan } from "@/lib/media/render";
import { transcribe, toWords } from "@/lib/media/whisper";
import { buildAss, chunkWords } from "@/lib/media/subtitles";

const out = () => path.join(process.env.DATA_DIR!, "test-out");
const words = [
  { text: "Hej", start: 0.2, end: 0.5 }, { text: "allesammen.", start: 0.5, end: 1.1 },
  { text: "Nu", start: 1.4, end: 1.6 }, { text: "skal", start: 1.6, end: 1.8 }, { text: "vi", start: 1.8, end: 1.9 }, { text: "spille", start: 1.9, end: 2.3 },
];
const basePlan: RenderPlan = {
  layout: "blur", focusX: 0.5, blurZoom: 1.2, foregroundY: 0.5, facecam: null, splitTopRatio: 0.36, fps: 60, crf: 23,
  subtitles: { words, style: { fontName: "Montserrat ExtraBold", fontSize: 78, position: "lower", highlight: true, highlightColor: "#FFD43B", uppercase: false, maxWordsPerLine: 3 } },
  audio: { normalize: true, targetLufs: -14 },
};

let clip: string;
beforeAll(() => {
  clip = makeTestClip({ seconds: 6 });
  fs.mkdirSync(out(), { recursive: true });
});

describe("FFmpeg-editor (rigtig rendering)", () => {
  it("probe læser kildevideoen", async () => {
    const info = await probe(clip);
    expect(info).toMatchObject({ width: 1920, height: 1080, hasAudio: true });
    expect(info.fps).toBeCloseTo(60, 0);
  });

  it.each(["blur", "crop", "split"] as const)("renderer %s-layout til gyldig 1080x1920 H.264/AAC MP4", async (layout) => {
    const info = await probe(clip);
    const plan = { ...basePlan, layout, facecam: layout === "split" ? { x: 0.78, y: 0.037, w: 0.198, h: 0.26 } : null };
    const file = path.join(out(), `out-${layout}.mp4`);
    const r = await renderVertical(clip, info, plan, file, path.join(out(), `work-${layout}`));
    const o = await probe(r.file);
    expect(o).toMatchObject({ width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac", hasAudio: true });
    expect(o.fps).toBeCloseTo(60, 0);
    expect(Math.abs(o.duration - info.duration)).toBeLessThan(0.3);
    expect(o.pixFmt).toBe("yuv420p");
    expect(fs.existsSync(r.thumb)).toBe(true);
  });

  it("normaliserer lyd til ca. -14 LUFS uden clipping", async () => {
    const file = path.join(out(), "out-blur.mp4");
    const m = await measureLoudness(file, -14);
    expect(m).not.toBeNull();
    expect(Number(m!.input_i)).toBeGreaterThan(-16.5);
    expect(Number(m!.input_i)).toBeLessThan(-11.5);
    expect(Number(m!.input_tp)).toBeLessThanOrEqual(-0.3);
  });

  it("klip uden lydspor får et stille AAC-spor (TikTok kræver lyd)", async () => {
    const silent = makeTestClip({ seconds: 4, audio: false });
    const info = await probe(silent);
    expect(info.hasAudio).toBe(false);
    const r = await renderVertical(silent, info, { ...basePlan, subtitles: null, fps: 30 }, path.join(out(), "silent.mp4"), path.join(out(), "work-silent"));
    expect(r.info).toMatchObject({ width: 1080, height: 1920, hasAudio: true, audioCodec: "aac" });
    expect(r.info.fps).toBeCloseTo(30, 0);
  });

  it("split uden facecam falder tilbage til sløret layout", () => {
    const f = buildVideoFilter({ width: 1920, height: 1080, fps: 60, duration: 5, videoCodec: "h264", audioCodec: "aac", hasAudio: true, sizeBytes: 1 }, { ...basePlan, layout: "split", facecam: null }, null);
    expect(f).toContain("gblur");
    expect(f).not.toContain("vstack");
  });

  it("bevægelsesanalyse finder handlingens position", async () => {
    const info = await probe(clip);
    const m = await analyzeMotion(clip, info);
    expect(m.samples).toBeGreaterThan(10);
    expect(m.focusX).toBeGreaterThanOrEqual(0);
    expect(m.focusX).toBeLessThanOrEqual(1);
  });

  it("udtrækker frames til AI-analysen", async () => {
    const info = await probe(clip);
    const frames = await extractFrames(clip, info, 5, path.join(out(), "frames"));
    expect(frames).toHaveLength(5);
    for (const f of frames) expect(fs.statSync(f.file).size).toBeGreaterThan(5000);
    expect(frames[0].t).toBeLessThan(frames[4].t);
  });
});

describe("undertekster", () => {
  it("i sløret layout placeres de under gameplayet, ikke ovenpå", () => {
    const info = { width: 1920, height: 1080 };
    const g = blurGeometry(info, basePlan);
    const y = subtitleY(info, basePlan, basePlan.subtitles!.style)!;
    expect(y).toBeGreaterThan(g.oy + g.visH);
    expect(y).toBeLessThanOrEqual(1920 - 420);
    expect(subtitleY(info, { ...basePlan, layout: "crop" }, basePlan.subtitles!.style)).toBeUndefined();
  });
  it("framerate følger kilden og opfinder aldrig frames", () => {
    expect(targetFps(50, "source")).toBe(50);
    expect(targetFps(59.94, "60")).toBe(60);
    expect(targetFps(25, "source")).toBe(25);
    expect(targetFps(60, "30")).toBe(30);
  });
  it("grupperer ord i korte linjer og bryder ved sætningsslut", () => {
    const chunks = chunkWords(words, 3);
    expect(chunks[0].map((w) => w.text)).toEqual(["Hej", "allesammen."]);
    expect(chunks.every((c) => c.length <= 3)).toBe(true);
  });
  it("ASS-fil har fremhævning af aktivt ord", () => {
    const ass = buildAss(words, basePlan.subtitles!.style, 6);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toMatch(/\\c&H003BD4FF&/);
    expect(ass.split("\n").filter((l) => l.startsWith("Dialogue:")).length).toBe(words.length);
  });
});

describe("speech-to-text (whisper.cpp, rigtig model)", () => {
  const bin = process.env.WHISPER_BIN!;
  it.skipIf(!fs.existsSync(bin))("transskriberer dansk tale med ord-tidskoder", async () => {
    const info = await probe(clip);
    const wav = await extractAudio(clip, info, path.join(out(), "audio.wav"));
    const tr = await transcribe(wav!, "da", path.join(out(), "whisper"));
    const text = tr.text.toLowerCase();
    expect(tr.language).toBe("da");
    expect(tr.words.length).toBeGreaterThan(5);
    expect(text).toMatch(/hej|alle|spille|counter|runden|vinder/);
    for (let i = 1; i < tr.words.length; i++) expect(tr.words[i].start).toBeGreaterThanOrEqual(tr.words[i - 1].start);
  });

  it("samler whisper-tokens til hele ord", () => {
    const w = toWords({ transcription: [
      { offsets: { from: 0, to: 300 }, text: " Counter" }, { offsets: { from: 300, to: 500 }, text: "-Strike" },
      { offsets: { from: 600, to: 900 }, text: " er" }, { offsets: { from: 900, to: 950 }, text: "." },
    ] });
    expect(w.map((x) => x.text)).toEqual(["Counter-Strike", "er."]);
  });
});
