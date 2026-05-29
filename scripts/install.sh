#!/usr/bin/env sh
# jg-local-relay installer — Mac & Linux. Curl + run:
#
#   curl -fsSL https://cp.jaagaa.ai/install-relay.sh | sh
#
# Or with the token + projects pre-set (skip the prompt):
#
#   JG_RELAY_TOKEN=… JG_RELAY_PROJECTS=jaagaa,cricket \
#     curl -fsSL https://cp.jaagaa.ai/install-relay.sh | sh
#
# Re-running upgrades in place — same paths, same autostart unit.

set -eu

CP_URL="${JG_CP_URL:-wss://cp.jaagaa.ai/relay}"
SRC_URL="${JG_RELAY_SRC:-https://cp.jaagaa.ai/relay-bundle.tar.gz}"
PROJECTS="${JG_RELAY_PROJECTS:-}"
TOKEN="${JG_RELAY_TOKEN:-}"

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="mac" ;;
  Linux)  PLATFORM="linux" ;;
  *) echo "jg-local-relay: unsupported OS \"$OS\" — Mac/Linux only (use install.ps1 for Windows)" >&2; exit 1 ;;
esac

# Resolve a stable install root per platform.
if [ "$PLATFORM" = "mac" ]; then
  PREFIX="${HOME}/Library/Application Support/jg-local-relay"
  LOG_DIR="${HOME}/Library/Logs/jg-local-relay"
else
  PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/jg-local-relay"
  LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/jg-local-relay"
fi
mkdir -p "$PREFIX" "$LOG_DIR"

# Need node + npm to run the agent. Don't auto-install — fail clearly.
have() { command -v "$1" >/dev/null 2>&1; }
if ! have node; then
  echo "jg-local-relay: Node.js 20+ is required (install via https://nodejs.org or your package manager) — aborting." >&2
  exit 1
fi
NODE_BIN="$(command -v node)"

# Default the relay id to the short hostname (lowercased).
RELAY_ID="${JG_RELAY_ID:-$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo relay)}"

# Token: env or prompt. Refuse to write a unit with an empty token.
if [ -z "$TOKEN" ]; then
  if [ -t 0 ]; then
    printf "Paste your JG_RELAY_TOKEN (from cp.jaagaa.ai → Settings → Relays): "
    read -r TOKEN
  fi
fi
if [ -z "$TOKEN" ]; then
  echo "jg-local-relay: JG_RELAY_TOKEN is required — re-run with JG_RELAY_TOKEN=… or paste when prompted." >&2
  exit 1
fi

# Projects: env or prompt. Empty means "all" on the cp side.
if [ -z "$PROJECTS" ] && [ -t 0 ]; then
  printf "Projects this machine serves (comma-separated, blank = all): "
  read -r PROJECTS
fi

echo "→ Downloading agent bundle from $SRC_URL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if have curl; then
  curl -fsSL "$SRC_URL" -o "$TMP/bundle.tar.gz"
elif have wget; then
  wget -q "$SRC_URL" -O "$TMP/bundle.tar.gz"
else
  echo "jg-local-relay: neither curl nor wget available — aborting." >&2
  exit 1
fi
tar -xzf "$TMP/bundle.tar.gz" -C "$PREFIX"

echo "→ Installing Node dependencies"
( cd "$PREFIX" && npm install --omit=dev --no-fund --no-audit --silent )

if [ "$PLATFORM" = "mac" ]; then
  PLIST="${HOME}/Library/LaunchAgents/ai.jaagaa.localrelay.plist"
  mkdir -p "${HOME}/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.jaagaa.localrelay</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PREFIX}/src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>${PREFIX}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JG_CP_URL</key><string>${CP_URL}</string>
    <key>JG_RELAY_TOKEN</key><string>${TOKEN}</string>
    <key>JG_RELAY_ID</key><string>${RELAY_ID}</string>
    <key>JG_RELAY_PROJECTS</key><string>${PROJECTS}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/err.log</string>
</dict>
</plist>
PLIST_END
  chmod 600 "$PLIST"
  # Reload to pick up changes (unload first in case of upgrade).
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "✔ LaunchAgent loaded (ai.jaagaa.localrelay)"
else
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  UNIT="$UNIT_DIR/jg-local-relay.service"
  cat > "$UNIT" <<UNIT_END
[Unit]
Description=jg-local-relay — control-plane dial-home agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${NODE_BIN} ${PREFIX}/src/index.js
WorkingDirectory=${PREFIX}
Restart=always
RestartSec=3
Environment=JG_CP_URL=${CP_URL}
Environment=JG_RELAY_TOKEN=${TOKEN}
Environment=JG_RELAY_ID=${RELAY_ID}
Environment=JG_RELAY_PROJECTS=${PROJECTS}
StandardOutput=append:${LOG_DIR}/out.log
StandardError=append:${LOG_DIR}/err.log

[Install]
WantedBy=default.target
UNIT_END
  chmod 600 "$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now jg-local-relay.service
  echo "✔ systemd user unit enabled (jg-local-relay.service)"
fi

# Brief handshake verification — tail the log for the "connected" line.
echo "→ Verifying handshake…"
i=0
while [ "$i" -lt 10 ]; do
  if grep -q "registered with cp" "$LOG_DIR/out.log" 2>/dev/null; then
    echo "✔ Connected to $CP_URL as \"$RELAY_ID\" (projects: ${PROJECTS:-all})"
    exit 0
  fi
  sleep 1
  i=$((i + 1))
done
echo "⚠ Did not see \"registered with cp\" in $LOG_DIR/out.log within 10s — check the log for errors." >&2
tail -20 "$LOG_DIR/out.log" 2>/dev/null || true
tail -20 "$LOG_DIR/err.log" 2>/dev/null || true
exit 1
