import fsp from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config";
import { setState } from "../settings";
import type { Frame } from "../media/analyze";
import type { Transcript } from "../media/whisper";

export class AiNotConfigured extends Error {}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!config.anthropicApiKey) throw new AiNotConfigured("ANTHROPIC_API_KEY er ikke sat");
  client ??= new Anthropic({ apiKey: config.anthropicApiKey, baseURL: config.anthropicBaseUrl, maxRetries: 3, timeout: 180_000 });
  return client;
}

const analysisJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["observations", "spoken_summary", "understood", "confidence", "is_funny", "title", "title_evidence", "game", "hashtags", "action_focus_x", "facecam"],
  properties: {
    observations: { type: "string", description: "Faktuel beskrivelse på dansk af hvad der sker visuelt i klippet, frame for frame." },
    spoken_summary: { type: "string", description: "Hvad der bliver sagt (fra transskriptionen), kort. Tom streng hvis intet." },
    understood: { type: "boolean", description: "true hvis du reelt forstår hvad klippet handler om." },
    confidence: { type: "number", description: "0..1 hvor sikker du er på at titlen præcist beskriver klippet." },
    is_funny: { type: "boolean" },
    title: { type: "string", description: "Kort dansk TikTok-titel baseret KUN på verificerbart indhold." },
    title_evidence: { type: "string", description: "Hvilke frames/udsagn titlen bygger på." },
    game: { type: ["string", "null"], description: "Spillets navn hvis det kan ses/udledes, ellers null." },
    hashtags: { type: "array", items: { type: "string" }, description: "Op til 5 relevante hashtags uden #, specifikke for indholdet/spillet." },
    action_focus_x: { type: "number", description: "0..1: vandret position hvor den vigtigste handling foregår." },
    facecam: {
      type: "object",
      additionalProperties: false,
      required: ["present", "x", "y", "w", "h", "confidence"],
      properties: {
        present: { type: "boolean", description: "Er der et webcam-overlay med streameren i ALLE frames på samme sted?" },
        x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
        confidence: { type: "number" },
      },
    },
  },
} as const;

const unit = z.number().transform((n) => Math.min(1, Math.max(0, n)));
export const analysisSchema = z.object({
  observations: z.string(),
  spoken_summary: z.string(),
  understood: z.boolean(),
  confidence: unit,
  is_funny: z.boolean(),
  title: z.string(),
  title_evidence: z.string(),
  game: z.string().nullable(),
  hashtags: z.array(z.string()).max(10),
  action_focus_x: unit,
  facecam: z.object({ present: z.boolean(), x: unit, y: unit, w: unit, h: unit, confidence: unit }),
});
export type ClipAnalysis = z.infer<typeof analysisSchema>;

const verifyJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["supported", "problems"],
  properties: {
    supported: { type: "boolean", description: "true hvis ALT i titlen understøttes af observationerne/transskriptionen." },
    problems: { type: "string", description: "Hvad der ikke kan verificeres, eller tom streng." },
  },
} as const;
const verifySchema = z.object({ supported: z.boolean(), problems: z.string() });

const SYSTEM = `Du er redaktør for en dansk gaming-TikTok-konto der genudgiver Twitch-clips (med tilladelse).
Du får frames fra et clip, en tidskodet transskription og Twitch-metadata. Din opgave er at forstå hvad der FAKTISK sker og skrive en kort, naturlig dansk titel.

Regler for titlen:
- Bygger kun på det der kan ses i frames eller høres i transskriptionen. Opfind aldrig hændelser, resultater, citater eller følelser.
- Kort og naturlig dansk, som en dansk TikTok-bruger ville skrive. Konkret frem for generisk: nævn den faktiske situation (fx et bestemt spil-øjeblik, en replik, en reaktion).
- Må gerne være sjov hvis klippet faktisk er sjovt, men aldrig clickbait der ikke holder.
- Nævn ikke streamerens navn medmindre det er nødvendigt.
- Ingen hashtags i titlen.
- Undgå generiske floskler som "vildeste øjeblik", "gør det igen", "for vildt", "tror ikke dine egne øjne", "endnu et sindssygt clip".
- Hvis du ikke kan forstå klippet ud fra materialet, så sæt understood=false og lav lav confidence — det er bedre end at gætte.

Hashtags: kun tags der er specifikke for indholdet (spil, genre, situation). Ingen generiske tags som fyp/viral.
Facecam: angiv webcam-overlayets rektangel som andele (0..1) af billedbredde/-højde, kun hvis det tydeligt ses samme sted i alle frames.`;

function fmt(t: number) {
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
}

export function transcriptForPrompt(tr: Transcript | null): string {
  if (!tr || !tr.words.length) return "(ingen tale genkendt)";
  const lines: string[] = [];
  let cur: string[] = [];
  let start = tr.words[0].start;
  for (const w of tr.words) {
    if (!cur.length) start = w.start;
    cur.push(w.text);
    if (/[.!?]$/.test(w.text) || cur.length >= 14) {
      lines.push(`[${fmt(start)}] ${cur.join(" ")}`);
      cur = [];
    }
  }
  if (cur.length) lines.push(`[${fmt(start)}] ${cur.join(" ")}`);
  return lines.join("\n");
}

function textOf(msg: Anthropic.Beta.Messages.BetaMessage): string {
  if (msg.stop_reason === "refusal") throw new Error("AI afviste forespørgslen (refusal)");
  if (msg.stop_reason === "max_tokens") throw new Error("AI-svaret blev afskåret (max_tokens)");
  return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

export interface AnalyzeInput {
  frames: Frame[];
  transcript: Transcript | null;
  twitchTitle: string | null;
  gameName: string | null;
  broadcaster: string | null;
  duration: number;
  maxTitleLength: number;
  allowEmoji: boolean;
  recentTitles: string[];
  rejectedTitle?: { title: string; reason: string };
}

export async function analyzeClip(input: AnalyzeInput): Promise<{ analysis: ClipAnalysis; usage: unknown; model: string }> {
  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
  for (const f of input.frames) {
    content.push({ type: "text", text: `Frame ved ${fmt(f.t)}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await fsp.readFile(f.file)).toString("base64") } });
  }
  const lines = [
    `Clip-længde: ${input.duration.toFixed(1)} s`,
    `Original Twitch-titel (skrevet af den der lavede clippet — kun kontekst, kan være misvisende): ${input.twitchTitle || "(ingen)"}`,
    `Spil ifølge Twitch: ${input.gameName || "(ukendt)"}`,
    `Streamer: ${input.broadcaster || "(ukendt)"}`,
    "",
    "Transskription (whisper, kan indeholde fejl):",
    transcriptForPrompt(input.transcript),
    "",
    `Titlen må højst være ${input.maxTitleLength} tegn. ${input.allowEmoji ? "Du må bruge én relevant emoji hvis den passer." : "Brug ingen emojis."}`,
  ];
  if (input.recentTitles.length) lines.push("", "Seneste titler på kontoen (gentag ikke formuleringerne):", ...input.recentTitles.slice(0, 25).map((t) => `- ${t}`));
  if (input.rejectedTitle) lines.push("", `Dit forrige forslag "${input.rejectedTitle.title}" blev afvist: ${input.rejectedTitle.reason}. Lav et andet.`);
  content.push({ type: "text", text: lines.join("\n") });

  const msg = await anthropic().beta.messages.create({
    model: config.aiModel,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: { type: "json_schema", schema: analysisJsonSchema as unknown as Record<string, unknown> } },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  const analysis = analysisSchema.parse(JSON.parse(textOf(msg)));
  await setState("ai.lastOkAt", new Date().toISOString()).catch(() => {});
  return { analysis, usage: msg.usage, model: msg.model };
}

/** Independent text-only check that every claim in the title is supported by the evidence. */
export async function verifyTitle(title: string, a: ClipAnalysis, transcript: Transcript | null, twitchTitle: string | null) {
  const msg = await anthropic().beta.messages.create({
    model: config.aiModel,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: { type: "json_schema", schema: verifyJsonSchema as unknown as Record<string, unknown> } },
    system: "Du er faktatjekker. Afgør om en TikTok-titel kun påstår ting der understøttes af beskrivelsen af videoen og transskriptionen. Humor og overdrivelse i tonen er OK; opdigtede hændelser, citater eller udfald er ikke.",
    messages: [{
      role: "user",
      content: [
        `Titel: ${title}`,
        `Visuel beskrivelse: ${a.observations}`,
        `Tale: ${a.spoken_summary || "(ingen)"}`,
        `Transskription:\n${transcriptForPrompt(transcript)}`,
        `Twitch-titel (kontekst): ${twitchTitle || "(ingen)"}`,
      ].join("\n\n"),
    }],
  });
  return verifySchema.parse(JSON.parse(textOf(msg)));
}

/** Cheap connectivity check for the setup wizard. */
export async function pingAi(): Promise<string> {
  const msg = await anthropic().messages.create({ model: config.aiModel, max_tokens: 2000, output_config: { effort: "low" }, messages: [{ role: "user", content: "Svar kun med: OK" }] });
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  await setState("ai.lastOkAt", new Date().toISOString()).catch(() => {});
  return text;
}
