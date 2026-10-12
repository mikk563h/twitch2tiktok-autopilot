import type { Word } from "./whisper";

export interface SubtitleStyle {
  fontName: string;
  fontSize: number;
  position: "upper" | "center" | "lower";
  highlight: boolean;
  highlightColor: string; // #RRGGBB
  uppercase: boolean;
  maxWordsPerLine: number;
  /** Optional explicit vertical centre in px (e.g. the seam in the split layout). */
  centerY?: number;
}

export const OUT_W = 1080;
export const OUT_H = 1920;

/** #RRGGBB -> ASS &H00BBGGRR */
export function assColor(hex: string): string {
  const h = hex.replace("#", "");
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

function ts(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const whole = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(cs === 100 ? whole + 1 : whole).padStart(2, "0")}.${String(cs === 100 ? 0 : cs).padStart(2, "0")}`;
}

function esc(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[{}]/g, "").replace(/\n/g, " ");
}

/** Groups words into short TikTok-style lines: break on word count, length, pauses and sentence ends. */
export function chunkWords(words: Word[], maxWords: number, maxChars = 22): Word[][] {
  const chunks: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const len = cur.reduce((s, x) => s + x.text.length + 1, 0) + w.text.length;
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length && (cur.length >= maxWords || len > maxChars || gap > 0.7)) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
    if (/[.!?…]$/.test(w.text)) {
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function yFor(style: SubtitleStyle): number {
  if (style.centerY) return style.centerY;
  return style.position === "upper" ? Math.round(OUT_H * 0.24) : style.position === "center" ? Math.round(OUT_H * 0.5) : Math.round(OUT_H * 0.69);
}

/** Builds an ASS subtitle file. With highlight on, the spoken word is coloured and popped. */
export function buildAss(words: Word[], style: SubtitleStyle, duration: number): string {
  const y = yFor(style);
  const hl = assColor(style.highlightColor);
  const outline = Math.max(4, Math.round(style.fontSize / 11));
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${OUT_W}`,
    `PlayResY: ${OUT_H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Main,${style.fontName},${style.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,${outline},3,5,60,60,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events: string[] = [];
  const chunks = chunkWords(words, style.maxWordsPerLine);
  chunks.forEach((chunk, ci) => {
    const next = chunks[ci + 1];
    const chunkStart = chunk[0].start;
    let chunkEnd = Math.max(chunk[chunk.length - 1].end, chunkStart + 0.45);
    if (next && next[0].start - chunkEnd < 0.35) chunkEnd = next[0].start;
    chunkEnd = Math.min(chunkEnd, duration);
    const texts = chunk.map((w) => esc(style.uppercase ? w.text.toUpperCase() : w.text));
    const pos = `{\\an5\\pos(${OUT_W / 2},${y})}`;
    if (!style.highlight) {
      events.push(`Dialogue: 0,${ts(chunkStart)},${ts(chunkEnd)},Main,,0,0,0,,${pos}${texts.join(" ")}`);
      return;
    }
    chunk.forEach((w, wi) => {
      const start = wi === 0 ? chunkStart : w.start;
      const end = wi === chunk.length - 1 ? chunkEnd : chunk[wi + 1].start;
      if (end - start < 0.02) return;
      const line = texts.map((t, ti) => (ti === wi ? `{\\c${hl}&\\fscx108\\fscy108}${t}{\\c&H00FFFFFF&\\fscx100\\fscy100}` : t)).join(" ");
      events.push(`Dialogue: 0,${ts(start)},${ts(end)},Main,,0,0,0,,${pos}${line}`);
    });
  });
  return [...header, ...events, ""].join("\n");
}
