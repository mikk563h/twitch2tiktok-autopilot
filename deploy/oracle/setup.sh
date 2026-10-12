#!/usr/bin/env bash
# Provisions an Ubuntu 24.04 server (Oracle Cloud Always Free, ARM) to run the autopilot:
# Node 24, FFmpeg, whisper.cpp, yt-dlp, the repo in /opt/t2t, and a systemd timer that runs
# scripts/run-once.ts every 15 minutes. Idempotent — safe to re-run (also used for updates).
# Usage (as root): bash setup.sh   — expects /etc/t2t.env to exist.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
WHISPER_CPP_VERSION=v1.9.5
YTDLP_VERSION=2026.08.19
REPO=https://github.com/mikk563h/twitch2tiktok-autopilot.git

apt-get update -q
apt-get install -y -q ca-certificates curl git ffmpeg build-essential cmake unattended-upgrades
if ! command -v node >/dev/null || ! node -v | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi

# Swap so whisper + FFmpeg peaks never OOM.
if ! swapon --show | grep -q .; then fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi

id t2t >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/t2t --shell /usr/sbin/nologin t2t
mkdir -p /opt/t2t /var/lib/t2t/data && chown -R t2t:t2t /opt/t2t /var/lib/t2t

# whisper.cpp
if [ ! -x /usr/local/bin/whisper-cli ] || ! /usr/local/bin/whisper-cli --help 2>&1 | grep -q split-on-word; then
  rm -rf /tmp/wsrc /tmp/wbuild
  git clone -q --depth 1 --branch "$WHISPER_CPP_VERSION" https://github.com/ggml-org/whisper.cpp /tmp/wsrc
  cmake -S /tmp/wsrc -B /tmp/wbuild -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF >/dev/null
  cmake --build /tmp/wbuild -j"$(nproc)" --target whisper-cli >/dev/null
  install -m 755 /tmp/wbuild/bin/whisper-cli /usr/local/bin/whisper-cli
fi

# yt-dlp (pinned)
ARCH=$(uname -m); YT=$([ "$ARCH" = "aarch64" ] && echo yt-dlp_linux_aarch64 || echo yt-dlp_linux)
if ! /usr/local/bin/yt-dlp --version 2>/dev/null | grep -q "$YTDLP_VERSION"; then
  curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${YT}" && chmod 755 /usr/local/bin/yt-dlp
fi

# Code (controlled update: pinned to the ref given in $T2T_REF, default main)
if [ ! -d /opt/t2t/.git ]; then sudo -u t2t git clone -q "$REPO" /opt/t2t; fi
sudo -u t2t git -C /opt/t2t fetch -q origin
sudo -u t2t git -C /opt/t2t checkout -q --detach "origin/${T2T_REF:-main}"
sudo -u t2t bash -c 'cd /opt/t2t && npm ci --no-audit --no-fund --ignore-scripts --omit=dev >/dev/null'

chmod 640 /etc/t2t.env && chown root:t2t /etc/t2t.env
install -m 644 /opt/t2t/deploy/oracle/t2t-autopilot.service /etc/systemd/system/
install -m 644 /opt/t2t/deploy/oracle/t2t-autopilot.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now t2t-autopilot.timer
echo "OK: $(git -C /opt/t2t rev-parse --short HEAD) — timer: $(systemctl is-active t2t-autopilot.timer)"
