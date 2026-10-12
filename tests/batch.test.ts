/**
 * Free mode (GitHub Actions): scripts/run-once.ts as a real child process WITHOUT Redis.
 * Twitch/TikTok/Claude are MOCKED; FFmpeg, whisper.cpp and Postgres are real.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startMockServer } from "./mocks/server";
import { makeTestClip, resetDb } from "./helpers";
import { sql } from "@/lib/db";
import { getSyncState, runIncrementalScan } from "@/lib/twitch/monitor";
import { setState, updateSettings } from "@/lib/settings";
import { exchangeCode } from "@/lib/tiktok/api";
import { saveToken } from "@/lib/tokens";
import { getClip } from "@/lib/clips";

let mock: Awaited<ReturnType<typeof startMockServer>>;

function runOnce(phase: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const outFile = path.join(process.env.DATA_DIR!, `gh-output-${Date.now()}`);
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_OUTPUT: outFile, LOG_LEVEL: "warn", RUN_EPHEMERAL: "1", ...extraEnv };
  delete env.REDIS_URL; // batch mode
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("scripts/run-once.ts"), phase], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code: code ?? 1, out: out + (fs.existsSync(outFile) ? `\nOUTPUT:${fs.readFileSync(outFile, "utf8")}` : "") }));
  });
}

const aiAnswer = (body: unknown) => JSON.stringify((body as { output_config?: unknown }).output_config ?? "").includes("supported")
  ? { supported: true, problems: "" }
  : { observations: "Farvestriber og en orange boks; en stemme siger de skal spille Counter-Strike.", spoken_summary: "skal spille Counter-Strike", understood: true, confidence: 0.9, is_funny: false,
      title: "Han lover at vinde runden i Counter-Strike", title_evidence: "tale", game: "Counter-Strike 2", hashtags: ["cs2"], action_focus_x: 0.5,
      facecam: { present: false, x: 0, y: 0, w: 0.1, h: 0.1, confidence: 0.1 } };

beforeAll(async () => {
  mock = await startMockServer();
  Object.assign(process.env, mock.env);
});
afterAll(async () => mock.close());
beforeEach(async () => {
  await resetDb();
  mock.reset();
  mock.state.s.clipFile = makeTestClip({ seconds: 6 });
  mock.state.s.aiResponder = aiAnswer;
  await updateSettings("setup", { rightsConfirmedAt: new Date().toISOString(), rightsConfirmedBy: "Test", completedAt: new Date().toISOString() });
  await updateSettings("tiktok", { mode: "direct", privacyLevel: "SELF_ONLY", consentAt: new Date().toISOString(), musicConfirmationAt: new Date().toISOString() });
  await updateSettings("automation", { monitorEnabled: true, autoEdit: true, autoPublish: true, minMinutesBetweenPosts: 0 });
  await updateSettings("ai", { frameCount: 3 });
  await exchangeCode("good-code");
  await saveToken({ provider: "twitch_user", accountId: "999", accountName: "editoruser", scopes: ["editor:manage:clips"], accessToken: "user-token", refreshToken: "r", expiresAt: new Date(Date.now() + 3600_000), refreshExpiresAt: null, meta: {} });
});

describe("gratis-mode: run-once uden Redis (MOCK APIs)", () => {
  it("idle kørsel: plan finder intet arbejde → work=false (tunge trin springes over)", async () => {
    const r = await runOnce("plan");
    expect(r.code).toBe(0);
    expect(r.out).toContain("work=false");
    expect((await getSyncState()).baselineDoneAt).toBeTruthy();
    const [hb] = await sql()`SELECT * FROM worker_heartbeats WHERE worker = 'autopilot'`;
    expect(hb).toBeTruthy();
  });

  it("nyt clip: plan → work=true; work → redigeret og publiceret; filstier ryddes", { timeout: 240_000 }, async () => {
    await runIncrementalScan(); // baseline
    const s = await getSyncState();
    await setState("twitch.sync", { ...s, baselineDoneAt: new Date(Date.now() - 3600_000).toISOString(), lastSuccessEnd: new Date(Date.now() - 30_000).toISOString(), lastDeepAt: new Date().toISOString() });
    mock.state.s.clips.push({ id: "gha-1", created_at: new Date(Date.now() - 10_000).toISOString(), title: "runden", view_count: 1 });
    const p = await runOnce("plan");
    expect(p.code, p.out).toBe(0);
    expect(p.out).toContain("work=true");
    const w = await runOnce("work");
    expect(w.code, w.out).toBe(0);
    const [row] = await sql()`SELECT id FROM clips WHERE twitch_clip_id = 'gha-1'`;
    const c = (await getClip(Number(row.id)))!;
    expect(c.status).toBe("PUBLISHED");
    expect(c.final_title).toBe("Han lover at vinde runden i Counter-Strike");
    expect(c.render_path).toBeNull(); // ephemeral runner files are forgotten
    expect(mock.state.s.publishedIds).toHaveLength(1);
  });

  it("READY-clip fra tidligere kørsel uden filer: genskabes og uploades, uden ny AI-analyse", { timeout: 240_000 }, async () => {
    await runIncrementalScan();
    const s = await getSyncState();
    await setState("twitch.sync", { ...s, baselineDoneAt: new Date(Date.now() - 3600_000).toISOString(), lastSuccessEnd: new Date(Date.now() - 30_000).toISOString(), lastDeepAt: new Date().toISOString() });
    mock.state.s.clips.push({ id: "gha-2", created_at: new Date(Date.now() - 10_000).toISOString(), title: "x", view_count: 1 });
    await updateSettings("automation", { autoPublish: false, selection: "all" });
    expect((await runOnce("all")).code).toBe(0);
    const [row] = await sql()`SELECT id, status, render_path FROM clips WHERE twitch_clip_id = 'gha-2'`;
    expect(row).toMatchObject({ status: "READY", render_path: null });
    const aiCalls = mock.state.s.aiRequests.length;
    await updateSettings("automation", { autoPublish: true });
    const r = await runOnce("all");
    expect(r.code, r.out).toBe(0);
    expect((await getClip(Number(row.id)))!.status).toBe("PUBLISHED");
    expect(mock.state.s.aiRequests.length).toBe(aiCalls);
  });

  it("på en fast server (ikke ephemeral) bevares videofilerne mellem kørsler", { timeout: 240_000 }, async () => {
    await runIncrementalScan();
    const s = await getSyncState();
    await setState("twitch.sync", { ...s, baselineDoneAt: new Date(Date.now() - 3600_000).toISOString(), lastSuccessEnd: new Date(Date.now() - 30_000).toISOString(), lastDeepAt: new Date().toISOString() });
    mock.state.s.clips.push({ id: "vm-1", created_at: new Date(Date.now() - 10_000).toISOString(), title: "x", view_count: 1 });
    await updateSettings("automation", { autoPublish: false, selection: "all" });
    expect((await runOnce("all", { RUN_EPHEMERAL: "0" })).code).toBe(0);
    const [row] = await sql()`SELECT status, render_path FROM clips WHERE twitch_clip_id = 'vm-1'`;
    expect(row.status).toBe("READY");
    expect(row.render_path && fs.existsSync(row.render_path)).toBe(true);
  });

  it("nyeste først: kun det nyeste clip redigeres og uploades, ældre markeres som sprunget over", { timeout: 240_000 }, async () => {
    await runIncrementalScan();
    const s = await getSyncState();
    await setState("twitch.sync", { ...s, baselineDoneAt: new Date(Date.now() - 3600_000).toISOString(), lastSuccessEnd: new Date(Date.now() - 30_000).toISOString(), lastDeepAt: new Date().toISOString() });
    await updateSettings("automation", { selection: "newest", minMinutesBetweenPosts: 180, maxPostsPer24h: 8 });
    for (const [id, ago] of [["n-old", 300_000], ["n-mid", 120_000], ["n-new", 10_000]] as const)
      mock.state.s.clips.push({ id, created_at: new Date(Date.now() - ago).toISOString(), title: id, view_count: 1 });
    const r = await runOnce("all");
    expect(r.code, r.out).toBe(0);
    const rows = Object.fromEntries((await sql()`SELECT twitch_clip_id, status FROM clips WHERE twitch_clip_id LIKE 'n-%'`).map((x) => [x.twitch_clip_id, x.status]));
    expect(rows).toEqual({ "n-new": "PUBLISHED", "n-mid": "SKIPPED", "n-old": "SKIPPED" });
    expect(mock.state.s.publishedIds).toHaveLength(1);
    // A newer clip arrives, but the next posting slot is 3 hours away: nothing is rendered, it just waits.
    mock.state.s.clips.push({ id: "n-newer", created_at: new Date(Date.now() - 5_000).toISOString(), title: "newer", view_count: 1 });
    const p = await runOnce("plan");
    expect(p.out).toContain("work=false");
    const [w] = await sql()`SELECT status FROM clips WHERE twitch_clip_id = 'n-newer'`;
    expect(w.status).toBe("DISCOVERED");
  });

  it("bedste siden sidste opslag: clippet med flest (friske) visninger vælges, resten springes over", { timeout: 240_000 }, async () => {
    await runIncrementalScan();
    const s = await getSyncState();
    await setState("twitch.sync", { ...s, baselineDoneAt: new Date(Date.now() - 3600_000).toISOString(), lastSuccessEnd: new Date(Date.now() - 30_000).toISOString(), lastDeepAt: new Date().toISOString() });
    await updateSettings("automation", { selection: "best", minMinutesBetweenPosts: 95, maxPostsPer24h: 15 });
    for (const [id, views, ago] of [["b-a", 5, 300_000], ["b-b", 50, 200_000], ["b-c", 1, 10_000]] as const)
      mock.state.s.clips.push({ id, created_at: new Date(Date.now() - ago).toISOString(), title: id, view_count: views });
    // Registered first with stale counts; by posting time b-c has become the most viewed.
    await runIncrementalScan();
    mock.state.s.clips.find((c) => c.id === "b-c")!.view_count = 120;
    const r = await runOnce("all");
    expect(r.code, r.out).toBe(0);
    const rows = Object.fromEntries((await sql()`SELECT twitch_clip_id, status, view_count FROM clips WHERE twitch_clip_id LIKE 'b-%'`).map((x) => [x.twitch_clip_id, x.status]));
    expect(rows).toEqual({ "b-c": "PUBLISHED", "b-a": "SKIPPED", "b-b": "SKIPPED" });
    expect(mock.state.s.publishedIds).toHaveLength(1);
  });

  it("dashboard-anmodning (upload-now) gemmes i DB og udføres af næste kørsel", async () => {
    const { requestJob } = await import("@/lib/queue");
    // requestJob checks the run mode at call time.
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const r = await requestJob({ name: "scan-now" });
      expect(r.triggered).toBe(false); // no GITHUB_TOKEN in tests
    } finally {
      process.env.REDIS_URL = saved;
    }
    const [row] = await sql()`SELECT value FROM kv_state WHERE key = 'batch.requests'`;
    expect(row.value).toEqual([{ name: "scan-now" }]);
    expect((await runOnce("plan")).code).toBe(0);
    const left = await sql()`SELECT 1 FROM kv_state WHERE key = 'batch.requests'`;
    expect(left).toHaveLength(0);
  });
});
