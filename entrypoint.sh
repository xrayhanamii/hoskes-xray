#!/bin/sh
# Hostless entrypoint: xray (VLESS+XHTTP) + Node front proxy.
# Env vars (set in the Hostless console, NOT in this repo):
#   UUID          required, VLESS client id
#   WS_PATH       required, e.g. /<random-hex>
#   PORT          provided by Hostless, default 8080
#   XRAY_PORT     internal xray listen port, default 10001
#   TRANSPORT     xhttp (default) or ws
# TLS is terminated by Hostless (public URL + auto SSL), so xray
# itself runs with security "none" on localhost only.
# Hostless runs the container with a read-only /app, so the xray binary
# must already be executable in the image (the Dockerfile does chmod +x
# at build time) and the runtime config must go to /tmp, not /app.
# (2026-11-19: first deploy crashed on "chmod: /app/xray-bin/xray:
# Read-only file system" because entrypoint.sh re-chmodded at runtime.)
set -e
cd /app

PORT="${PORT:-8080}"
XRAY_PORT="${XRAY_PORT:-10001}"
WS_PATH="${WS_PATH:-/ws}"
TRANSPORT="${TRANSPORT:-xhttp}"

if [ -z "$UUID" ]; then
  echo "[start] ERROR: UUID env var is not set. Set it in the Hostless console and redeploy." >&2
  exit 1
fi
case "$WS_PATH" in
  /*) ;;
  *) echo "[start] ERROR: WS_PATH must start with /" >&2; exit 1 ;;
esac
if [ "$TRANSPORT" != "ws" ] && [ "$TRANSPORT" != "xhttp" ]; then
  echo "[start] ERROR: TRANSPORT must be ws or xhttp" >&2; exit 1
fi

# Pick the xray binary matching the container CPU architecture.
# Hoskes builds linux/arm64 (2026-11-19: amd64 binary failed with
# "syntax error: unexpected word"); other platforms build amd64.
case "$(uname -m)" in
  aarch64|arm64) XRAY_BIN="/app/xray-bin/xray-arm64" ;;
  *)             XRAY_BIN="/app/xray-bin/xray" ;;
esac
echo "[start] arch=$(uname -m), xray binary=$XRAY_BIN"

"$XRAY_BIN" version 2>&1 | head -1 || true

if [ "$TRANSPORT" = "xhttp" ]; then
  STREAM_JSON="\"network\": \"xhttp\", \"xhttpSettings\": { \"path\": \"$WS_PATH\", \"mode\": \"packet-up\" }, \"security\": \"none\""
else
  STREAM_JSON="\"network\": \"ws\", \"wsSettings\": { \"path\": \"$WS_PATH\" }, \"security\": \"none\""
fi
cat > /tmp/xray-config.json <<EOF
{
  "log": { "loglevel": "info" },
  "inbounds": [
    {
      "port": $XRAY_PORT,
      "listen": "127.0.0.1",
      "protocol": "vless",
      "settings": {
        "clients": [ { "id": "$UUID" } ],
        "decryption": "none"
      },
      "streamSettings": { $STREAM_JSON }
    }
  ],
  "outbounds": [
    { "protocol": "freedom", "tag": "direct" }
  ]
}
EOF
echo "[start] xray config written (transport=$TRANSPORT, xray_port=$XRAY_PORT)"

"$XRAY_BIN" run -config /tmp/xray-config.json 2>&1 &
XRAY_PID=$!
sleep 2
if ! kill -0 "$XRAY_PID" 2>/dev/null; then
  echo "[start] ERROR: xray exited early" >&2
  exit 1
fi
echo "[start] xray running (pid $XRAY_PID), starting Node proxy on port $PORT"
export XRAY_PORT
exec node server.js
