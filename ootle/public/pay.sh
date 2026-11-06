#!/bin/sh
# The payment container: the router's own wallet daemon, on this container's loopback only, and the payment service
# the router calls. The wallet's data, seed password (no OS keyring here) and cookie live in /home/edge/wallet (a volume).
#   env: NETWORK, INDEXER (https URL), and pay/server.mjs's (OOTLE_PAY_TOKEN, OOTLE_PROVIDER_AGENT, ...)
set -eu
W=/home/edge/wallet
umask 077
[ -s "$W/.keyring-pass" ] || node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$W/.keyring-pass"
rm -f "$W/$NETWORK/.cookie"
OOTLE_WALLETD_KEYRING_PASSWORD="$(cat "$W/.keyring-pass")" /opt/walletd/tari_ootle_walletd --base-path "$W" --network "$NETWORK" \
  --authentication webauthn --cookie-auth true --auto-claim-burns false --listen-on 127.0.0.1:5100 -i "$INDEXER" run >"$W/walletd.out" 2>&1 &
i=0; until [ -s "$W/$NETWORK/.cookie" ]; do i=$((i + 1)); [ $i -lt 120 ] || { tail -20 "$W/walletd.out"; exit 1; }; sleep 1; done
export WALLETD_URL=http://127.0.0.1:5100/json_rpc WALLETD_TOKEN_FILE="$W/$NETWORK/.cookie"
node /app/ootle/public/account.mjs "$OOTLE_ACCOUNT" >/dev/null
# Payments start once the router has an Ootlebook card (ootle/public/ootlebook.sh register); until then, only the wallet.
[ -n "${OOTLE_PROVIDER_AGENT:-}" ] || { echo "[pay] no Ootlebook card yet (OR_AGENT): the router takes no paid turns"; wait; }
exec node /app/ootle/pay/server.mjs
