#!/usr/bin/env bash
# Checks this machine is ready to host a router, and prints the commands (with sudo) for anything missing. It runs
# nothing with sudo itself.   ootle/public/setup-host.sh [env file]
set -uo pipefail
[ -n "${1:-}" ] && source "$1"
TODO=()
ok() { echo "ok    $*"; }
todo() { echo "todo  $1"; shift; TODO+=("$@"); }

v="$(docker version -f '{{.Server.Version}}' 2>/dev/null)"
if [ -z "$v" ]; then
  todo "Docker isn't running, or you aren't allowed to use it" "# install Docker Engine: https://docs.docker.com/engine/install/" "sudo usermod -aG docker \$USER   # then log in again"
elif [ "${v%%.*}" -lt 28 ]; then
  todo "Docker $v is too old: isolated networks need 28 or later" "# upgrade Docker Engine: https://docs.docker.com/engine/install/"
else
  ok "Docker $v"
fi

if docker info -f '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc-netraw"'; then
  ok "gVisor runtime runsc-netraw"
else
  command -v runsc >/dev/null || TODO+=(
    "curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg"
    "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main\" | sudo tee /etc/apt/sources.list.d/gvisor.list"
    "sudo apt-get update && sudo apt-get install -y runsc")
  todo "gVisor (runsc) with --net-raw, registered as runsc-netraw: agents then run on gVisor's kernel, not yours" \
    "sudo runsc install --runtime runsc-netraw -- --net-raw" "sudo systemctl reload docker"
fi

if command -v ufw >/dev/null; then
  if systemctl is-active -q ufw 2>/dev/null; then ok "ufw is on (check its rules with: sudo ufw status verbose)"
  else todo "the firewall (ufw) is off: anything listening on all addresses is open to your network" \
    "sudo ufw default deny incoming" "sudo ufw default allow outgoing" "sudo ufw enable"; fi
  [ -n "${OR_MODEL_PORT:-}" ] && echo "note  once, so the relay can reach your model through the firewall:" \
    "sudo ufw allow in on docker0 to 172.17.0.1 port $OR_MODEL_PORT proto tcp"
else
  echo "info  no ufw: make sure a firewall drops incoming connections you didn't ask for"
fi

if [ -n "${OR_MODEL_PORT:-}" ]; then
  if ss -ltnH "sport = :$OR_MODEL_PORT" 2>/dev/null | grep -q '127.0.0.1:'; then ok "a model listens on 127.0.0.1:$OR_MODEL_PORT"
  else echo "info  nothing on 127.0.0.1:$OR_MODEL_PORT yet: start your model there before up.sh"; fi
fi

open="$(ss -ltnH 2>/dev/null | awk '$4 ~ /^(0\.0\.0\.0|\*|\[::\]):/ {print $4}' | sort -u | tr '\n' ' ')"
[ -n "$open" ] && echo "info  listening on all addresses (your network can reach these unless a firewall stops it): $open"

echo
if [ "${#TODO[@]}" = 0 ]; then echo "Ready: ootle/public/up.sh <env file>"; exit 0; fi
echo "Run these, then this script again:"; printf '  %s\n' "${TODO[@]}"; exit 1
