-- Twitch2TikTok Autopilot: initial schema

CREATE TABLE clips (
  id                 BIGSERIAL PRIMARY KEY,
  twitch_clip_id     TEXT NOT NULL UNIQUE,
  broadcaster_id     TEXT NOT NULL,
  broadcaster_name   TEXT,
  url                TEXT,
  embed_url          TEXT,
  creator_name       TEXT,
  video_id           TEXT,
  game_id            TEXT,
  game_name          TEXT,
  language           TEXT,
  twitch_title       TEXT,
  view_count         INTEGER,
  twitch_created_at  TIMESTAMPTZ,
  thumbnail_url      TEXT,
  duration           REAL,

  status             TEXT NOT NULL,
  status_reason      TEXT,
  origin             TEXT NOT NULL DEFAULT 'monitor', -- monitor | baseline | historical | manual
  priority           INTEGER NOT NULL DEFAULT 0,

  source_path        TEXT,
  render_path        TEXT,
  render_thumb_path  TEXT,
  download_method    TEXT,
  media_info         JSONB,
  transcript         JSONB,
  analysis           JSONB,
  render_overrides   JSONB NOT NULL DEFAULT '{}'::jsonb,
  render_info        JSONB,

  ai_title           TEXT,
  manual_title       TEXT,
  title_source       TEXT, -- ai | twitch | manual
  final_title        TEXT,
  hashtags           TEXT[],
  caption            TEXT,

  attempts           INTEGER NOT NULL DEFAULT 0,
  retry_stage        TEXT,
  next_retry_at      TIMESTAMPTZ,
  last_error         TEXT,
  locked_by          TEXT,
  locked_at          TIMESTAMPTZ,

  tiktok_publish_id  TEXT,
  tiktok_post_id     TEXT,
  tiktok_url         TEXT,
  published_at       TIMESTAMPTZ,
  files_cleaned_at   TIMESTAMPTZ,

  discovered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT clips_status_check CHECK (status IN (
    'BASELINE','DISCOVERED','QUEUED','DOWNLOADING','DOWNLOADED','ANALYZING','EDITING','READY',
    'UPLOADING','PROCESSING','PUBLISHED','RETRY_WAIT','BLOCKED_PERMISSION','NEEDS_USER_ACTION','FAILED'
  ))
);
CREATE INDEX clips_status_idx ON clips (status);
CREATE INDEX clips_created_idx ON clips (twitch_created_at DESC);
CREATE INDEX clips_retry_idx ON clips (next_retry_at) WHERE next_retry_at IS NOT NULL;

CREATE TABLE clip_events (
  id          BIGSERIAL PRIMARY KEY,
  clip_id     BIGINT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT,
  level       TEXT NOT NULL DEFAULT 'info',
  message     TEXT NOT NULL,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX clip_events_clip_idx ON clip_events (clip_id, id DESC);

-- One row per TikTok init. Unique idempotency key and at most one "live" attempt per clip
-- protect against double publishing.
CREATE TABLE upload_attempts (
  id               BIGSERIAL PRIMARY KEY,
  clip_id          BIGINT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  idempotency_key  TEXT NOT NULL UNIQUE,
  state            TEXT NOT NULL, -- INIT_PENDING | INITIALIZED | UPLOADING | UPLOADED | COMPLETE | FAILED | ABANDONED
  mode             TEXT NOT NULL, -- direct | inbox
  privacy_level    TEXT,
  publish_id       TEXT UNIQUE,
  upload_url_expires_at TIMESTAMPTZ,
  video_size       BIGINT,
  bytes_sent       BIGINT NOT NULL DEFAULT 0,
  tiktok_status    TEXT,
  fail_reason      TEXT,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX upload_attempts_one_live ON upload_attempts (clip_id)
  WHERE state NOT IN ('FAILED','ABANDONED');

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oauth_tokens (
  provider           TEXT PRIMARY KEY, -- twitch_user | twitch_app | tiktok
  account_id         TEXT,
  account_name       TEXT,
  scopes             TEXT[] NOT NULL DEFAULT '{}',
  access_token_enc   TEXT NOT NULL,
  refresh_token_enc  TEXT,
  expires_at         TIMESTAMPTZ,
  refresh_expires_at TIMESTAMPTZ,
  meta               JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'ok', -- ok | refresh_failed | revoked
  status_message     TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kv_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scan_runs (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL, -- incremental | deep | baseline | historical
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  window_start TIMESTAMPTZ,
  window_end   TIMESTAMPTZ,
  requests     INTEGER NOT NULL DEFAULT 0,
  clips_seen   INTEGER NOT NULL DEFAULT 0,
  clips_new    INTEGER NOT NULL DEFAULT 0,
  ok           BOOLEAN,
  error        TEXT
);
CREATE INDEX scan_runs_started_idx ON scan_runs (started_at DESC);

CREATE TABLE worker_heartbeats (
  worker       TEXT PRIMARY KEY,
  hostname     TEXT,
  pid          INTEGER,
  version      TEXT,
  started_at   TIMESTAMPTZ NOT NULL,
  last_beat_at TIMESTAMPTZ NOT NULL,
  info         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE alerts (
  id               BIGSERIAL PRIMARY KEY,
  key              TEXT NOT NULL,
  severity         TEXT NOT NULL, -- info | warning | critical
  message          TEXT NOT NULL,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_notified_at TIMESTAMPTZ,
  resolved_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX alerts_open_key ON alerts (key) WHERE resolved_at IS NULL;

CREATE TABLE log_entries (
  id         BIGSERIAL PRIMARY KEY,
  level      TEXT NOT NULL,
  source     TEXT NOT NULL,
  message    TEXT NOT NULL,
  data       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX log_entries_created_idx ON log_entries (created_at DESC);

CREATE TABLE system_metrics (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  disk_total  BIGINT,
  disk_free   BIGINT,
  mem_total   BIGINT,
  mem_free    BIGINT,
  load1       REAL,
  cpu_count   INTEGER
);
CREATE INDEX system_metrics_created_idx ON system_metrics (created_at DESC);

CREATE TABLE backup_runs (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL, -- backup | restore_test
  ok          BOOLEAN NOT NULL,
  file        TEXT,
  size_bytes  BIGINT,
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
