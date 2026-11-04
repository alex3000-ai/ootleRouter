#!/usr/bin/env bash
# Runs ootleRouter on a public HTTPS address for a test, isolated from this machine. See ootle/public/README.md.
#
#   ootle/public/up.sh <env file>      then   ootle/public/down.sh [--purge]
#
# The env file (keep it out of git; mode 600) sets:
#   OR_PASSWORD_FILE   file holding the console password
#   OR_WALLETD_TOKEN_FILE  file holding a walletd API key scoped to the provider account (never an admin token)
#   OR_PROVIDER_KEY    the provider account's public key        OR_ACCOUNT  its walletd account name
#   OR_DEPLOYMENT      deployments/<network>.json for the lanes component
#   OR_WALLETD_PORT    walletd's port on this machine (127.0.0.1)   OR_MODEL_PORT  the model server's port (127.0.0.1)
#   OR_INDEXER_HOST    the indexer's host name (HTTPS)               OR_BACKENDS    harnesses to install (opencode)
#
# What it builds: a Docker network with no route out (internal) holding the router; a relay that is the router's
# only door, passing exactly three things (the model, walletd, the indexer); a Cloudflare quick tunnel that
# publishes the console's port and nothing else. No port opens on this machine. The model and walletd listen on
# 127.0.0.1, so a small forwarder exposes those two on the Docker bridge address for the relay.
set -euo pipefail
ENV_FILE="${1:?usage: up.sh <env file>}"
# shellcheck disable=SC1090
source "$ENV_FILE"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
NET=ootlerouter-public-net SUBNET=172.31.250.0/24 RELAY_IP=172.31.250.2 ROUTER_IP=172.31.250.3
BRIDGE_IP="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')"
STATE="${XDG_RUNTIME_DIR:-/tmp}/ootlerouter-public"; mkdir -p "$STATE"

echo "[up] forwarder: $BRIDGE_IP:{$OR_MODEL_PORT,$OR_WALLETD_PORT} -> 127.0.0.1"
# Bound to the bridge address only (relay.mjs listens on every address, which is right inside its container).
setsid node -e '
  const net = require("node:net"); const [ip, ...ports] = process.argv.slice(1);
  for (const p of ports.map(Number)) net.createServer((s) => { const o = net.createConnection({ host: "127.0.0.1", port: p });
    s.pipe(o).pipe(s); const c = () => { s.destroy(); o.destroy(); }; s.on("error", c); o.on("error", c); }).listen(p, ip);
' "$BRIDGE_IP" "$OR_MODEL_PORT" "$OR_WALLETD_PORT" >/dev/null 2>&1 &
echo $! > "$STATE/forwarder.pid"

echo "[up] network $NET (internal: no route out)"
docker network create --internal --subnet "$SUBNET" "$NET" >/dev/null

echo "[up] relay: model, walletd, $OR_INDEXER_HOST:443 and nothing else"
docker run -d --name ootlerouter-relay --network bridge --add-host host.docker.internal:host-gateway \
  -v "$HERE/relay.mjs:/relay.mjs:ro" node:22-slim node /relay.mjs \
  "$OR_MODEL_PORT=host.docker.internal:$OR_MODEL_PORT" "$OR_WALLETD_PORT=host.docker.internal:$OR_WALLETD_PORT" \
  "443=$OR_INDEXER_HOST:443" >/dev/null
docker network connect --ip "$RELAY_IP" "$NET" ootlerouter-relay

echo "[up] router (first start on the bridge to install its harnesses, then cut off)"
docker run -d --name ootlerouter-public --network bridge -v ootlerouter-public-data:/data \
  -v "$ROOT/ootle/$OR_DEPLOYMENT:/app/ootle/deployments/public.json:ro" \
  --add-host "$OR_INDEXER_HOST:$RELAY_IP" \
  -e HR_AUTH_PASSWORD="$(cat "$OR_PASSWORD_FILE")" -e HR_BACKENDS="${OR_BACKENDS:-opencode}" \
  -e OOTLE_PROVIDER_KEY="$OR_PROVIDER_KEY" -e OOTLE_ACCOUNT="$OR_ACCOUNT" \
  -e OOTLE_LANES_DEPLOYMENT=/app/ootle/deployments/public.json \
  -e WALLETD_URL="http://$RELAY_IP:$OR_WALLETD_PORT/json_rpc" -e WALLETD_TOKEN="$(cat "$OR_WALLETD_TOKEN_FILE")" \
  -e OOTLE_CORS_ORIGINS="${OR_CORS_ORIGINS:-https://ootlebook.com}" \
  ootlerouter:local >/dev/null
docker network connect --ip "$ROUTER_IP" "$NET" ootlerouter-public
for _ in $(seq 1 180); do docker logs ootlerouter-public 2>&1 | grep -q 'ready on' && break; sleep 5; done
docker logs ootlerouter-public 2>&1 | grep -E 'ootle-pay|ready on|backends' || true
docker network disconnect bridge ootlerouter-public

echo "[up] tunnel"
docker run -d --name ootlerouter-tunnel --network bridge cloudflare/cloudflared:latest \
  tunnel --no-autoupdate --url "http://$ROUTER_IP:3000" >/dev/null
docker network connect "$NET" ootlerouter-tunnel
for _ in $(seq 1 30); do URL="$(docker logs ootlerouter-tunnel 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)"; [ -n "$URL" ] && break; sleep 2; done
echo "${URL:?no tunnel URL}" > "$STATE/url"
echo "[up] public: $URL   (API base: $URL/api/harness)"
