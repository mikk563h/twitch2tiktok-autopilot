/**
 * LOCAL DEMO STACK (development only): embedded Postgres + Redis + the MOCK Twitch/TikTok/Claude
 * server, so the dashboard and workers can be run end-to-end without Docker or real accounts.
 * Writes the environment to .tmp/local.env. Usage: npx tsx scripts/local-stack.ts
 */
import fs from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { RedisMemoryServer } from "redis-memory-server";
import { startMockServer } from "../tests/mocks/server";
import { makeTestClip } from "../tests/helpers";

const root = path.resolve(".tmp");
fs.mkdirSync(root, { recursive: true });
const pgDir = path.join(root, "pg");
const pg = new EmbeddedPostgres({ databaseDir: pgDir, user: "t2t", password: "t2t", port: 54329, persistent: true, onLog: () => {} });
if (!fs.existsSync(path.join(pgDir, "PG_VERSION"))) await pg.initialise();
await pg.start();
try { await pg.createDatabase("t2t"); } catch { /* exists */ }
const redis = await RedisMemoryServer.create({ instance: { port: 63799 } });
const mock = await startMockServer();
const s = mock.state.s;
s.clipFile = makeTestClip({ seconds: 6 });
const now = Date.now();
s.clips = [
  { id: "OldClip-1", created_at: new Date(now - 9 * 86400_000).toISOString(), title: "gammel ace på inferno", view_count: 1200 },
  { id: "OldClip-2", created_at: new Date(now - 20 * 86400_000).toISOString(), title: "LOL den her fail", view_count: 800 },
];
s.privacyOptions = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];
s.aiResponder = (body) => JSON.stringify((body as { output_config?: unknown }).output_config ?? "").includes("supported")
  ? { supported: true, problems: "" }
  : { observations: "Testbillede med farvestriber; streameren siger at de skal spille Counter-Strike og vinde runden.", spoken_summary: "Nu skal vi spille Counter-Strike, og jeg vinder runden",
      understood: true, confidence: 0.88, is_funny: false, title: `Han lover at vinde runden – ${["og holder ord", "før den overhovedet starter", "med fuld selvtillid"][Math.floor(Math.random() * 3)]}`,
      title_evidence: "tale", game: "Counter-Strike 2", hashtags: ["cs2", "counterstrike"], action_focus_x: 0.5, facecam: { present: true, x: 0.78, y: 0.037, w: 0.198, h: 0.26, confidence: 0.9 } };
// Every 3 minutes a "new" clip appears on the mock channel.
let n = 0;
setInterval(() => { n++; s.clips.push({ id: `LiveClip-${n}`, created_at: new Date().toISOString(), title: `nyt clip ${n}`, view_count: n }); }, 180_000);

const env = {
  DATABASE_URL: "postgres://t2t:t2t@127.0.0.1:54329/t2t",
  REDIS_URL: `redis://127.0.0.1:${await redis.getPort()}`,
  DATA_DIR: path.join(root, "data"),
  APP_URL: "http://localhost:3000",
  APP_ENCRYPTION_KEY: "1".repeat(64),
  SESSION_SECRET: "local-dev-session-secret-local-dev-session-secret",
  ADMIN_PASSWORD: "demo",
  TWITCH_CLIENT_ID: "mock", TWITCH_CLIENT_SECRET: "mock", TIKTOK_CLIENT_KEY: "mock", TIKTOK_CLIENT_SECRET: "mock", ANTHROPIC_API_KEY: "mock",
  ...mock.env,
  TIKTOK_AUTH_URL: `${mock.base}/tiktok-authorize`,
  WHISPER_BIN: process.env.WHISPER_BIN ?? "", WHISPER_MODEL: "base", YTDLP_PATH: process.env.YTDLP_PATH ?? "yt-dlp",
};
fs.writeFileSync(path.join(root, "local.env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
console.log("LOCAL STACK READY (MOCK APIs) — env in .tmp/local.env");
process.on("SIGTERM", async () => { await mock.close(); await redis.stop(); await pg.stop(); process.exit(0); });
