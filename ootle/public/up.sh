#!/usr/bin/env bash
# Runs ootleRouter as a Tor onion service: payers reach it without learning where it runs, and the router's container
# can reach nothing but its model and its payment service. See ootle/public/README.md.
#
#   ootle/public/up.sh <env file>      then   ootle/public/down.sh [--purge]
#
# The env file (example.env lists every setting). Only the docker command is needed on this machine.
set -euo pipefail
ENV_FILE="${1:?usage: up.sh <env file>}"
# shellcheck disable=SC1090
source "$ENV_FILE"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
KEYS="${OR_KEYS_DIR:-$HOME/.config/ootlerouter}"
STATE="${XDG_RUNTIME_DIR:-/tmp}/ootlerouter-public"
mkdir -p "$STATE" && install -d -m 700 "$KEYS"
IMAGE="${OR_IMAGE:-ghcr.io/alex3000-ai/ootlerouter:latest}" EDGE="${OR_EDGE_IMAGE:-ghcr.io/alex3000-ai/ootlerouter-edge:latest}"
if [ "${OR_BUILD:-}" = 1 ]; then
  echo "[up] building the images from this checkout"
  IMAGE=ootlerouter:local EDGE=ootlerouter-edge:local
  docker build -q -t "$IMAGE" "$ROOT" >/dev/null
  docker build -q -f "$HERE/Dockerfile" -t "$EDGE" "$ROOT" >/dev/null
else
  echo "[up] images: $IMAGE, $EDGE"
  docker pull -q "$IMAGE" >/dev/null && docker pull -q "$EDGE" >/dev/null
fi
edge() { docker run --rm "$EDGE" "$@"; }
DEPLOYMENT="${OR_DEPLOYMENT:-esmeralda.json}" DEPLOYMENT="${DEPLOYMENT##*/}"
read -r NETWORK INDEXER < <(edge node -p "const d = require('/app/ootle/deployments/$DEPLOYMENT'); d.network + ' ' + d.indexer")
INDEXER_HOST="${INDEXER#*://}" INDEXER_HOST="${INDEXER_HOST%%[:/]*}"
# The console's password: yours, or one made here once and kept beside the onion key.
PASSWORD_FILE="${OR_PASSWORD_FILE:-$KEYS/console-password}"
[ -s "$PASSWORD_FILE" ] || (umask 077; edge node -p 'require("crypto").randomBytes(24).toString("base64url")' > "$PASSWORD_FILE")
# gVisor enforces the router's agent-egress rule only with --net-raw: a runtime of that name (README.md), else runc.
RUNTIME="${OR_RUNTIME:-$(docker info -f '{{json .Runtimes}}' | grep -q '"runsc-netraw"' && echo runsc-netraw || echo runc)}"

# Three networks, none with a route out. front: Tor, the gate, the router. back: the router, its payment service, the
# relay's model port. egress: Tor's SOCKS port, the relay's indexer port, the payment service. The router is on
# front and back only, so it can reach neither Tor's SOCKS port nor the indexer.
FRONT=ootlerouter-front BACK=ootlerouter-back EGRESS=ootlerouter-egress
TOR_F=172.31.250.2 ROUTER_F=172.31.250.3 GATE_F=172.31.250.4
RELAY_B=172.31.251.2 ROUTER_B=172.31.251.3 PAY_B=172.31.251.5
TOR_E=172.31.252.2 RELAY_E=172.31.252.3 PAY_E=172.31.252.5
# Isolated, not just internal: an internal network still gives this machine an address on it, through which a container
# reaches every service here that listens on all addresses. Isolated (Docker >= 28) gives it none.
for n in "$FRONT 172.31.250.0/24" "$BACK 172.31.251.0/24" "$EGRESS 172.31.252.0/24"; do
  set -- $n
  docker network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated --subnet "$2" "$1" >/dev/null
done

echo "[up] tor: the API onion -> gate, the console onion (client authorization) -> router, SOCKS for egress only"
if [ ! -s "$KEYS/console.pub" ]; then
  edge node -e '
    const k = require("crypto").generateKeyPairSync("x25519"), b32 = (b) => { let bits = "", out = "";
      for (const x of b) bits += x.toString(2).padStart(8, "0");
      for (let i = 0; i < bits.length; i += 5) out += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
      return out; };
    const raw = (key, f) => Buffer.from(key.export({ format: "jwk" })[f], "base64url");
    console.log(b32(raw(k.publicKey, "x")), b32(raw(k.privateKey, "d")));' | {
    read -r pub priv; (umask 077; echo "$pub" > "$KEYS/console.pub"; echo "$priv" > "$KEYS/console.priv"); }
fi
docker run --rm -v ootlerouter-tor:/home/edge/tor "$EDGE" sh -c \
  "install -d -m 700 /home/edge/tor/console /home/edge/tor/console/authorized_clients /home/edge/tor/api &&
   echo descriptor:x25519:$(cat "$KEYS/console.pub") > /home/edge/tor/console/authorized_clients/operator.auth"
docker create --name ootlerouter-tor --network bridge -v ootlerouter-tor:/home/edge/tor --restart unless-stopped \
  --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp "$EDGE" \
  tor --DataDirectory /home/edge/tor --SocksPort "$TOR_E:9050" --SocksPolicy "accept 172.31.252.0/24, reject *" \
  --HiddenServiceDir /home/edge/tor/api --HiddenServicePort "80 $GATE_F:8080" --HiddenServicePoWDefensesEnabled 1 \
  --HiddenServiceDir /home/edge/tor/console --HiddenServicePort "80 $ROUTER_F:3000" --HiddenServicePoWDefensesEnabled 1 >/dev/null
docker network connect --ip "$TOR_F" "$FRONT" ootlerouter-tor
docker network connect --ip "$TOR_E" "$EGRESS" ootlerouter-tor
docker start ootlerouter-tor >/dev/null

echo "[up] relay: $INDEXER_HOST:443 through Tor${OR_MODEL_PORT:+, the model on 127.0.0.1:$OR_MODEL_PORT}"
RELAY=("$RELAY_E:443=$INDEXER_HOST:443/tor")
if [ -n "${OR_MODEL_PORT:-}" ]; then
  # The model listens on this machine's loopback; a forwarder on the Docker bridge's address (and only there) lets
  # the relay reach it. It's the one container on the host's network, running relay.mjs and nothing else.
  BRIDGE_IP="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')"
  docker run -d --name ootlerouter-forwarder --network host --restart unless-stopped \
    --cap-drop ALL --security-opt no-new-privileges --read-only "$EDGE" \
    node /app/ootle/public/relay.mjs "$BRIDGE_IP:$OR_MODEL_PORT=127.0.0.1:$OR_MODEL_PORT" >/dev/null
  RELAY+=("$RELAY_B:$OR_MODEL_PORT=$BRIDGE_IP:$OR_MODEL_PORT")
fi
docker create --name ootlerouter-relay --network "$EGRESS" --ip "$RELAY_E" --restart unless-stopped \
  --cap-drop ALL --security-opt no-new-privileges --read-only "$EDGE" \
  node /app/ootle/public/relay.mjs --socks "$TOR_E:9050" "${RELAY[@]}" >/dev/null
docker network connect --ip "$RELAY_B" "$BACK" ootlerouter-relay
[ -n "${OR_MODEL_PORT:-}" ] && docker network connect bridge ootlerouter-relay
docker start ootlerouter-relay >/dev/null

echo "[up] payments: the router's wallet and payment service, the indexer reached only through the relay"
PAY_TOKEN="$(edge node -p 'require("crypto").randomBytes(32).toString("hex")')"
docker create --name ootlerouter-pay --network "$EGRESS" --ip "$PAY_E" --restart unless-stopped \
  --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp \
  --add-host "$INDEXER_HOST:$RELAY_E" ${OR_WALLETD_BIN:+-v "$OR_WALLETD_BIN:/opt/walletd/tari_ootle_walletd:ro"} \
  -v ootlerouter-wallet:/home/edge/wallet -v ootlerouter-pay:/home/edge/pay \
  -e NETWORK="$NETWORK" -e INDEXER="$INDEXER" -e OOTLE_ACCOUNT="${OR_ACCOUNT:-router}" -e OOTLE_PAY_TOKEN="$PAY_TOKEN" \
  -e OOTLE_PAY_HOST="$PAY_B" -e OOTLE_PAY_LEDGER=/home/edge/pay/ootle-pay.json \
  -e OOTLE_LANES_DEPLOYMENT="/app/ootle/deployments/$DEPLOYMENT" \
  ${OOTLE_RESERVE:+-e OOTLE_RESERVE} ${OOTLE_CLAIM_MIN:+-e OOTLE_CLAIM_MIN} ${OOTLE_CLAIM_FEE:+-e OOTLE_CLAIM_FEE} ${OOTLE_CLAIM_EVERY_S:+-e OOTLE_CLAIM_EVERY_S} \
  "$EDGE" /app/ootle/public/pay.sh >/dev/null
docker network connect --ip "$PAY_B" "$BACK" ootlerouter-pay
docker start ootlerouter-pay >/dev/null
for _ in $(seq 1 120); do docker logs ootlerouter-pay 2>&1 | grep -qE 'ready;|fund it' && break; sleep 2; done
docker logs ootlerouter-pay 2>&1 | grep '^\[' || true

# The token the router presents to the payment service, in a volume of root's (mode 600) mounted read-only.
echo "$PAY_TOKEN" | docker run --rm -i --user 0 -v ootlerouter-secrets:/s "$EDGE" sh -c 'umask 077; cat > /s/pay-token'
ROUTER_ARGS=(--runtime "$RUNTIME" -v ootlerouter-public-data:/data -v ootlerouter-secrets:/run/ootle:ro
  --hostname ootlerouter -e TZ=UTC --cpus "${OR_CPUS:-4}" --memory "${OR_MEMORY:-8g}" --pids-limit 4096
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL
  --cap-add NET_ADMIN --cap-add NET_RAW --cap-add SETPCAP --security-opt no-new-privileges -e HR_TASK_EGRESS=loopback
  -e HR_AUTH_PASSWORD="$(cat "$PASSWORD_FILE")" -e HR_BACKENDS="${OR_BACKENDS:-opencode}"
  -e OOTLE_PAY_URL="http://$PAY_B:8090" -e OOTLE_PAY_TOKEN_FILE=/run/ootle/pay-token
  -e OOTLE_CORS_ORIGINS="${OR_CORS_ORIGINS:-https://ootlebook.com}")

# The model on this machine, through the relay, as a custom integration serving OR_MODEL (its id on the server) to
# every harness that speaks OpenAI chat; the console can add others.
if [ -n "${OR_MODEL_PORT:-}" ]; then
  ROUTER_ARGS+=(-e "HR_SECRET_GLOBAL_HARNESS_INTEGRATIONS=[{\"name\":\"local\",\"provider\":\"custom\",\"rows_v\":2,
    \"config\":{\"api_format\":\"openai\",\"base_url\":\"http://$RELAY_B:$OR_MODEL_PORT/v1\",\"api_key\":\"none\"},
    \"models\":[{\"canonical\":\"${OR_MODEL:?OR_MODEL_PORT needs OR_MODEL}\",\"provider_id\":\"$OR_MODEL\"}]}]")
fi

if ! docker volume inspect ootlerouter-public-data >/dev/null 2>&1; then
  echo "[up] first start: harnesses install into the data volume, in a container of its own that then goes away"
  docker run -d --name ootlerouter-install --network bridge "${ROUTER_ARGS[@]}" "$IMAGE" >/dev/null
  for _ in $(seq 1 360); do docker logs ootlerouter-install 2>&1 | grep -q 'ready on' && break; sleep 5; done
  docker logs ootlerouter-install 2>&1 | grep -E 'backends|ready on' || true
  docker rm -f ootlerouter-install >/dev/null
fi

echo "[up] router ($RUNTIME): on front and back only"
[[ "$RUNTIME" == runsc* ]] || echo "[up] WARN: no gVisor (runsc-netraw): agent tasks share this machine's kernel. See README.md."
docker create --name ootlerouter-public --network "$FRONT" --ip "$ROUTER_F" --restart unless-stopped \
  "${ROUTER_ARGS[@]}" "$IMAGE" >/dev/null
docker network connect --ip "$ROUTER_B" "$BACK" ootlerouter-public
docker start ootlerouter-public >/dev/null
for _ in $(seq 1 120); do docker logs ootlerouter-public 2>&1 | grep -qE 'ready on|ERROR' && break; sleep 5; done
docker logs ootlerouter-public 2>&1 | grep -E 'ERROR|egress|ready on|backends' | sort -u || true
if ! docker logs ootlerouter-public 2>&1 | grep -q 'ready on'; then
  echo "[up] the router didn't start; nothing is published. Fix the above, then ootle/public/down.sh and up.sh again."
  docker rm -f ootlerouter-public >/dev/null
  exit 1
fi

echo "[up] gate: the API onion's only path, /api/harness/v1/"
docker run -d --name ootlerouter-gate --network "$FRONT" --ip "$GATE_F" --restart unless-stopped \
  --cap-drop ALL --security-opt no-new-privileges --read-only "$EDGE" \
  node /app/ootle/public/gate.mjs "$GATE_F:8080" "$ROUTER_F:3000" >/dev/null

for _ in $(seq 1 60); do docker exec ootlerouter-tor test -s /home/edge/tor/console/hostname && break; sleep 2; done
API="$(docker exec ootlerouter-tor cat /home/edge/tor/api/hostname)"
CONSOLE="$(docker exec ootlerouter-tor cat /home/edge/tor/console/hostname)"
(umask 077; echo "${CONSOLE%.onion}:descriptor:x25519:$(cat "$KEYS/console.priv")" > "$KEYS/console.auth_private")
echo "http://$API" > "$STATE/url"
echo "[up] API (for payers):  http://$API/api/harness"
echo "[up] console (you):     http://$CONSOLE   (Tor Browser asks for the key in $KEYS/console.priv;"
echo "                         a tor client takes $KEYS/console.auth_private in its ClientOnionAuthDir)"
