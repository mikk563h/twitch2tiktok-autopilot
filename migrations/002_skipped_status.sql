-- Newest-first selection: clips that lost their slot to a newer clip are marked SKIPPED
-- (kept for history; can still be queued manually).
ALTER TABLE clips DROP CONSTRAINT clips_status_check;
ALTER TABLE clips ADD CONSTRAINT clips_status_check CHECK (status IN (
  'BASELINE','DISCOVERED','QUEUED','DOWNLOADING','DOWNLOADED','ANALYZING','EDITING','READY',
  'UPLOADING','PROCESSING','PUBLISHED','RETRY_WAIT','BLOCKED_PERMISSION','NEEDS_USER_ACTION','FAILED','SKIPPED'
));
