"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { getSettings, updateSettings, type Settings } from "@/lib/settings";
import { sql } from "@/lib/db";
import { addEvent, getClip, resumeStatusFor } from "@/lib/clips";
import { enqueueClip, requestJob } from "@/lib/queue";
import { record, errMsg } from "@/lib/log";
import { deleteToken } from "@/lib/tokens";
import { requestRerender, type RenderOverrides } from "@/lib/pipeline/process";
import { resolveUserAction, uploadBlocker } from "@/lib/pipeline/upload";
import { syncSchedulers } from "@/lib/pipeline/maintenance";
import { normalizeTag } from "@/lib/ai/titles";
import { pingAi } from "@/lib/ai/claude";
import { getUserByLogin, getClipDownloadUrls } from "@/lib/twitch/api";
import { officialDownloadAvailable } from "@/lib/twitch/download";
import { creatorInfo } from "@/lib/tiktok/api";
import { patchTikTokRuntime } from "@/lib/tiktok/state";
import { sendEmail, emailConfigured } from "@/lib/notify";
import { config } from "@/lib/config";
import type { ActionResult } from "@/components/client";

const on = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";
const num = (fd: FormData, k: string) => Number(fd.get(k));
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

async function guard<T>(fn: () => Promise<T>, okMessage: string | ((r: T) => string), paths: string[] = []): Promise<ActionResult> {
  try {
    await requireSession();
    const r = await fn();
    for (const p of paths) revalidatePath(p);
    revalidatePath("/", "layout");
    return { ok: true, message: typeof okMessage === "function" ? okMessage(r) : okMessage };
  } catch (err) {
    return { ok: false, message: errMsg(err).replace(/^\[.*?\]\s*/, "") };
  }
}

// ---------- Settings ----------

export async function saveAutomation(_: ActionResult, fd: FormData) {
  return guard(async () => {
    const s = await getSettings();
    const autoPublish = on(fd, "autoPublish");
    if (autoPublish && !s.setup.rightsConfirmedAt) throw new Error("Bekræft rettighederne i Setup Wizard, før automatisk publicering kan slås til");
    if (autoPublish && s.tiktok.mode !== "manual" && (!s.tiktok.consentAt || !s.tiktok.musicConfirmationAt)) throw new Error("Giv samtykke under Accounts → TikTok publiceringsindstillinger først");
    await updateSettings("automation", {
      monitorEnabled: on(fd, "monitorEnabled"), autoEdit: on(fd, "autoEdit"), autoPublish,
      pollIntervalSec: num(fd, "pollIntervalSec"), maxPostsPer24h: num(fd, "maxPostsPer24h"), minMinutesBetweenPosts: num(fd, "minMinutesBetweenPosts"),
      overlapMinutes: num(fd, "overlapMinutes"), deepScanEveryHours: num(fd, "deepScanEveryHours"), deepScanLookbackHours: num(fd, "deepScanLookbackHours"),
    });
    await updateSettings("twitch", { downloadMethod: str(fd, "downloadMethod") as Settings["twitch"]["downloadMethod"] });
    await updateSettings("retention", { sourceDaysAfterPublish: num(fd, "sourceDaysAfterPublish"), renderDaysAfterPublish: num(fd, "renderDaysAfterPublish"), minFreeDiskGb: num(fd, "minFreeDiskGb") });
    await syncSchedulers();
    await record("info", "settings", "Automation-indstillinger gemt");
  }, "Automation-indstillinger gemt", ["/automation"]);
}

export async function saveHashtags(_: ActionResult, fd: FormData) {
  return guard(async () => {
    const raw = str(fd, "fixed").split(",").map((t) => t.trim()).filter(Boolean);
    const invalid = raw.filter((t) => !normalizeTag(t));
    if (invalid.length) throw new Error(`Ugyldige hashtags: ${invalid.map((t) => `#${t}`).join(", ")} (kun bogstaver, tal og _; 2–50 tegn)`);
    const seen = new Set<string>();
    const fixed = raw.map((t) => normalizeTag(t)!).filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
    await updateSettings("hashtags", { fixed, aiEnabled: on(fd, "aiEnabled"), maxTotal: num(fd, "maxTotal"), captionMaxLength: num(fd, "captionMaxLength") });
  }, "Hashtags gemt — gælder for alle clips der ikke er uploadet endnu", ["/hashtags"]);
}

export async function saveEditor(_: ActionResult, fd: FormData) {
  return guard(async () => {
    const rectOn = str(fd, "facecamMode") === "manual";
    await updateSettings("editor", {
      layout: str(fd, "layout") as Settings["editor"]["layout"],
      blurZoom: num(fd, "blurZoom"), foregroundY: num(fd, "foregroundY"),
      cropMode: str(fd, "cropMode") as Settings["editor"]["cropMode"],
      facecamMode: str(fd, "facecamMode") as Settings["editor"]["facecamMode"],
      facecamRect: rectOn ? { x: num(fd, "fx"), y: num(fd, "fy"), w: num(fd, "fw"), h: num(fd, "fh") } : (await getSettings()).editor.facecamRect,
      splitTopRatio: num(fd, "splitTopRatio"),
      fps: str(fd, "fps") as Settings["editor"]["fps"], crf: num(fd, "crf"),
      subtitles: {
        enabled: on(fd, "subsEnabled"), language: str(fd, "subsLanguage") as "auto" | "da" | "en", fontSize: num(fd, "fontSize"),
        position: str(fd, "subsPosition") as "upper" | "center" | "lower", highlight: on(fd, "highlight"), highlightColor: str(fd, "highlightColor"),
        uppercase: on(fd, "uppercase"), maxWordsPerLine: num(fd, "maxWordsPerLine"),
      },
      audio: { normalize: on(fd, "normalize"), targetLufs: num(fd, "targetLufs") },
    });
  }, "Editor-standarder gemt (gælder nye renders)", ["/editor"]);
}

export async function saveAi(_: ActionResult, fd: FormData) {
  return guard(async () => {
    await updateSettings("ai", {
      enabled: on(fd, "aiEnabled"), titleMaxLength: num(fd, "titleMaxLength"), emoji: on(fd, "emoji"),
      confidenceThreshold: num(fd, "confidenceThreshold"), frameCount: num(fd, "frameCount"), verifyTitle: on(fd, "verifyTitle"),
      forbiddenTitles: str(fd, "forbiddenTitles").split("\n").map((l) => l.trim()).filter(Boolean),
    });
  }, "AI-indstillinger gemt", ["/editor"]);
}

export async function saveTikTokSettings(_: ActionResult, fd: FormData) {
  return guard(async () => {
    const s = await getSettings();
    const mode = str(fd, "mode") as Settings["tiktok"]["mode"];
    const privacy = str(fd, "privacyLevel");
    if (mode === "direct" && !privacy) throw new Error("Vælg en synlighed — TikTok kræver at du selv vælger (der er ingen standard)");
    const consent = on(fd, "consent");
    const music = on(fd, "musicConfirmation");
    if (mode !== "manual" && (!consent || !music)) throw new Error("Du skal give samtykke og acceptere TikToks Music Usage Confirmation for at publicere via API");
    const brandContent = on(fd, "brandContent");
    if (brandContent && privacy === "SELF_ONLY") throw new Error("Branded content kan ikke være privat (SELF_ONLY) ifølge TikTok");
    const changed = privacy !== (s.tiktok.privacyLevel ?? "") || mode !== s.tiktok.mode;
    await updateSettings("tiktok", {
      mode, privacyLevel: (privacy || null) as Settings["tiktok"]["privacyLevel"],
      allowComment: on(fd, "allowComment"), allowDuet: on(fd, "allowDuet"), allowStitch: on(fd, "allowStitch"),
      brandContent, brandOrganic: on(fd, "brandOrganic"), isAigc: on(fd, "isAigc"), appAudited: on(fd, "appAudited"),
      consentAt: consent ? s.tiktok.consentAt && !changed ? s.tiktok.consentAt : new Date().toISOString() : null,
      musicConfirmationAt: music ? s.tiktok.musicConfirmationAt ?? new Date().toISOString() : null,
    });
    if (on(fd, "appAudited") && !s.tiktok.appAudited) await patchTikTokRuntime({ unauditedSeenAt: undefined });
    await record("info", "settings", `TikTok-publiceringsindstillinger gemt (${mode}, ${privacy || "–"})`);
  }, "TikTok-publiceringsindstillinger gemt", ["/accounts"]);
}

export async function confirmRights(_: ActionResult, fd: FormData) {
  return guard(async () => {
    if (!on(fd, "confirm")) throw new Error("Sæt flueben for at bekræfte");
    const name = str(fd, "name");
    if (name.length < 2) throw new Error("Skriv dit navn");
    await updateSettings("setup", { rightsConfirmedAt: new Date().toISOString(), rightsConfirmedBy: name });
    await record("info", "setup", `Rettigheder bekræftet af ${name} for kanalen ${config.twitchChannel}`);
  }, "Rettigheder bekræftet", ["/setup"]);
}

export async function completeSetup(_: ActionResult, fd: FormData) {
  return guard(async () => {
    const s = await getSettings();
    if (!s.setup.rightsConfirmedAt) throw new Error("Rettighedsbekræftelsen mangler");
    await updateSettings("setup", { completedAt: new Date().toISOString() });
    if (on(fd, "enableMonitor")) await updateSettings("automation", { monitorEnabled: true, autoEdit: true });
    await syncSchedulers();
  }, "Opsætning gennemført — overvågningen kører nu", ["/setup"]);
}

// ---------- Clip actions ----------

export async function retryClip(_: ActionResult, fd: FormData) {
  return guard(async () => {
    const id = num(fd, "id");
    const c = await getClip(id);
    if (!c) throw new Error("Clip findes ikke");
    if (!["FAILED", "RETRY_WAIT", "BLOCKED_PERMISSION", "NEEDS_USER_ACTION"].includes(c.status)) throw new Error("Clippet kan ikke genstartes i sin nuværende status");
    if (c.status === "NEEDS_USER_ACTION" && c.tiktok_publish_id) throw new Error("Dette clip har en TikTok-upload. Brug 'Publiceret'/'Ikke publiceret'-knapperne så vi aldrig dobbeltposter.");
    const to = resumeStatusFor(c.retry_stage, c);
    await sql()`UPDATE clips SET status = ${to}, attempts = 0, next_retry_at = NULL, last_error = NULL, status_reason = NULL, updated_at = now() WHERE id = ${id}`;
    await addEvent(id, "Manuel retry fra dashboardet", { from: c.status, to });
    if (to === "READY") await enqueueClip("upload", id);
    else if (to === "PROCESSING") await enqueueClip("status", id);
    else await enqueueClip("process", id);
  }, "Clippet er sat i kø igen", ["/queue", "/clips"]);
}

export async function rerenderClip(_: ActionResult, fd: FormData) {
  return guard(async () => {
    const id = num(fd, "id");
    const layout = str(fd, "layout") as RenderOverrides["layout"];
    const ov: RenderOverrides = { layout };
    if (str(fd, "focusX")) ov.focusX = num(fd, "focusX");
    if (str(fd, "blurZoom")) ov.blurZoom = num(fd, "blurZoom");
    if (str(fd, "foregroundY")) ov.foregroundY = num(fd, "foregroundY");
    ov.subtitles = on(fd, "subtitles");
    if (on(fd, "useFacecam")) ov.facecamRect = { x: num(fd, "fx"), y: num(fd, "fy"), w: num(fd, "fw"), h: num(fd, "fh") };
    const title = fd.has("manualTitle") ? str(fd, "manualTitle") : undefined;
    const s = await getSettings();
    if (title && [...title].length > s.ai.titleMaxLength * 2) throw new Error("Titlen er for lang");
    await requestRerender(id, ov, title === undefined ? undefined : title || null);
  }, "Genrendering sat i kø", ["/clips"]);
}

export async function queueClip(_: ActionResult, fd: FormData) {
  return guard(async () => {
    const id = num(fd, "id");
    const rows = await sql()`UPDATE clips SET status = 'QUEUED', origin = 'manual', updated_at = now() WHERE id = ${id} AND status = 'BASELINE' RETURNING id`;
    if (!rows.length) throw new Error("Kun historiske (baseline) clips kan sættes i kø her");
    await addEvent(id, "Sat i kø manuelt", { from: "BASELINE", to: "QUEUED" });
    await enqueueClip("process", id);
  }, "Clippet behandles nu", ["/clips"]);
}

export async function uploadNow(_: ActionResult, fd: FormData) {
  return guard(async () => {
    const id = num(fd, "id");
    const c = await getClip(id);
    if (c?.status !== "READY") throw new Error("Clippet er ikke klar");
    const blocker = await uploadBlocker(await getSettings());
    if (blocker) throw new Error(blocker.reason);
    await sql()`UPDATE clips SET next_retry_at = NULL WHERE id = ${id}`;
    await requestJob({ name: "upload-now", clipId: id });
  }, "Upload bestilt — følg status i køen", ["/queue"]);
}

export async function resolveAction(_: ActionResult, fd: FormData) {
  return guard(async () => {
    await resolveUserAction(num(fd, "id"), str(fd, "outcome") === "published" ? "published" : "not_published", str(fd, "url") || undefined);
  }, "Gemt", ["/queue"]);
}

// ---------- Monitoring ----------

export async function scanNow(_: ActionResult) {
  return guard(async () => requestJob({ name: "scan-now" }),
    (r) => config.runMode === "workers" ? "Scanning startet — resultatet vises om et øjeblik" : r.triggered ? "GitHub-kørsel startet — resultatet vises om 1–3 minutter" : "Bestilt — køres ved næste planlagte kørsel (GITHUB_TOKEN er ikke sat, så den kan ikke startes med det samme)", ["/"]);
}

export async function historicalImport(_: ActionResult, fd: FormData) {
  return guard(async () => {
    const start = new Date(str(fd, "start"));
    const end = new Date(str(fd, "end"));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error("Ugyldigt datointerval");
    end.setHours(23, 59, 59, 999);
    await requestJob({ name: "historical", start: start.toISOString(), end: end.toISOString() });
  }, "Historisk import bestilt — clips i perioden registreres og sættes i kø", ["/automation"]);
}

// ---------- Accounts & tests ----------

export async function disconnect(_: ActionResult, fd: FormData) {
  return guard(async () => {
    const p = str(fd, "provider");
    if (p !== "twitch_user" && p !== "tiktok") throw new Error("Ukendt udbyder");
    await deleteToken(p);
    await record("warn", "oauth", `${p} afbrudt fra dashboardet`);
  }, "Forbindelsen er fjernet", ["/accounts"]);
}

export async function testTwitch(_: ActionResult) {
  return guard(async () => {
    const u = await getUserByLogin(config.twitchChannel);
    if (!u) throw new Error(`Kanalen ${config.twitchChannel} findes ikke`);
    return u;
  }, (u) => `Twitch API virker: fandt ${u.display_name} (id ${u.id})`, ["/setup"]);
}

export async function testTwitchDownload(_: ActionResult) {
  return guard(async () => {
    const a = await officialDownloadAvailable();
    if (!a.ok) throw new Error(a.reason);
    const [clip] = await sql()`SELECT twitch_clip_id, broadcaster_id FROM clips ORDER BY twitch_created_at DESC NULLS LAST LIMIT 1`;
    if (!clip) throw new Error("Ingen clips registreret endnu — kør en scanning først");
    const [d] = await getClipDownloadUrls(clip.broadcaster_id as string, a.editorId!, [clip.twitch_clip_id as string]);
    if (!d?.landscape_download_url && !d?.portrait_download_url) throw new Error("Twitch gav ingen download-URL");
    return d;
  }, "Officiel Twitch-download virker (editor/broadcaster-rettighed bekræftet)", ["/setup"]);
}

export async function testAi(_: ActionResult) {
  return guard(async () => pingAi(), (r) => `Claude svarer (${config.aiModel}): "${r}"`, ["/setup"]);
}

export async function testTikTok(_: ActionResult) {
  return guard(async () => creatorInfo(), (ci) => `TikTok svarer: @${ci.creator_username} (${ci.creator_nickname}) — tilladt synlighed: ${ci.privacy_level_options.join(", ")}, maks ${ci.max_video_post_duration_sec}s`, ["/accounts"]);
}

export async function testEmail(_: ActionResult) {
  return guard(async () => {
    if (!emailConfigured()) throw new Error("SMTP_URL og ALERT_EMAIL_TO er ikke sat i .env");
    if (!(await sendEmail("Testmail", "Notifikationer virker."))) throw new Error("Mailen kunne ikke sendes — se logs");
  }, `Testmail sendt til ${config.alertEmailTo}`, ["/health"]);
}

export async function runTestClip(_: ActionResult) {
  return guard(async () => {
    const [c] = await sql()`SELECT id, status FROM clips WHERE status IN ('BASELINE','DISCOVERED','QUEUED','FAILED','READY') ORDER BY twitch_created_at DESC NULLS LAST LIMIT 1`;
    if (!c) throw new Error("Ingen clips registreret endnu — kør en scanning først");
    const id = Number(c.id);
    if (c.status === "READY") {
      await updateSettings("setup", { testClipId: id });
      return id;
    }
    await sql()`UPDATE clips SET status = 'QUEUED', origin = CASE WHEN origin = 'baseline' THEN 'manual' ELSE origin END, attempts = 0, updated_at = now() WHERE id = ${id}`;
    await addEvent(id, "Valgt som testclip i Setup Wizard", { to: "QUEUED" });
    await updateSettings("setup", { testClipId: id });
    await enqueueClip("process", id);
    return id;
  }, (id) => `Testclip #${id} behandles — se fremdriften nedenfor`, ["/setup"]);
}
