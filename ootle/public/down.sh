#!/usr/bin/env bash
# Takes the router offline: its containers, networks and the model forwarder.
# --purge also deletes its volumes: the router's data (database, API keys, workspaces), the payment ledger and the onion
# addresses. --purge-wallet deletes the router's wallet as well: sweep its funds out first, its keys go with it.
set -uo pipefail
STATE="${XDG_RUNTIME_DIR:-/tmp}/ootlerouter-public"
C="ootlerouter-gate ootlerouter-public ootlerouter-install ootlerouter-pay ootlerouter-relay ootlerouter-tor ootlerouter-tunnel"
N="ootlerouter-front ootlerouter-back ootlerouter-egress ootlerouter-public-net"
V="ootlerouter-public-data ootlerouter-pay ootlerouter-tor ootlerouter-secrets"
[ "${1:-}" = "--purge-wallet" ] && V="$V ootlerouter-wallet"
docker rm -f $C >/dev/null 2>&1
docker network rm $N >/dev/null 2>&1
[ -f "$STATE/forwarder.pid" ] && kill "$(cat "$STATE/forwarder.pid")" 2>/dev/null
rm -rf "$STATE"
[[ "${1:-}" == --purge* ]] && docker volume rm $V >/dev/null 2>&1
echo "[down] left behind:"
docker ps -a --format '{{.Names}}' | grep -xE "${C// /|}" || echo "  no containers"
docker network ls --format '{{.Name}}' | grep -xE "${N// /|}" || echo "  no networks"
docker volume ls --format "{{.Name}}" | grep -xE "${V// /|}|ootlerouter-wallet" || echo "  no volumes"
