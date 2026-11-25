#!/usr/bin/env bash
# MCBot Control — one-line panel installer with a password prompt.
#
#   curl -fsSL https://raw.githubusercontent.com/RO0MII/mcbot/main/install.sh | sudo bash
#
# Non-interactive (for scripts):
#   curl -fsSL .../install.sh -o install.sh
#   sudo PANEL_PASSWORD='your-password' bash install.sh
#
# Useful overrides: INSTALL_DIR=/opt/mcbot PORT=80
# Testing only: INSTALL_SRC=/path/to/repo NO_SERVICE=1 NO_START=1 DRY_RUN=1

set -euo pipefail

REPO='RO0MII/mcbot'
SERVICE='mcbot-dashboard.service'
PORT="${PORT:-80}"
INSTALL_DIR="${INSTALL_DIR:-/opt/mcbot}"
PANEL_PASSWORD="${PANEL_PASSWORD:-}"
INSTALL_SRC="${INSTALL_SRC:-}"
NO_SERVICE="${NO_SERVICE:-0}"
NO_START="${NO_START:-0}"
DRY_RUN="${DRY_RUN:-0}"

say() { printf '%s\n' "$*"; }
fail() { printf '  error: %s\n' "$*" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" = '1' ]; then printf '  [dry-run]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

printf '\n  MCBot Control — panel installer\n\n'

command -v node >/dev/null 2>&1 || fail 'Node.js 18+ is required.'
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail 'Node.js 18+ is required.'

case "$PORT" in
  ''|*[!0-9]*) fail "PORT must be a number (got: $PORT)." ;;
esac
case "$INSTALL_DIR" in
  *[[:space:]]*) fail 'INSTALL_DIR must not contain spaces.' ;;
esac

# ── password ───────────────────────────────────────────────────────────────
if [ -z "$PANEL_PASSWORD" ]; then
  # curl | sudo bash makes stdin the script itself, so prompt on the terminal.
  [ -e /dev/tty ] || fail 'No terminal for the password prompt. Set PANEL_PASSWORD=... instead.'
  while :; do
    read -r -s -p '  Dashboard password: ' PANEL_PASSWORD < /dev/tty; printf '\n'
    [ -n "$PANEL_PASSWORD" ] || { say '  Password cannot be empty.'; continue; }
    read -r -s -p '  Confirm password: ' CONFIRM < /dev/tty; printf '\n'
    [ "$PANEL_PASSWORD" = "$CONFIRM" ] && break
    say '  Passwords did not match. Try again.'
  done
fi
case "$PANEL_PASSWORD" in
  *$'\n'*|*$'\r'*) fail 'Password must be a single line.' ;;
esac
[ "${#PANEL_PASSWORD}" -ge 6 ] || fail 'Use at least 6 characters for the dashboard password.'
say '  ✓ Password accepted (never printed)'

ENV_FILE="$INSTALL_DIR/panel.env"
env_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/\\$/g' -e 's/`/\\`/g'
}

# ── source ─────────────────────────────────────────────────────────────────
run mkdir -p "$INSTALL_DIR"
if [ -n "$INSTALL_SRC" ]; then
  say "  → Copying panel source from $INSTALL_SRC"
  if [ "$DRY_RUN" != '1' ]; then
    ( cd "$INSTALL_SRC" && tar --exclude=node_modules --exclude=.git -cf - . ) | ( cd "$INSTALL_DIR" && tar -xf - )
  fi
elif [ -d "$INSTALL_DIR/.git" ]; then
  say '  → Updating existing checkout'
  run git -C "$INSTALL_DIR" pull --ff-only
elif [ -e "$INSTALL_DIR" ]; then
  fail "$INSTALL_DIR exists but is not a git checkout. Move it aside, or set INSTALL_SRC."
else
  command -v git >/dev/null 2>&1 || fail 'git is required to download the panel.'
  say "  → Downloading MCBot into $INSTALL_DIR"
  run git clone --depth 1 "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

# ── password file + systemd override ───────────────────────────────────────
# The existing npm installer writes the base unit, which has no password.
# An override keeps our DASHBOARD_PASSWORD attached even after re-running setup.
if [ "$DRY_RUN" != '1' ]; then
  printf 'DASHBOARD_PASSWORD="%s"\n' "$(env_escape "$PANEL_PASSWORD")" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
say "  ✓ Password saved to $ENV_FILE (mode 600)"

USE_SYSTEMD=0
if [ "$NO_SERVICE" != '1' ] && [ "$(id -u)" -eq 0 ] && [ -d /run/systemd/system ]; then
  USE_SYSTEMD=1
  OVERRIDE_DIR="/etc/systemd/system/${SERVICE}.d"
  run mkdir -p "$OVERRIDE_DIR"
  if [ "$DRY_RUN" != '1' ]; then
    printf '[Service]\nEnvironmentFile=%s\n' "$ENV_FILE" > "$OVERRIDE_DIR/override.conf"
    chmod 600 "$OVERRIDE_DIR/override.conf"
  fi
  say "  ✓ Password attached to $SERVICE"
fi

# ── dependencies + service ─────────────────────────────────────────────────
if [ "$USE_SYSTEMD" = '1' ]; then
  run env PORT="$PORT" node "$INSTALL_DIR/scripts/install.js"
  run systemctl daemon-reload
  run systemctl restart "$SERVICE"
  say "  ✓ $SERVICE enabled and restarted with your password"
else
  say '  → Installing panel dependencies'
  run npm ci --prefix "$INSTALL_DIR/dashboard" --omit=dev --ignore-scripts --no-audit --no-fund
  START="$INSTALL_DIR/start-panel.sh"
  if [ "$DRY_RUN" != '1' ]; then
    cat > "$START" <<EOF
#!/usr/bin/env bash
set -euo pipefail
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
set -a
. "\$DIR/panel.env"
set +a
export PORT=${PORT}
cd "\$DIR/dashboard"
exec node server.js
EOF
    chmod +x "$START"
  fi
  say "  ✓ Start script: $START"
  if [ "$NO_START" != '1' ]; then
    say ''
    say '  Starting the panel in the foreground…'
    if [ "$DRY_RUN" != '1' ]; then exec "$START"; fi
  fi
fi

# ── result ─────────────────────────────────────────────────────────────────
if [ "$NO_START" != '1' ] && [ "$USE_SYSTEMD" = '1' ]; then
  say '  → Waiting for the panel…'
  for _ in $(seq 1 30); do
    CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/auth" 2>/dev/null || true)"
    [ "$CODE" = '200' ] && break
    sleep 1
  done
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$LAN_IP" ] || LAN_IP='localhost'
say ''
say '  MCBot Control is installed.'
say "  Open:     http://${LAN_IP}:${PORT}/"
say '  Password: the one you entered (stored in panel.env, mode 600)'
if [ "$USE_SYSTEMD" = '1' ]; then
  say "  Status:   systemctl status $SERVICE"
  say "  Logs:     journalctl -u $SERVICE -n 60 --no-pager"
fi
say ''
