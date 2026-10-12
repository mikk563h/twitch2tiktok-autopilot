#!/usr/bin/env bash
# Installs/updates the autopilot on this Mac: clean checkout in ~/.t2t/app and a launchd agent
# that runs scripts/run-once.ts every 15 minutes while the Mac is awake (missed runs catch up).
# Requires ~/.t2t/t2t.env, ~/.t2t/bin/{whisper-cli,yt-dlp} and ffmpeg/ffprobe.
set -euo pipefail
T="$HOME/.t2t"; APP="$T/app"; LABEL=dk.t2t.autopilot; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO=https://github.com/mikk563h/twitch2tiktok-autopilot.git
NODE=$(command -v node); FFMPEG=$(command -v ffmpeg); FFPROBE=$(command -v ffprobe)
[ -f "$T/t2t.env" ] || { echo "Mangler $T/t2t.env"; exit 1; }
[ -d "$APP/.git" ] || git clone -q "$REPO" "$APP"
git -C "$APP" fetch -q origin && git -C "$APP" checkout -q --detach "origin/${T2T_REF:-main}"
(cd "$APP" && npm ci --no-audit --no-fund --ignore-scripts --omit=dev >/dev/null)
cat > "$T/run.sh" <<RUN
#!/bin/bash
# Keep the log small (rotate at 5 MB).
LOG="$T/logs/run.log"; [ -f "\$LOG" ] && [ \$(stat -f %z "\$LOG") -gt 5242880 ] && mv "\$LOG" "\$LOG.1"
cd "$APP" && exec "$NODE" --env-file="$T/t2t.env" --import tsx scripts/run-once.ts >> "\$LOG" 2>&1
RUN
chmod 700 "$T/run.sh"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$T/run.sh</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):$(dirname "$FFMPEG"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DATA_DIR</key><string>$T/data</string>
    <key>FFMPEG_PATH</key><string>$FFMPEG</string>
    <key>FFPROBE_PATH</key><string>$FFPROBE</string>
    <key>WHISPER_BIN</key><string>$T/bin/whisper-cli</string>
    <key>YTDLP_PATH</key><string>$T/bin/yt-dlp</string>
    <key>FONTS_DIR</key><string>$APP/assets/fonts</string>
  </dict>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardErrorPath</key><string>$T/logs/launchd.err</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "OK: $(git -C "$APP" rev-parse --short HEAD) installeret — kører hvert 15. minut"
