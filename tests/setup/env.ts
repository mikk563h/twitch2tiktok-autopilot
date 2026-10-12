import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inject } from "vitest";

// Local tools for tests: ~/.t2t/bin/{whisper-cli,yt-dlp} and ~/.t2t/test-models/ggml-base.bin
// (installed by deploy/mac/install.sh setup). The STT test is skipped when missing.
const TOOLS = process.env.T2T_TOOLS_DIR ?? path.join(os.homedir(), ".t2t");

process.env.DATABASE_URL = inject("databaseUrl");
process.env.REDIS_URL = inject("redisUrl");
process.env.DATA_DIR = inject("dataDir");
process.env.APP_ENCRYPTION_KEY = "0".repeat(64);
process.env.SESSION_SECRET = "test-session-secret-test-session-secret";
process.env.APP_URL = "http://localhost:3000";
process.env.TWITCH_CLIENT_ID = "test-client";
process.env.TWITCH_CLIENT_SECRET = "test-secret";
process.env.TIKTOK_CLIENT_KEY = "tt-key";
process.env.TIKTOK_CLIENT_SECRET = "tt-secret";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.LOG_LEVEL = "silent";
process.env.WHISPER_BIN ??= path.join(TOOLS, "bin/whisper-cli");
process.env.WHISPER_MODEL ??= "base";
process.env.YTDLP_PATH ??= path.join(TOOLS, "bin/yt-dlp");
process.env.FONTS_DIR = path.resolve("assets/fonts");

// Reuse the downloaded whisper model instead of fetching it per run.
const models = path.join(process.env.DATA_DIR!, "models");
fs.mkdirSync(models, { recursive: true });
const src = path.join(TOOLS, "test-models/ggml-base.bin");
const dst = path.join(models, "ggml-base.bin");
if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
process.env.WORKER_GRACE_S = "0";
