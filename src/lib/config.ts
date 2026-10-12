import path from "node:path";

/** Environment configuration. Read lazily so `next build` works without secrets. */
function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Miljøvariabel ${name} mangler`);
  }
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export const config = {
  // Neon/Vercel: prefer the direct (unpooled) URL — session advisory locks don't work through PgBouncer.
  get databaseUrl() { return optional("DATABASE_URL_UNPOOLED") ?? env("DATABASE_URL"); },
  get redisUrl() { return env("REDIS_URL", "redis://localhost:6379"); },
  /**
   * "workers": long-running workers + Redis/BullMQ (VPS/Docker).
   * "batch": no Redis — GitHub Actions runs scripts/run-once.ts on a schedule and the
   * database is the queue; the dashboard runs on Vercel.
   */
  get runMode(): "workers" | "batch" { return optional("REDIS_URL") ? "workers" : "batch"; },
  get githubRepo() { return optional("GITHUB_REPO"); },
  get githubToken() { return optional("GITHUB_TOKEN"); },
  get githubWorkflow() { return env("GITHUB_WORKFLOW", "autopilot.yml"); },
  get githubRef() { return env("GITHUB_REF_NAME", "main"); },
  get cronSecret() { return optional("CRON_SECRET"); },
  get appUrl() { return env("APP_URL", "http://localhost:3000").replace(/\/$/, ""); },
  get appVersion() { return env("APP_VERSION", "dev"); },
  get dataDir() { return path.resolve(env("DATA_DIR", "./data")); },
  get encryptionKey() { return env("APP_ENCRYPTION_KEY"); },
  get sessionSecret() { return env("SESSION_SECRET"); },
  get adminPassword() { return optional("ADMIN_PASSWORD"); },
  get adminPasswordHash() { return optional("ADMIN_PASSWORD_HASH"); },

  get twitchClientId() { return optional("TWITCH_CLIENT_ID"); },
  get twitchClientSecret() { return optional("TWITCH_CLIENT_SECRET"); },
  get twitchChannel() { return env("TWITCH_CHANNEL", "sondergaardlol").toLowerCase(); },
  get twitchApiBase() { return env("TWITCH_API_BASE", "https://api.twitch.tv/helix"); },
  get twitchAuthBase() { return env("TWITCH_AUTH_BASE", "https://id.twitch.tv/oauth2"); },

  get tiktokClientKey() { return optional("TIKTOK_CLIENT_KEY"); },
  get tiktokClientSecret() { return optional("TIKTOK_CLIENT_SECRET"); },
  get tiktokApiBase() { return env("TIKTOK_API_BASE", "https://open.tiktokapis.com"); },
  get tiktokAuthUrl() { return env("TIKTOK_AUTH_URL", "https://www.tiktok.com/v2/auth/authorize/"); },

  get anthropicApiKey() { return optional("ANTHROPIC_API_KEY"); },
  get anthropicBaseUrl() { return optional("ANTHROPIC_BASE_URL"); },
  get aiModel() { return env("AI_MODEL", "claude-opus-5-5"); },

  get ffmpegPath() { return env("FFMPEG_PATH", "ffmpeg"); },
  get ffprobePath() { return env("FFPROBE_PATH", "ffprobe"); },
  get whisperBin() { return env("WHISPER_BIN", "whisper-cli"); },
  get whisperModel() { return env("WHISPER_MODEL", "small"); },
  get ytDlpPath() { return env("YTDLP_PATH", "yt-dlp"); },
  get fontsDir() { return path.resolve(env("FONTS_DIR", "./assets/fonts")); },

  get smtpUrl() { return optional("SMTP_URL"); },
  get alertEmailTo() { return optional("ALERT_EMAIL_TO"); },
  get alertEmailFrom() { return env("ALERT_EMAIL_FROM", "twitch2tiktok@localhost"); },
  get heartbeatUrl() { return optional("HEARTBEAT_URL"); },
  get logLevel() { return env("LOG_LEVEL", "info"); },
};

export const paths = {
  get sources() { return path.join(config.dataDir, "sources"); },
  get renders() { return path.join(config.dataDir, "renders"); },
  get work() { return path.join(config.dataDir, "work"); },
  get models() { return path.join(config.dataDir, "models"); },
};
