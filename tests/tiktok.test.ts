/** TikTok integration against the MOCK TikTok server. A passing mocked upload is NOT proof TikTok received a video. */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startMockServer } from "./mocks/server";
import { resetDb } from "./helpers";
import { sql } from "@/lib/db";
import { updateSettings } from "@/lib/settings";
import { exchangeCode, accessToken, chunkPlan } from "@/lib/tiktok/api";
import { loadToken, saveToken } from "@/lib/tokens";
import { uploadClip, checkPublishStatus, nextAllowedPostTime, resolveUserAction } from "@/lib/pipeline/upload";
import { getClip } from "@/lib/clips";
import { tiktokAccountState } from "@/lib/tiktok/state";
import { getSettings } from "@/lib/settings";

let mock: Awaited<ReturnType<typeof startMockServer>>;
const MB = 1024 * 1024;

async function makeReadyClip(sizeBytes = 3 * MB, id = "clipA"): Promise<number> {
  const dir = path.join(process.env.DATA_DIR!, "renders");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.mp4`);
  fs.writeFileSync(file, Buffer.alloc(sizeBytes, 7));
  const [r] = await sql()`INSERT INTO clips (twitch_clip_id, broadcaster_id, twitch_title, final_title, title_source, status, render_path, twitch_created_at, duration, media_info, hashtags)
    VALUES (${id}, '1234', 'tw', 'En god titel', 'ai', 'READY', ${file}, now() - interval '1 hour', 20, ${sql().json({ duration: 20 })}, ${["sondergaard"]}) RETURNING id`;
  return Number(r.id);
}

async function configure() {
  await updateSettings("setup", { rightsConfirmedAt: new Date().toISOString(), rightsConfirmedBy: "Test" });
  await updateSettings("tiktok", { mode: "direct", privacyLevel: "SELF_ONLY", consentAt: new Date().toISOString(), musicConfirmationAt: new Date().toISOString() });
  await updateSettings("automation", { autoPublish: true, minMinutesBetweenPosts: 0, maxPostsPer24h: 10 });
  await exchangeCode("good-code");
}

/** Drives status polling like the uploader worker does, without the queue. */
async function pollUntilDone(clipId: number, max = 10) {
  let r: Awaited<ReturnType<typeof checkPublishStatus>> = { status: "PROCESSING" };
  for (let i = 0; i < max && r.status === "PROCESSING"; i++) r = await checkPublishStatus(clipId, i);
  return r.status;
}

beforeAll(async () => {
  mock = await startMockServer();
  Object.assign(process.env, mock.env);
});
afterAll(async () => mock.close());
beforeEach(async () => {
  await resetDb();
  mock.reset();
});

describe("TikTok OAuth (MOCK)", () => {
  it("bytter code til tokens, gemmer krypteret og henter profil", async () => {
    const t = await exchangeCode("good-code");
    expect(t.accessToken).toBe("tt-access-1");
    expect(t.scopes).toContain("video.publish");
    expect(t.accountName).toBe("Test Creator");
    const [raw] = await sql()`SELECT access_token_enc FROM oauth_tokens WHERE provider = 'tiktok'`;
    expect(String(raw.access_token_enc)).not.toContain("tt-access-1");
  });
  it("fornyer udløbet access token med refresh token", async () => {
    const t = await exchangeCode("good-code");
    await saveToken({ ...t, expiresAt: new Date(Date.now() - 1000) });
    expect(await accessToken()).toBe("tt-access-1-r");
    expect((await loadToken("tiktok"))!.refreshToken).toBe("tt-refresh-1-r");
  });
  it("fejlet refresh markerer kontoen som 'kræver handling'", async () => {
    const t = await exchangeCode("good-code");
    await saveToken({ ...t, expiresAt: new Date(Date.now() - 1000), refreshToken: "revoked" });
    await expect(accessToken()).rejects.toThrow(/fornyes/);
    expect((await tiktokAccountState()).state).toBe("OWNER_ACTION_REQUIRED");
  });
  it("ugyldig code afvises", async () => {
    await expect(exchangeCode("bad")).rejects.toThrow();
  });
});

describe("chunk-plan efter TikToks regler", () => {
  it("små filer i én chunk, store i 10 MB-chunks med rest i sidste", () => {
    expect(chunkPlan(3 * MB)).toEqual({ videoSize: 3 * MB, chunkSize: 3 * MB, totalChunks: 1 });
    expect(chunkPlan(64 * MB).totalChunks).toBe(1);
    const p = chunkPlan(95 * MB);
    expect(p).toEqual({ videoSize: 95 * MB, chunkSize: 10 * MB, totalChunks: 9 });
    expect(p.videoSize - (p.totalChunks - 1) * p.chunkSize).toBeLessThanOrEqual(128 * MB);
  });
});

describe("TikTok upload (MOCK)", () => {
  it("Direct Post: init → upload → status → PUBLISHED", async () => {
    await configure();
    const id = await makeReadyClip();
    expect(await uploadClip(id)).toBe("PROCESSING");
    expect(await pollUntilDone(id)).toBe("PUBLISHED");
    const c = (await getClip(id))!;
    expect(c.tiktok_url).toMatch(/tiktok\.com\/@testcreator\/video\/\d+/);
    const init = mock.state.s.tiktokRequests.find((r) => r.path === "/v2/post/publish/video/init/")!.body as { post_info: Record<string, unknown>; source_info: Record<string, unknown> };
    expect(init.post_info).toMatchObject({ privacy_level: "SELF_ONLY", disable_comment: true, disable_duet: true, disable_stitch: true, brand_content_toggle: false });
    expect(init.post_info.title).toBe("En god titel\n\n#sondergaard #twitchdk #danskstreamer");
    expect(init.source_info).toMatchObject({ source: "FILE_UPLOAD", total_chunk_count: 1 });
  });

  it("store filer uploades i flere chunks (Content-Range valideret af mock)", async () => {
    await configure();
    const id = await makeReadyClip(70 * MB, "big");
    await uploadClip(id);
    expect(await pollUntilDone(id)).toBe("PUBLISHED");
    const up = [...mock.state.s.uploads.values()][0];
    expect(up.chunks).toBe(7);
  });

  it("blokeres uden samtykke / uden rettighedsbekræftelse", async () => {
    await exchangeCode("good-code");
    await updateSettings("automation", { autoPublish: true });
    const id = await makeReadyClip();
    expect(await uploadClip(id)).toBe("BLOCKED_PERMISSION");
    expect((await getClip(id))!.status_reason).toMatch(/Rettighed/);
    expect(mock.state.s.initCount).toBe(0);
  });

  it("valgt synlighed som kontoen ikke tillader → kræver handling, intet init", async () => {
    await configure();
    await updateSettings("tiktok", { privacyLevel: "PUBLIC_TO_EVERYONE" });
    const id = await makeReadyClip();
    expect(await uploadClip(id)).toBe("NEEDS_USER_ACTION");
    expect(mock.state.s.initCount).toBe(0);
  });

  it("ikke-auditeret app → BLOCKED_PERMISSION og konto-status 'kun privat'", async () => {
    await configure();
    mock.state.s.privacyOptions = ["PUBLIC_TO_EVERYONE", "SELF_ONLY"];
    await updateSettings("tiktok", { privacyLevel: "PUBLIC_TO_EVERYONE", appAudited: true });
    mock.state.s.initError = "unaudited_client_can_only_post_to_private_accounts";
    const id = await makeReadyClip();
    expect(await uploadClip(id)).toBe("BLOCKED_PERMISSION");
    expect((await tiktokAccountState()).state).toBe("PRIVATE_ONLY");
  });

  it("rate limit (spam_risk_too_many_posts): clippet venter i køen, slettes ikke", async () => {
    await configure();
    mock.state.s.initError = "spam_risk_too_many_posts";
    const id = await makeReadyClip();
    expect(await uploadClip(id)).toBe("READY");
    const c = (await getClip(id))!;
    expect(c.next_retry_at!.getTime()).toBeGreaterThan(Date.now() + 3600_000);
    expect((await tiktokAccountState()).state).toBe("RATE_LIMITED");
    const slot = await nextAllowedPostTime(await getSettings());
    expect(slot.at).not.toBeNull();
  });

  it("egen postgrænse: overskydende clips venter til næste slot", async () => {
    await configure();
    await updateSettings("automation", { maxPostsPer24h: 1 });
    const a = await makeReadyClip(MB, "a1");
    const b = await makeReadyClip(MB, "b1");
    await uploadClip(a);
    await pollUntilDone(a);
    expect(await uploadClip(b)).toBe("READY");
    expect((await getClip(b))!.status_reason).toMatch(/Postgrænse/);
    expect(mock.state.s.initCount).toBe(1);
  });

  it("status FAILED fra TikTok → sikker retry med nyt forsøg", async () => {
    await configure();
    mock.state.s.statusSequence = ["FAILED"];
    mock.state.s.statusFailReason = "video_pull_failed";
    const id = await makeReadyClip();
    await uploadClip(id);
    expect(await pollUntilDone(id)).toBe("RETRY_WAIT");
    await sql()`UPDATE clips SET status = 'READY', next_retry_at = NULL WHERE id = ${id}`;
    mock.state.s.statusSequence = ["PUBLISH_COMPLETE"];
    await uploadClip(id);
    expect(await pollUntilDone(id)).toBe("PUBLISHED");
    const attempts = await sql()`SELECT state FROM upload_attempts WHERE clip_id = ${id} ORDER BY id`;
    expect(attempts.map((a) => a.state)).toEqual(["FAILED", "COMPLETE"]);
  });
});

describe("ingen dobbeltpublicering ved ukendt status (MOCK)", () => {
  it("netværksfejl på sidste chunk → status undersøges, ingen ny upload", async () => {
    await configure();
    mock.state.s.failUploadChunks = 10; // every PUT attempt dies
    const id = await makeReadyClip();
    expect(await uploadClip(id)).toBe("PROCESSING");
    expect(mock.state.s.initCount).toBe(1);
    // TikTok says upload incomplete, URL not expired yet → keep polling, never re-init.
    const r = await checkPublishStatus(id, 0);
    expect(r.status).toBe("PROCESSING");
    expect(mock.state.s.initCount).toBe(1);
  });

  it("status-API nede → bliver ved med at spørge, uploader aldrig igen", async () => {
    await configure();
    mock.state.s.statusNetworkFail = 3;
    const id = await makeReadyClip();
    await uploadClip(id);
    for (let i = 0; i < 3; i++) expect((await checkPublishStatus(id, i)).status).toBe("PROCESSING");
    expect(await pollUntilDone(id)).toBe("PUBLISHED");
    expect(mock.state.s.initCount).toBe(1);
  });

  it("crash efter init (publish_id gemt) → genstart poller status i stedet for nyt init", async () => {
    await configure();
    const id = await makeReadyClip();
    await uploadClip(id);
    // Simulate a crash: the clip is left in UPLOADING with a live attempt holding the publish_id.
    await sql()`UPDATE clips SET status = 'UPLOADING' WHERE id = ${id}`;
    await sql()`UPDATE upload_attempts SET state = 'UPLOADING' WHERE clip_id = ${id}`;
    // Fresh progress = a live worker: must not be touched.
    expect(await uploadClip(id)).toBe("skipped");
    await sql()`UPDATE upload_attempts SET updated_at = now() - interval '10 minutes' WHERE clip_id = ${id}`;
    expect(await uploadClip(id)).toBe("PROCESSING");
    expect(mock.state.s.initCount).toBe(1);
    expect(await pollUntilDone(id)).toBe("PUBLISHED");
    expect(mock.state.s.publishedIds).toHaveLength(1);
  });

  it("init uden svar (ingen publish_id) → sikkert at prøve igen, da ingen bytes blev sendt", async () => {
    await configure();
    mock.state.s.initDropResponse = true;
    const id = await makeReadyClip();
    expect(await uploadClip(id)).toBe("RETRY_WAIT");
    await sql()`UPDATE clips SET status = 'READY', next_retry_at = NULL WHERE id = ${id}`;
    await uploadClip(id);
    expect(await pollUntilDone(id)).toBe("PUBLISHED");
    expect(mock.state.s.publishedIds).toHaveLength(1);
  });

  it("unik live-attempt pr. clip: samtidige uploadforsøg giver kun ét init", async () => {
    await configure();
    const id = await makeReadyClip();
    const results = await Promise.all([uploadClip(id), uploadClip(id), uploadClip(id)]);
    // Late callers may join the status polling of the winner, but never start their own init.
    expect(results.every((r) => r === "PROCESSING" || r === "skipped")).toBe(true);
    expect(mock.state.s.initCount).toBe(1);
    const [{ n }] = await sql()`SELECT count(*)::int AS n FROM upload_attempts WHERE clip_id = ${id}`;
    expect(n).toBe(1);
    expect(await pollUntilDone(id)).toBe("PUBLISHED");
    expect(mock.state.s.publishedIds).toHaveLength(1);
  });

  it("inbox-tilstand → kræver handling; ejer bekræfter publicering", async () => {
    await configure();
    await updateSettings("tiktok", { mode: "inbox" });
    mock.state.s.statusSequence = ["SEND_TO_USER_INBOX"];
    const id = await makeReadyClip();
    await uploadClip(id);
    expect(await pollUntilDone(id)).toBe("NEEDS_USER_ACTION");
    await resolveUserAction(id, "published", "https://www.tiktok.com/@x/video/1");
    expect((await getClip(id))!.status).toBe("PUBLISHED");
  });
});
