import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config, paths } from "../config";
import { run } from "../proc";

export interface Word { text: string; start: number; end: number }
export interface Transcript { language: string; text: string; words: Word[]; model: string }

/** Phrases whisper is known to hallucinate on silence/music (notably Danish subtitle credits). */
const HALLUCINATIONS = [
  /undertekst(er)? af/i, /tekstet af/i, /nicolai winther/i, /subtitles by/i, /amara\.org/i,
  /tak fordi (du|i) så med/i, /thanks for watching/i, /please subscribe/i, /www\.\w+\.(dk|com)/i,
];

export function modelPath(name = config.whisperModel): string {
  return path.join(paths.models, `ggml-${name}.bin`);
}

/** Downloads the ggml model on first use (to the persistent data volume). */
export async function ensureModel(name = config.whisperModel): Promise<string> {
  const file = modelPath(name);
  if (fs.existsSync(file)) return file;
  await fsp.mkdir(paths.models, { recursive: true });
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Kunne ikke hente whisper-model ${name}: HTTP ${res.status}`);
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
  await fsp.rename(tmp, file);
  return file;
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{ offsets: { from: number; to: number }; text: string }>;
}

async function runWhisper(wav: string, lang: string, outBase: string): Promise<WhisperJson> {
  const threads = String(Math.max(1, Math.min(8, os.cpus().length - 1)));
  await run(config.whisperBin, [
    "-m", await ensureModel(), "-f", wav, "-l", lang, "-t", threads,
    "-ml", "1", "-sow", "-oj", "-of", outBase, "-np", "-sns",
  ], { timeoutMs: 15 * 60_000 });
  return JSON.parse(await fsp.readFile(`${outBase}.json`, "utf8")) as WhisperJson;
}

/** Joins whisper's word-ish segments into clean words with second-based timestamps. */
export function toWords(j: WhisperJson): Word[] {
  const words: Word[] = [];
  for (const seg of j.transcription ?? []) {
    const raw = seg.text;
    const text = raw.trim();
    if (!text || /^\[.*\]$|^\(.*\)$|^♪+$/.test(text)) continue;
    const start = seg.offsets.from / 1000;
    const end = Math.max(start + 0.05, seg.offsets.to / 1000);
    // A segment without a leading space continues the previous word (sub-word token).
    if (words.length && !/^\s/.test(raw) && !/^[.,!?…]/.test(text)) {
      const w = words[words.length - 1];
      w.text += text;
      w.end = end;
    } else if (words.length && /^[.,!?…:;]+$/.test(text)) {
      words[words.length - 1].text += text;
    } else {
      words.push({ text, start, end });
    }
  }
  return words;
}

export function cleanTranscript(words: Word[]): Word[] {
  const text = words.map((w) => w.text).join(" ");
  if (HALLUCINATIONS.some((r) => r.test(text)) && words.length < 25) return [];
  return words;
}

/**
 * Transcribes with whisper.cpp. With language "auto" whisper detects it; anything other
 * than Danish/English is re-run as Danish (the channel's main language).
 */
export async function transcribe(wav: string, language: "auto" | "da" | "en", workDir: string): Promise<Transcript> {
  await fsp.mkdir(workDir, { recursive: true });
  let j = await runWhisper(wav, language, path.join(workDir, "whisper"));
  let lang = j.result?.language ?? language;
  if (language === "auto" && lang !== "da" && lang !== "en") {
    j = await runWhisper(wav, "da", path.join(workDir, "whisper-da"));
    lang = "da";
  }
  const words = cleanTranscript(toWords(j));
  return { language: lang, text: words.map((w) => w.text).join(" "), words, model: config.whisperModel };
}
