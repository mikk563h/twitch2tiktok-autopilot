#!/bin/sh
# Nightly pg_dump with retention + weekly automatic restore test. Results are written to
# backup_runs so the dashboard and alerts can see them.
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD"
DB="$POSTGRES_DB"; U="$POSTGRES_USER"; H="${PGHOST:-postgres}"
DIR=/backups; KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"; AT="${BACKUP_HOUR:-3}"
mkdir -p "$DIR"

log_run() { # kind ok file size message
  psql -h "$H" -U "$U" -d "$DB" -v ON_ERROR_STOP=0 -q -c \
    "INSERT INTO backup_runs (kind, ok, file, size_bytes, message) VALUES ('$1', $2, '$3', ${4:-0}, '$(echo "$5" | sed "s/'/''/g")')" >/dev/null 2>&1 || true
}

do_backup() {
  f="$DIR/t2t-$(date -u +%Y%m%dT%H%M%SZ).dump"
  if pg_dump -h "$H" -U "$U" -d "$DB" -Fc -Z 6 -f "$f.tmp" 2>/tmp/err; then
    mv "$f.tmp" "$f"; size=$(stat -c %s "$f")
    log_run backup true "$f" "$size" "ok"; echo "backup ok: $f ($size bytes)"
    find "$DIR" -name 't2t-*.dump' -mtime +"$KEEP_DAYS" -delete
    [ -n "${BACKUP_RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null && rclone copy "$f" "$BACKUP_RCLONE_REMOTE" || true
  else
    rm -f "$f.tmp"; log_run backup false "" 0 "$(cat /tmp/err | tail -3)"; echo "backup FAILED" >&2
  fi
}

do_restore_test() {
  latest=$(ls -1t "$DIR"/t2t-*.dump 2>/dev/null | head -1 || true)
  [ -z "$latest" ] && { log_run restore_test false "" 0 "ingen backup at teste"; return; }
  psql -h "$H" -U "$U" -d postgres -q -c "DROP DATABASE IF EXISTS t2t_restore_test" >/dev/null
  psql -h "$H" -U "$U" -d postgres -q -c "CREATE DATABASE t2t_restore_test" >/dev/null
  if pg_restore -h "$H" -U "$U" -d t2t_restore_test --no-owner "$latest" 2>/tmp/err; then
    live=$(psql -h "$H" -U "$U" -d t2t_restore_test -tAc "SELECT count(*) FROM clips")
    mig=$(psql -h "$H" -U "$U" -d t2t_restore_test -tAc "SELECT count(*) FROM schema_migrations")
    log_run restore_test true "$latest" 0 "gendannet: $live clips, $mig migrationer"
    echo "restore test ok ($live clips)"
  else
    log_run restore_test false "$latest" 0 "$(tail -3 /tmp/err)"
  fi
  psql -h "$H" -U "$U" -d postgres -q -c "DROP DATABASE IF EXISTS t2t_restore_test" >/dev/null
}

case "${1:-loop}" in
  now) do_backup ;;
  restore-test) do_restore_test ;;
  loop)
    sleep 60; do_backup  # one backup shortly after start
    while true; do
      now=$(date -u +%s); next=$(date -u -d "tomorrow ${AT}:30" +%s 2>/dev/null || echo $((now + 86400)))
      sleep $((next - now)); do_backup
      [ "$(date -u +%u)" = "7" ] && do_restore_test
    done ;;
esac
