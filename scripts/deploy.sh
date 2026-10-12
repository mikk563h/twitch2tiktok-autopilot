#!/usr/bin/env bash
# Kontrolleret opdatering: bygger et nyt image tagget med git-commit, migrerer, starter, tjekker
# health — og ruller automatisk tilbage til forrige version hvis noget fejler.
#   ./scripts/deploy.sh            # deploy nuværende checkout
#   ./scripts/deploy.sh origin/main  # hent og deploy en ref
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo ".env mangler — kør ./scripts/gen-secrets.sh"; exit 1; }
if [ "${1:-}" != "" ]; then git fetch --all --tags && git checkout --detach "$1"; fi
NEW=$(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain --untracked-files=no)" ] && echo "-dirty" || true)
PREV=$(cat .deployed-version 2>/dev/null || echo "")
echo "==> Bygger t2t-app:$NEW (forrige: ${PREV:-ingen})"
docker build -f docker/Dockerfile -t "t2t-app:$NEW" .
echo "==> Backup før deploy"
docker compose up -d postgres >/dev/null
docker compose run --rm backup now || echo "(backup sprunget over: første deploy?)"
echo "==> Starter $NEW"
APP_VERSION="$NEW" docker compose up -d --remove-orphans
echo "==> Venter på health checks"
ok=0
for i in $(seq 1 40); do
  sleep 6
  unhealthy=$(APP_VERSION="$NEW" docker compose ps --format json | jq -rs 'flatten | map(select(.Service|test("web|monitor|render|uploader"))) | map(select(.Health != "healthy")) | length')
  if [ "$unhealthy" = "0" ]; then ok=1; break; fi
done
if [ "$ok" = "1" ]; then
  echo "$NEW" > .deployed-version
  [ -n "$PREV" ] && [ "$PREV" != "$NEW" ] && echo "$PREV" > .previous-version
  echo "==> Deploy OK: $NEW"
  docker image prune -f --filter "label!=keep" >/dev/null || true
else
  echo "!!! Health checks fejlede for $NEW"
  APP_VERSION="$NEW" docker compose ps
  if [ -n "$PREV" ]; then
    echo "==> Ruller tilbage til $PREV"
    APP_VERSION="$PREV" docker compose up -d --remove-orphans
  fi
  exit 1
fi
