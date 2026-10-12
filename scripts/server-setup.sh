#!/usr/bin/env bash
# Engangsopsætning af en frisk Ubuntu 24.04 VPS (kør som root):
#   curl -fsSL https://raw.githubusercontent.com/<repo>/main/scripts/server-setup.sh | bash
# eller efter git clone: sudo ./scripts/server-setup.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl git ufw unattended-upgrades fail2ban jq
# Docker Engine + compose plugin
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker
# Firewall: SSH + HTTP/HTTPS only
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
# Swap (FFmpeg/whisper peaks) — 4 GB if none
if ! swapon --show | grep -q .; then fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
# Automatic security updates (no automatic reboot of the app; Docker restarts containers after reboot)
dpkg-reconfigure -f noninteractive unattended-upgrades
# Docker log rotation default
mkdir -p /etc/docker && [ -f /etc/docker/daemon.json ] || echo '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"5"}}' > /etc/docker/daemon.json
systemctl restart docker
echo "Server klar. Næste: git clone <repo> /opt/t2t && cd /opt/t2t && ./scripts/gen-secrets.sh && ./scripts/deploy.sh"
