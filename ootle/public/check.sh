#!/usr/bin/env bash
# Checks a running router (after up.sh) the way an attacker inside it would, and prints PASS or FAIL for each promise
# README.md makes.   ootle/public/check.sh [--tor]      --tor also visits both onions from a fresh Tor client.
set -uo pipefail
R=ootlerouter-public FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
docker inspect "$R" >/dev/null 2>&1 || { echo "no router running: start it with ootle/public/up.sh"; exit 1; }

# Tries each host:port from inside the router as one user; prints "host:port open|closed".
probe() {
  local uid="$1"; shift
  docker exec -u "$uid" "$R" node -e '
    const net = require("net");
    for (const t of process.argv.slice(1)) { const [h, p] = t.split(":"); const s = net.connect({ host: h, port: +p });
      let said = false; const say = (r) => { if (said) return; said = true; s.destroy(); console.log(t, r); }; s.on("connect", () => say("open")).on("error", () => say("closed"));
      setTimeout(() => say("closed"), 3000).unref(); }' "$@" 2>/dev/null
}
expect() {  # expect <uid> <who> <open|closed> <what> host:port...
  local uid="$1" who="$2" want="$3" what="$4"; shift 4
  while read -r t got; do
    [ "$got" = "$want" ] && pass "$who: $what $t is $got" || fail "$who: $what $t is $got (should be $want)"
  done < <(probe "$uid" "$@")
}

runtime="$(docker inspect -f '{{.HostConfig.Runtime}}' "$R")"
[[ "$runtime" == runsc* ]] && pass "router runs under gVisor ($runtime)" || echo "WARN  router runs under $runtime, not gVisor: agents share this machine's kernel"
docker logs "$R" 2>&1 | grep -q 'agent egress: only root' && pass "agent egress rule is in place" || fail "agent egress rule is missing"

MODEL="$(docker inspect -f '{{join .Args " "}}' ootlerouter-relay 2>/dev/null | grep -oE '172\.31\.251\.2:[0-9]+' | head -1)"
OUTSIDE=(1.1.1.1:443 8.8.8.8:53 172.17.0.1:22 172.31.250.1:22 172.31.251.1:22 172.31.252.2:9050 172.31.252.3:443)
LAN="$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')"; [ -n "$LAN" ] && OUTSIDE+=("$LAN:80")
PIPE=(172.31.251.5:8090 172.31.250.4:8080 ${MODEL:+"$MODEL"})

expect 20001 "an agent" closed "the internet, LAN, this machine, Tor and the indexer:" "${OUTSIDE[@]}"
expect 20001 "an agent" closed "the pipeline (model, payments, gate):" "${PIPE[@]}"
expect 20001 "an agent" open "its own container's loopback:" 127.0.0.1:8080
expect 0 "the runner" closed "the internet, LAN, this machine, Tor and the indexer:" "${OUTSIDE[@]}"
expect 0 "the runner" open "the pipeline:" "${PIPE[@]}"
if [ -n "$MODEL" ]; then
  docker exec "$R" curl -fsS -m 20 "http://$MODEL/v1/models" >/dev/null 2>&1 && pass "your model answers the runner through the relay" ||
    fail "your model doesn't answer at $MODEL (is it running on 127.0.0.1, and does the firewall let docker0 reach it?)"
fi

docker exec -u 20001 "$R" cat /run/ootle/pay-token >/dev/null 2>&1 && fail "an agent can read the payment token" || pass "an agent can't read the payment token"
bnd="$(docker exec "$R" sh -c 'grep CapBnd /proc/$(pgrep -f "uvicorn server:app" | head -1)/status' | awk '{print $2}')"
(( (0x${bnd:-ffffffff} >> 12) & 1 )) && fail "the runner could still change the firewall (NET_ADMIN)" || pass "no process can change the firewall (NET_ADMIN gone)"

gate() { docker exec ootlerouter-gate node -e 'fetch("http://172.31.250.4:8080" + process.argv[1]).then((r) => console.log(r.status))' "$1" 2>/dev/null; }
for p in / /login /api/harness/v1/../../login /api/harness/v1/..%2f..%2flogin; do
  [ "$(gate "$p")" = 404 ] && pass "the public onion doesn't reach $p" || fail "the public onion reaches $p"
done
[ "$(gate /api/harness/v1/models)" = 401 ] && pass "the public onion reaches the API, which wants a key" || fail "the public onion doesn't reach the API"

if [ "${1:-}" = --tor ]; then
  API="$(docker exec ootlerouter-tor cat /home/edge/tor/api/hostname)" CON="$(docker exec ootlerouter-tor cat /home/edge/tor/console/hostname)"
  EDGE="$(docker inspect -f '{{.Config.Image}}' ootlerouter-tor)"
  echo "....  visiting both onions from a fresh Tor client (a minute or two)"
  out="$(docker run --rm --entrypoint sh "$EDGE" -c "tor --SocksPort 127.0.0.1:9050 >/dev/null 2>&1 &
    node /app/ootle/public/relay.mjs --socks 127.0.0.1:9050 127.0.0.1:8001=$API:80/tor 127.0.0.1:8002=$CON:80/tor >/dev/null &
    sleep 20; node -e '
      const go = async (port, path) => { for (let i = 0; i < 8; i++) try { return (await fetch(\"http://127.0.0.1:\" + port + path, { signal: AbortSignal.timeout(45000) })).status; } catch { await new Promise((r) => setTimeout(r, 5000)); } return \"none\"; };
      (async () => console.log(await go(8001, \"/api/harness/v1/models\"), await go(8001, \"/login\"), await go(8002, \"/login\")))()'")"
  read -r api login console <<<"$out"
  [ "$api" = 401 ] && pass "over Tor, the API onion answers (401 without a key)" || fail "over Tor, the API onion answered $api"
  [ "$login" = 404 ] && pass "over Tor, the API onion has no console" || fail "over Tor, the API onion's /login answered $login"
  [ "$console" = none ] && pass "over Tor, the console onion can't be reached without your key" || fail "over Tor, the console onion answered $console without the key"
fi

echo; [ "$FAILS" = 0 ] && echo "all checks passed" || echo "$FAILS check(s) failed"
exit "$FAILS"
