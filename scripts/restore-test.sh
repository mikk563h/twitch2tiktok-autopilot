#!/usr/bin/env bash
# Gendanner seneste backup i en midlertidig database og tjekker indholdet (rører ikke produktion).
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose run --rm backup restore-test
docker compose exec -T postgres psql -U "${POSTGRES_USER:-t2t}" -d "${POSTGRES_DB:-t2t}" -c "SELECT kind, ok, message, created_at FROM backup_runs ORDER BY id DESC LIMIT 3"
