import { z } from "zod";
import { sql } from "./db";

const rect = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.02).max(1), h: z.number().min(0.02).max(1) });

export const DEFAULT_FORBIDDEN_TITLES = [
  "SondergaardLOL's vildeste øjeblik",
  "SondergaardLOL gør det igen",
  "Endnu et sindssygt clip",
  "Det her er for vildt",
  "Du tror ikke dine egne øjne",
];

export const settingsSchema = z.object({
  automation: z.object({
    monitorEnabled: z.boolean().default(false),
    autoEdit: z.boolean().default(true),
    autoPublish: z.boolean().default(false),
    pollIntervalSec: z.number().int().min(30).max(3600).default(60),
    overlapMinutes: z.number().int().min(5).max(240).default(30),
    deepScanEveryHours: z.number().int().min(1).max(48).default(6),
    deepScanLookbackHours: z.number().int().min(6).max(24 * 14).default(72),
    maxPostsPer24h: z.number().int().min(1).max(50).default(8),
    minMinutesBetweenPosts: z.number().int().min(0).max(24 * 60).default(45),
    /**
     * best: each free posting slot takes the clip with the most Twitch views among all clips since
     * the previous post; the rest are skipped. newest: the most recent clip. all: everything, oldest first.
     */
    selection: z.enum(["best", "newest", "all"]).default("best"),
  }).prefault({}),
  twitch: z.object({
    downloadMethod: z.enum(["auto", "official", "public"]).default("auto"),
  }).prefault({}),
  editor: z.object({
    layout: z.enum(["auto", "blur", "crop", "split"]).default("blur"),
    // 1.0 = the whole source frame is always visible (nothing cropped).
    blurZoom: z.number().min(1).max(2).default(1),
    foregroundY: z.number().min(0).max(1).default(0.5),
    cropMode: z.enum(["smart", "center"]).default("smart"),
    facecamMode: z.enum(["auto", "manual", "off"]).default("auto"),
    facecamRect: rect.nullable().default(null),
    splitTopRatio: z.number().min(0.2).max(0.5).default(0.36),
    fps: z.enum(["source", "30", "60"]).default("source"),
    crf: z.number().int().min(16).max(30).default(20),
    subtitles: z.object({
      enabled: z.boolean().default(true),
      language: z.enum(["auto", "da", "en"]).default("auto"),
      fontSize: z.number().int().min(40).max(140).default(78),
      position: z.enum(["upper", "center", "lower"]).default("lower"),
      highlight: z.boolean().default(true),
      highlightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFD43B"),
      uppercase: z.boolean().default(false),
      maxWordsPerLine: z.number().int().min(1).max(6).default(3),
    }).prefault({}),
    audio: z.object({
      normalize: z.boolean().default(true),
      targetLufs: z.number().min(-24).max(-9).default(-14),
    }).prefault({}),
  }).prefault({}),
  ai: z.object({
    enabled: z.boolean().default(true),
    titleMaxLength: z.number().int().min(20).max(150).default(70),
    emoji: z.boolean().default(false),
    confidenceThreshold: z.number().min(0).max(1).default(0.6),
    frameCount: z.number().int().min(3).max(16).default(8),
    verifyTitle: z.boolean().default(true),
    forbiddenTitles: z.array(z.string()).default(DEFAULT_FORBIDDEN_TITLES),
  }).prefault({}),
  hashtags: z.object({
    fixed: z.array(z.string()).default(["sondergaard", "twitchdk", "danskstreamer"]),
    aiEnabled: z.boolean().default(true),
    maxTotal: z.number().int().min(0).max(30).default(6),
    captionMaxLength: z.number().int().min(100).max(2200).default(2200),
  }).prefault({}),
  tiktok: z.object({
    mode: z.enum(["direct", "inbox", "manual"]).default("direct"),
    privacyLevel: z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]).nullable().default(null),
    allowComment: z.boolean().default(false),
    allowDuet: z.boolean().default(false),
    allowStitch: z.boolean().default(false),
    brandContent: z.boolean().default(false),
    brandOrganic: z.boolean().default(false),
    isAigc: z.boolean().default(false),
    appAudited: z.boolean().default(false),
    consentAt: z.string().nullable().default(null),
    musicConfirmationAt: z.string().nullable().default(null),
  }).prefault({}),
  setup: z.object({
    completedAt: z.string().nullable().default(null),
    rightsConfirmedAt: z.string().nullable().default(null),
    rightsConfirmedBy: z.string().nullable().default(null),
    testClipId: z.number().int().nullable().default(null),
  }).prefault({}),
  retention: z.object({
    sourceDaysAfterPublish: z.number().int().min(0).max(365).default(2),
    renderDaysAfterPublish: z.number().int().min(0).max(365).default(14),
    minFreeDiskGb: z.number().min(1).max(500).default(5),
  }).prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsSection = keyof Settings;

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

export async function getSettings(): Promise<Settings> {
  const rows = await sql()`SELECT key, value FROM settings`;
  const raw: Record<string, unknown> = {};
  for (const r of rows) raw[r.key as string] = r.value;
  const parsed = settingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // A section that no longer validates (e.g. after a schema change) falls back to defaults
  // section by section instead of taking the whole system down.
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(settingsSchema.shape) as SettingsSection[]) {
    const r = settingsSchema.shape[key].safeParse(raw[key] ?? {});
    out[key] = r.success ? r.data : settingsSchema.shape[key].parse({});
  }
  return out as Settings;
}

export async function updateSettings<K extends SettingsSection>(section: K, patch: Partial<Settings[K]>): Promise<Settings[K]> {
  const current = (await getSettings())[section];
  const next = settingsSchema.shape[section].parse({ ...current, ...patch }) as Settings[K];
  const db = sql();
  await db`INSERT INTO settings (key, value, updated_at) VALUES (${section}, ${db.json(next as never)}, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return next;
}

export async function getState<T>(key: string): Promise<T | null> {
  const [row] = await sql()`SELECT value FROM kv_state WHERE key = ${key}`;
  return row ? (row.value as T) : null;
}

export async function setState(key: string, value: unknown): Promise<void> {
  const db = sql();
  await db`INSERT INTO kv_state (key, value, updated_at) VALUES (${key}, ${db.json(value as never)}, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
