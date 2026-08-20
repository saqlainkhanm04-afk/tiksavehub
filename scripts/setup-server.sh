#!/usr/bin/env bash
# ============================================================
# TikSaveHub — production server setup (Ubuntu/Debian)
# Installs: Node.js >= 22, ffmpeg, yt-dlp standalone binary,
#           service user, runtime dirs, systemd unit + env file.
# Usage:   sudo bash scripts/setup-server.sh
# ============================================================
set -euo pipefail

APP_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
)"
USER_NAME="${TIKSAVEHUB_USER:-tiksavehub}"
DATA_DIR="/var/lib/tiksavehub"
CONF_DIR="/etc/tiksavehub"
LOG_DIR="/var/log/tiksavehub"

log() { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup]\033[0m %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash scripts/setup-server.sh" >&2
  exit 1
fi

# ---- 1. System packages: ffmpeg (+ ffprobe) ----
log "Installing ffmpeg..."
apt-get update -qq
apt-get install -y -qq ffmpeg
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null
log "ffmpeg: $(ffmpeg -version | head -1)"

# ---- 2. Node.js >= 22 (NodeSource fallback if distro node is too old) ----
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')"
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 22 ]; then
  log "Node.js already OK: $(node -v)"
else
  log "Installing Node.js 22 LTS from NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
command -v node >/dev/null && node -v | grep -qE '^v(2[2-9]|[3-9][0-9])'

# ---- 3. yt-dlp standalone binary (self-updating, no Python needed) ----
log "Installing yt-dlp standalone binary..."
curl -fsSL -o /usr/local/bin/yt-dlp \
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
log "yt-dlp: $(/usr/local/bin/yt-dlp --version)"
log "Keep it fresh on the server: sudo yt-dlp -U"

# ---- 3b. systemd timer: auto-update yt-dlp daily (idempotent) ----
install -o root -g root -m 0644 \
  "$APP_DIR/deploy/yt-dlp-update.service" /etc/systemd/system/yt-dlp-update.service
install -o root -g root -m 0644 \
  "$APP_DIR/deploy/yt-dlp-update.timer" /etc/systemd/system/yt-dlp-update.timer
systemctl daemon-reload
systemctl enable --now yt-dlp-update.timer
log "yt-dlp auto-update timer enabled (runs daily). Status:"
systemctl list-timers yt-dlp-update.timer --no-pager | tail -2

# ---- 4. Service user (cannot log in) ----
if ! id "$USER_NAME" >/dev/null 2>&1; then
  log "Creating system user '$USER_NAME'..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
fi

# ---- 5. Runtime directories ----
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 "$DATA_DIR" "$LOG_DIR"
install -d -o root -g root -m 0755 "$CONF_DIR"
log "Dirs: $DATA_DIR, $LOG_DIR, $CONF_DIR"

# ---- 6. Environment file (only created if missing — never overwrite secrets) ----
ENV_FILE="$CONF_DIR/env"
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$APP_DIR/.env.production" ]; then
    install -o root -g root -m 0600 "$APP_DIR/.env.production" "$ENV_FILE"
    log "Copied .env.production -> $ENV_FILE (chmod 600)"
  elif [ -f "$APP_DIR/.env.production.example" ]; then
    install -o root -g root -m 0600 "$APP_DIR/.env.production.example" "$ENV_FILE"
    warn "Copied the EXAMPLE file -> $ENV_FILE (chmod 600)."
    warn "EDIT IT NOW:  sudo nano $ENV_FILE  (paste your IG_SESSIONID)"
  fi
else
  warn "$ENV_FILE already exists — left untouched."
fi

# ---- 7. systemd unit ----
UNIT="/etc/systemd/system/tiksavehub.service"
if [ ! -f "$UNIT" ]; then
  log "Installing systemd unit..."
  if [ -f "$APP_DIR/deploy/tiksavehub.service" ]; then
    install -o root -g root -m 0644 "$APP_DIR/deploy/tiksavehub.service" "$UNIT"
  else
    cat >"$UNIT" <<EOF
[Unit]
Description=TikSaveHub — Astro Node standalone server
After=network.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
ExecStart=/usr/bin/node $APP_DIR/dist/server/entry.mjs
Restart=always
RestartSec=3
StandardOutput=append:$LOG_DIR/app.log
StandardError=append:$LOG_DIR/app-error.log

[Install]
WantedBy=multi-user.target
EOF
  fi
  systemctl daemon-reload
else
  warn "$UNIT already exists — left untouched."
fi

log ""
log "Setup complete. Next steps:"
log "  1. Fill secrets:      sudo nano $ENV_FILE"
log "  2. Deploy the app:    npm run build, sync dist/ to $APP_DIR"
log "  3. chown -R '$USER_NAME:$USER_NAME' $APP_DIR/data  (if used)"
log "  4. Start the service: sudo systemctl enable --now tiksavehub"
log "  5. Tail logs:         sudo journalctl -u tiksavehub -f"
log "  6. Smoke test:        curl -s http://localhost:3000/ | head -5"
log "  7. yt-dlp updates automatically (daily): systemctl list-timers yt-dlp-update.timer"