#!/usr/bin/env bash
# Gendanner databasen fra en backup. STOPPER app-containerne mens det sker.
#   ./scripts/restore.sh backups/t2t-20261012T033000Z.dump
set -euo pipefail
cd "$(dirname "$0")/.."
FILE=${1:?Angiv backup-fil, fx backups/t2t-....dump}
[ -f "$FILE" ] || { echo "Filen findes ikke: $FILE"; exit 1; }
POSTGRES_USER=$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-); POSTGRES_USER=${POSTGRES_USER:-t2t}
POSTGRES_DB=$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-); POSTGRES_DB=${POSTGRES_DB:-t2t}
POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
read -rp "Dette OVERSKRIVER den nuværende database med $FILE. Skriv 'gendan' for at fortsætte: " ok
[ "$ok" = "gendan" ] || exit 1
docker compose stop web monitor render uploader
docker compose run --rm -e PGPASSWORD="$POSTGRES_PASSWORD" -v "$(pwd)/$FILE:/restore.dump:ro" --entrypoint sh backup -c \
  "dropdb -h postgres -U $POSTGRES_USER --if-exists ${POSTGRES_DB} && createdb -h postgres -U $POSTGRES_USER ${POSTGRES_DB} && pg_restore -h postgres -U $POSTGRES_USER -d ${POSTGRES_DB} --no-owner /restore.dump"
docker compose up -d
echo "Gendannet. Workers genoptager automatisk ufærdige jobs ud fra databasen."
