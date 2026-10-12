/** Download permissions (MOCK Twitch), alerts, housekeeping, auth and crypto. */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startMockServer } from "./mocks/server";
import { makeTestClip, resetDb } from "./helpers";
import { sql } from "@/lib/db";
import { updateSettings, defaultSettings, setState } from "@/lib/settings";
import { downloadClip, PermissionError } from "@/lib/twitch/download";
import { saveToken } from "@/lib/tokens";
import { evaluateAlerts, housekeeping } from "@/lib/pipeline/maintenance";
import { encrypt, decrypt, hashPassword, verifyPassword } from "@/lib/crypto";
import { createSessionToken, verifySessionToken } from "@/lib/auth";
import { exchangeTwitchCode } from "@/lib/twitch/oauth";

let mock: Awaited<ReturnType<typeof startMockServer>>;
beforeAll(async () => {
  mock = await startMockServer();
  Object.assign(process.env, mock.env);
});
afterAll(async () => mock.close());
beforeEach(async () => {
  await resetDb();
  mock.reset();
  mock.state.s.clipFile = makeTestClip({ seconds: 6 });
});

const clipRow = { id: 1, twitch_clip_id: "abc", broadcaster_id: "1234", url: "http://mock/clip/abc" };
const editor = () => saveToken({ provider: "twitch_user", accountId: "999", accountName: "editoruser", scopes: ["editor:manage:clips"], accessToken: "user-token", refreshToken: "r", expiresAt: new Date(Date.now() + 3600_000), refreshExpiresAt: null, meta: {} });

describe("autoriseret download (MOCK Twitch)", () => {
  it("Twitch OAuth: code → token med editor-scope gemmes", async () => {
    const info = await exchangeTwitchCode("code");
    expect(info).toMatchObject({ login: "editoruser", user_id: "999" });
    const [row] = await sql()`SELECT scopes FROM oauth_tokens WHERE provider = 'twitch_user'`;
    expect(row.scopes).toContain("editor:manage:clips");
  });
  it("henter via officiel Get Clips Download med editor-token", async () => {
    await editor();
    const s = defaultSettings();
    s.twitch.downloadMethod = "official";
    const r = await downloadClip(clipRow, s);
    expect(r.method).toBe("official");
    expect(r.info).toMatchObject({ width: 1920, height: 1080 });
    const req = mock.state.s.twitchRequests.find((q) => q.path === "/clips/downloads")!;
    expect(req.query.get("editor_id")).toBe("999");
    expect(req.query.get("broadcaster_id")).toBe("1234");
  });
  it("manglende editor-rettighed (403) i 'kun officiel' → PermissionError (BLOCKED_PERMISSION)", async () => {
    await editor();
    mock.state.s.downloadForbidden = true;
    const s = defaultSettings();
    s.twitch.downloadMethod = "official";
    await expect(downloadClip(clipRow, s)).rejects.toBeInstanceOf(PermissionError);
  });
  it("ingen konto i 'kun officiel' → tydelig besked om hvad der mangler", async () => {
    const s = defaultSettings();
    s.twitch.downloadMethod = "official";
    await expect(downloadClip(clipRow, s)).rejects.toThrow(/Ingen Twitch-brugerkonto forbundet/);
  });
});

describe("overvågning og alarmer", () => {
  it("scanner der ikke har kørt → kritisk alarm; workers uden heartbeat → kritisk", async () => {
    await updateSettings("automation", { monitorEnabled: true });
    await setState("twitch.sync", { lastSuccessAt: new Date(Date.now() - 3600_000).toISOString(), baselineDoneAt: new Date().toISOString() });
    const r = await evaluateAlerts();
    expect(r.ok).toBe(false);
    const keys = (await sql()`SELECT key FROM alerts WHERE resolved_at IS NULL`).map((a) => a.key);
    expect(keys).toEqual(expect.arrayContaining(["twitch-scan-stale", "worker-render", "worker-uploader", "worker-monitor"]));
  });
  it("alarmer løses automatisk når problemet forsvinder", async () => {
    await updateSettings("automation", { monitorEnabled: true });
    await setState("twitch.sync", { lastSuccessAt: new Date(Date.now() - 3600_000).toISOString() });
    await evaluateAlerts();
    await setState("twitch.sync", { lastSuccessAt: new Date().toISOString() });
    for (const w of ["monitor", "render", "uploader"]) {
      await sql()`INSERT INTO worker_heartbeats (worker, started_at, last_beat_at) VALUES (${w}, now(), now())`;
    }
    const r = await evaluateAlerts();
    expect(r.ok).toBe(true);
    const open = await sql()`SELECT key FROM alerts WHERE resolved_at IS NULL AND severity = 'critical'`;
    expect(open).toHaveLength(0);
  });
});

describe("oprydning", () => {
  it("sletter filer for publicerede clips efter retention, beholder dem for ikke-publicerede", async () => {
    const dir = path.join(process.env.DATA_DIR!, "sources");
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, "old.mp4");
    const keep = path.join(dir, "keep.mp4");
    fs.writeFileSync(old, "x");
    fs.writeFileSync(keep, "x");
    await sql()`INSERT INTO clips (twitch_clip_id, broadcaster_id, status, source_path, render_path, published_at) VALUES ('o', '1', 'PUBLISHED', ${old}, ${old}, now() - interval '30 days')`;
    await sql()`INSERT INTO clips (twitch_clip_id, broadcaster_id, status, source_path) VALUES ('k', '1', 'READY', ${keep})`;
    await housekeeping();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
    const [m] = await sql()`SELECT count(*)::int AS n FROM system_metrics`;
    expect(m.n).toBe(1);
  });
});

describe("sikkerhed", () => {
  it("tokens krypteres med AES-GCM og kan ikke manipuleres", () => {
    const enc = encrypt("hemmelig");
    expect(enc).not.toContain("hemmelig");
    expect(decrypt(enc)).toBe("hemmelig");
    const parts = enc.split(".");
    parts[3] = Buffer.from("andet").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow();
  });
  it("adgangskode-hash og sessions", async () => {
    const h = hashPassword("korrekt hest batteri");
    expect(verifyPassword("korrekt hest batteri", h)).toBe(true);
    expect(verifyPassword("forkert", h)).toBe(false);
    expect(await verifySessionToken(await createSessionToken())).toBe(true);
    expect(await verifySessionToken("eyJhbGciOiJub25lIn0.e30.")).toBe(false);
  });
});
