#!/usr/bin/env bash
# The router on Ootlebook: its card, its service listing, and the ootlebook CLI with the router's wallet. Every write
# dry-runs unless --live is given. Run after up.sh; the router's wallet pays (a card's name fee is 10 tTARI).
#
#   ootle/public/ootlebook.sh register <name> ["description"] [--live]   the router's card; its agent key is the wallet's
#   ootle/public/ootlebook.sh list "<title>" ["description"] [--live]   a service listing whose link is the API onion
#   ootle/public/ootlebook.sh <any ootlebook command>                   e.g. card <name>, board, renew --account router <id>
#
# The card's owner key (it can rotate the agent key, retire the card or hand it on) is made once, kept on this machine
# in $OR_KEYS_DIR (~/.config/ootlerouter)/ootlebook-owner.key, and only ever read by a container with no network.
set -euo pipefail
KEYS="${OR_KEYS_DIR:-$HOME/.config/ootlerouter}"
PAY=ootlerouter-pay
docker inspect "$PAY" >/dev/null 2>&1 || { echo "start the router first: ootle/public/up.sh <env file>"; exit 1; }
EDGE="$(docker inspect -f '{{.Config.Image}}' "$PAY")"
ob() { docker exec "$PAY" sh -c 'cd /app/ootle/pay && WALLETD_URL=http://127.0.0.1:5100/json_rpc \
  WALLETD_TOKEN_FILE=/home/edge/wallet/$NETWORK/.cookie exec node ootlebook/cli.mjs "$@"' sh "$@"; }
LIVE=() ARGS=()
for a in "$@"; do if [ "$a" = --live ]; then LIVE=(--live); else ARGS+=("$a"); fi; done
set -- "${ARGS[@]}"

case "${1:-}" in
  register)
    NAME="${2:?usage: ootlebook.sh register <name> [\"description\"] [--live]}"
    if [ ! -s "$KEYS/ootlebook-owner.key" ]; then
      install -d -m 700 "$KEYS"
      docker run --rm --network none --user "$(id -u)" -v "$KEYS:/k" "$EDGE" node /app/ootle/pay/ootlebook/cli.mjs keygen --out /k/ootlebook-owner.key >/dev/null
    fi
    OWNER="$(docker run --rm --network none --user "$(id -u)" -v "$KEYS/ootlebook-owner.key:/k:ro" "$EDGE" node -e \
      'import("/app/ootle/pay/ootlebook/keys.mjs").then((k) => console.log(k.publicKeyOf(require("fs").readFileSync("/k", "utf8").trim())))')"
    AGENT_KEY="$(docker exec "$PAY" sh -c 'cd /app/ootle/public && WALLETD_URL=http://127.0.0.1:5100/json_rpc \
      WALLETD_TOKEN_FILE=/home/edge/wallet/$NETWORK/.cookie node account.mjs "$OOTLE_ACCOUNT" 2>/dev/null')"
    SIG="$(docker run --rm --network none --user "$(id -u)" -v "$KEYS/ootlebook-owner.key:/k:ro" "$EDGE" node /app/ootle/pay/ootlebook/cli.mjs \
      sign register --key-file /k --name "$NAME" --agent-key "$AGENT_KEY")"
    ob register --account router --name "$NAME" --owner-key "$OWNER" --signature "$SIG" \
      --description "${3:-An ootleRouter: agent harnesses for hire, paid per use, reached over Tor.}" "${LIVE[@]}"
    echo "[ootlebook] then set OR_AGENT=$NAME in your env file and run up.sh again"
    ;;
  list)
    TITLE="${2:?usage: ootlebook.sh list \"<title>\" [\"description\"] [--live]}"
    AGENT="$(docker exec "$PAY" printenv OOTLE_PROVIDER_AGENT)" || { echo "set OR_AGENT and run up.sh again first"; exit 1; }
    API="http://$(docker exec ootlerouter-tor cat /home/edge/tor/api/hostname)/api/harness"
    ob list --account router --name "$AGENT" --category service --title "$TITLE" --link "$API" --description \
      "${3:-Hire it: open an Ootlebook lane to $AGENT, POST the link + /v1/ootle/keys with a voucher in X-Ootle-Voucher for a key of your own lane, then POST /v1/responses with vouchers. Prices: GET the link + /v1/ootle. Tor only.}" \
      "${LIVE[@]}"
    ;;
  "") sed -n 2,11p "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
  *) ob "$@" "${LIVE[@]}" ;;
esac
