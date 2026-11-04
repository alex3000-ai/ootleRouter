#!/usr/bin/env bash
# Takes the public test offline: the tunnel, the router, the relay, their network and the forwarder.
# --purge also deletes the router's data volume (its database, API keys, payment ledger and workspaces).
set -uo pipefail
STATE="${XDG_RUNTIME_DIR:-/tmp}/ootlerouter-public"
docker rm -f ootlerouter-tunnel ootlerouter-public ootlerouter-relay 2>/dev/null
docker network rm ootlerouter-public-net 2>/dev/null
[ -f "$STATE/forwarder.pid" ] && kill "$(cat "$STATE/forwarder.pid")" 2>/dev/null
rm -rf "$STATE"
[ "${1:-}" = "--purge" ] && docker volume rm ootlerouter-public-data 2>/dev/null
echo "[down] left behind:"
docker ps -a --format '{{.Names}}' | grep -E '^ootlerouter-(tunnel|public|relay)$' || echo "  no containers"
docker network ls --format '{{.Name}}' | grep -x ootlerouter-public-net || echo "  no network"
docker volume ls --format '{{.Name}}' | grep -x ootlerouter-public-data || echo "  no volume"
