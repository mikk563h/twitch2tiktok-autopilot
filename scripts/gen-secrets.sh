#!/usr/bin/env bash
# Genererer hemmeligheder og skriver dem ind i .env (opretter .env fra .env.example hvis den mangler).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
set_var() { # name value — only fills empty values
  if grep -qE "^$1=$" .env; then
    python3 - "$1" "$2" <<'PY'
import sys,re
k,v=sys.argv[1],sys.argv[2]
s=open('.env').read()
s=re.sub(rf'^{k}=$', f'{k}={v}', s, count=1, flags=re.M)
open('.env','w').write(s)
PY
    echo "  $1 genereret"
  fi
}
set_var POSTGRES_PASSWORD "$(openssl rand -hex 24)"
set_var APP_ENCRYPTION_KEY "$(openssl rand -hex 32)"
set_var SESSION_SECRET "$(openssl rand -base64 48 | tr -d '\n=/+')"
if grep -qE "^ADMIN_PASSWORD_HASH=$" .env; then
  read -rsp "Vælg adgangskode til dashboardet: " PW; echo
  HASH=$(PW="$PW" node -e "const c=require('crypto');const s=c.randomBytes(16);const h=c.scryptSync(process.env.PW,s,64);console.log('scrypt:'+s.toString('base64url')+':'+h.toString('base64url'))")
  set_var ADMIN_PASSWORD_HASH "$HASH"
fi
echo "Færdig. Udfyld resten af .env (Twitch/TikTok/AI-nøgler, DOMAIN)."
