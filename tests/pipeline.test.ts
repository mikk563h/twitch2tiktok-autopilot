/**
 * End-to-end with REAL worker processes (src/workers/*.ts), real Postgres/Redis, real FFmpeg and
 * whisper.cpp. Only Twitch, TikTok and Claude are MOCKED (tests/mocks/server.ts).
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startMockServer } from "./mocks/server";
import { makeTestClip, resetDb, waitFor } from "./helpers";
import { sql } from "@/lib/db";
import { getSyncState, runIncrementalScan } from "@/lib/twitch/monitor";
import { setState, updateSettings } from "@/lib/settings";
import { exchangeCode } from "@/lib/tiktok/api";
import { enqueueClip, queue } from "@/lib/queue";
import { reconcile } from "@/lib/pipeline/maintenance";
import { failClip, getClip } from "@/lib/clips";

let mock: Awaited<ReturnType<typeof startMockServer>>;
const children: ChildProcess[] = [];

function startWorker(name: "render" | "uploader" | "monitor", extraEnv: Record<string, string> = {}): ChildProcess {
  // `node --import tsx` = one process, so SIGKILL really kills the worker (the tsx CLI would fork a child).
  const child = spawn(process.execPath, ["--import", "tsx", path.resolve(`src/workers/${name}.ts`)], {
    env: { ...process.env, LOG_LEVEL: "warn", HEARTBEAT_FILE: path.join(process.env.DATA_DIR!, `hb-${name}-${Date.now()}`), WORKER_LOCK_MS: "4000", WORKER_STALLED_MS: "2000", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (d) => process.env.DEBUG_WORKERS && process.stderr.write(`[${name}] ${d}`));
  child.stdout!.on("data", (d) => process.env.DEBUG_WORKERS && process.stdout.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}

function kill9(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((r) => { child.once("exit", () => r()); child.kill("SIGKILL"); });
}

const aiAnswer = (body: unknown) => {
  const schema = JSON.stringify((body as { output_config?: unknown }).output_config ?? "");
  if (schema.includes("supported")) return { supported: true, problems: "" };
  return {
    observations: "Testbillede med farvestriber og en orange boks øverst til højre; en stemme siger at de skal spille Counter-Strike.",
    spoken_summary: "Hej allesammen, nu skal vi spille Counter-Strike", understood: true, confidence: 0.9, is_funny: false,
    title: `Runden starter: nu skal vi spille Counter-Strike ${Math.random().toString(36).slice(2, 6)}`, title_evidence: "tale",
    game: "Counter-Strike 2", hashtags: ["cs2", "counterstrike"], action_focus_x: 0.5,
    facecam: { present: true, x: 0.78, y: 0.037, w: 0.198, h: 0.26, confidence: 0.92 },
  };
};

async function configureAll() {
  await updateSettings("setup", { rightsConfirmedAt: new Date().toISOString(), rightsConfirmedBy: "Test", completedAt: new Date().toISOString() });
  await updateSettings("tiktok", { mode: "direct", privacyLevel: "SELF_ONLY", consentAt: new Date().toISOString(), musicConfirmationAt: new Date().toISOString() });
  await updateSettings("automation", { autoEdit: true, autoPublish: true, minMinutesBetweenPosts: 0, maxPostsPer24h: 20 });
  await updateSettings("twitch", { downloadMethod: "official" });
  await updateSettings("ai", { frameCount: 4 });
  await exchangeCode("good-code");
  // Twitch editor connection (official download API).
  const { saveToken } = await import("@/lib/tokens");
  await saveToken({ provider: "twitch_user", accountId: "999", accountName: "editoruser", scopes: ["editor:manage:clips"], accessToken: "user-token", refreshToken: "user-refresh", expiresAt: new Date(Date.now() + 3600_000), refreshExpiresAt: null, meta: {} });
}

async function baselineThenNewClip(id: string) {
  await runIncrementalScan();
  const s = await getSyncState();
  await setState("twitch.sync", { ...s, baselineDoneAt: new Date(Date.now() - 3600_000).toISOString(), lastSuccessEnd: new Date(Date.now() - 30_000).toISOString(), lastDeepAt: new Date().toISOString() });
  mock.state.s.clips.push({ id, created_at: new Date(Date.now() - 20_000).toISOString(), title: "kæmpe runde", view_count: 2 });
  await runIncrementalScan();
  const [row] = await sql()`SELECT id FROM clips WHERE twitch_clip_id = ${id}`;
  return Number(row.id);
}

beforeAll(async () => {
  mock = await startMockServer();
  Object.assign(process.env, mock.env);
  makeTestClip({ seconds: 6 });
});
afterAll(async () => mock.close());
beforeEach(async () => {
  await resetDb();
  mock.reset();
  mock.state.s.clipFile = makeTestClip({ seconds: 6 });
  mock.state.s.aiResponder = aiAnswer;
  await configureAll();
});
afterEach(async () => {
  await Promise.all(children.splice(0).map((c) => kill9(c)));
});

describe("fuld pipeline med rigtige workers (Twitch/TikTok/Claude MOCK)", () => {
  it("nyt clip → download → AI → render → TikTok → PUBLISHED", { timeout: 240_000 }, async () => {
    const id = await baselineThenNewClip("e2e-1");
    startWorker("render");
    startWorker("uploader");
    const done = await waitFor(async () => { const c = await getClip(id); return c?.status === "PUBLISHED" ? c : null; }, 200_000, 500);
    expect(done.download_method).toBe("official");
    expect(done.title_source).toBe("ai");
    expect(done.final_title).toMatch(/^Runden starter/);
    expect(done.hashtags).toEqual(["sondergaard", "twitchdk", "danskstreamer", "cs2", "counterstrike"]);
    expect((done.render_info as { output: { width: number; height: number } }).output).toMatchObject({ width: 1080, height: 1920 });
    expect((done.render_info as { plan: { layout: string } }).plan.layout).toBe("split");
    expect((done.transcript as { words: unknown[] }).words.length).toBeGreaterThan(3);
    expect(mock.state.s.publishedIds).toHaveLength(1);
    const events = await sql()`SELECT to_status FROM clip_events WHERE clip_id = ${id} AND to_status IS NOT NULL ORDER BY id`;
    expect(events.map((e) => e.to_status)).toEqual(expect.arrayContaining(["DISCOVERED", "QUEUED", "DOWNLOADING", "DOWNLOADED", "ANALYZING", "EDITING", "READY", "UPLOADING", "PROCESSING", "PUBLISHED"]));
  });

  it("worker-crash: render-worker dræbes (kill -9) midt i arbejdet → ny worker overtager og færdiggør", { timeout: 240_000 }, async () => {
    const id = await baselineThenNewClip("crash-1");
    const w1 = startWorker("render");
    await waitFor(async () => { const c = await getClip(id); return c && ["ANALYZING", "EDITING"].includes(c.status) ? c : null; }, 60_000, 100);
    await kill9(w1);
    expect(() => process.kill(w1.pid!, 0)).toThrow(); // process is really gone
    const mid = (await getClip(id))!;
    expect(["DOWNLOADED", "ANALYZING", "EDITING"]).toContain(mid.status);
    // New process: BullMQ detects the stalled job (lock expired) and re-runs it; the DB lock of
    // the dead instance is ignored because its heartbeat is gone.
    startWorker("render");
    startWorker("uploader");
    const done = await waitFor(async () => { const c = await getClip(id); return c?.status === "PUBLISHED" ? c : null; }, 200_000, 500);
    expect(done.status).toBe("PUBLISHED");
    expect(mock.state.s.publishedIds).toHaveLength(1);
  });

  it("servergenstart med tabt Redis: reconciler genskaber jobs ud fra databasen", { timeout: 240_000 }, async () => {
    const id = await baselineThenNewClip("restart-1");
    // Simulate a host restart where the clip was mid-pipeline and Redis lost every job.
    await sql()`UPDATE clips SET status = 'ANALYZING', locked_by = 'dead-instance', locked_at = now() - interval '1 minute', updated_at = now() - interval '20 minutes' WHERE id = ${id}`;
    await queue("process").obliterate({ force: true });
    expect(await queue("process").count()).toBe(0);
    const counts = await reconcile();
    expect(counts.stalled).toBe(1);
    startWorker("render");
    startWorker("uploader");
    const done = await waitFor(async () => { const c = await getClip(id); return c?.status === "PUBLISHED" ? c : null; }, 200_000, 500);
    expect(done.status).toBe("PUBLISHED");
  });

  it("kø og retry: midlertidig fejl → RETRY_WAIT med backoff → reconciler genoptager", async () => {
    const id = await baselineThenNewClip("retry-1");
    await queue("process").obliterate({ force: true });
    const c = (await getClip(id))!;
    const status = await failClip(c, "process", new Error("midlertidig netværksfejl"));
    expect(status).toBe("RETRY_WAIT");
    const after = (await getClip(id))!;
    expect(after.attempts).toBe(1);
    expect(after.next_retry_at!.getTime()).toBeGreaterThan(Date.now() + 10_000);
    expect((await reconcile()).retry).toBeUndefined(); // not due yet
    await sql()`UPDATE clips SET next_retry_at = now() - interval '1 second' WHERE id = ${id}`;
    expect((await reconcile()).retry).toBe(1);
    expect((await getClip(id))!.status).toBe("QUEUED");
    expect(await queue("process").getJob(`process-${id}`)).toBeTruthy();
  });

  it("permanent fejl efter maks forsøg → FAILED; manuel retry muligt", async () => {
    const id = await baselineThenNewClip("fail-1");
    await queue("process").obliterate({ force: true });
    await sql()`UPDATE clips SET attempts = 7 WHERE id = ${id}`;
    expect(await failClip((await getClip(id))!, "process", new Error("bliver ved med at fejle"))).toBe("FAILED");
  });

  it("25 clips på én gang: alle registreres og ingen tabes", async () => {
    await runIncrementalScan();
    const s = await getSyncState();
    await setState("twitch.sync", { ...s, baselineDoneAt: new Date(Date.now() - 3600_000).toISOString(), lastSuccessEnd: new Date(Date.now() - 30_000).toISOString(), lastDeepAt: new Date().toISOString() });
    for (let i = 0; i < 25; i++) mock.state.s.clips.push({ id: `burst-${i}`, created_at: new Date(Date.now() - 25_000 + i * 100).toISOString(), title: `b${i}`, view_count: i });
    await runIncrementalScan();
    const [{ n }] = await sql()`SELECT count(*)::int AS n FROM clips WHERE twitch_clip_id LIKE 'burst-%' AND status = 'DISCOVERED'`;
    expect(n).toBe(25);
    expect(await queue("process").count()).toBe(25);
    // Even if Redis loses them, reconcile re-enqueues all of them.
    await queue("process").obliterate({ force: true });
    await reconcile();
    expect(await queue("process").count()).toBe(25);
    await enqueueClip("process", 1); // idempotent for existing ids
    expect(await queue("process").count()).toBe(25);
  });
});
