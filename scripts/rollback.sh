#!/usr/bin/env bash
# Skifter tilbage til forrige deployede version (image findes stadig lokalt).
# Bemærk: databasemigrationer er additive; ved et problematisk skema gendan fra backup (scripts/restore.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
PREV=${1:-$(cat .previous-version 2>/dev/null || true)}
[ -n "$PREV" ] || { echo "Ingen tidligere version registreret. Angiv et tag: ./scripts/rollback.sh <tag>"; docker images t2t-app; exit 1; }
CUR=$(cat .deployed-version 2>/dev/null || echo "")
echo "==> Ruller tilbage: ${CUR:-?} -> $PREV"
APP_VERSION="$PREV" docker compose up -d --remove-orphans
echo "$PREV" > .deployed-version
[ -n "$CUR" ] && echo "$CUR" > .previous-version
APP_VERSION="$PREV" docker compose ps
