# Ootle payments

ootleRouter charges API callers per use in TARI on [Tari Ootle](https://tari.com), through **OotleRouterLanes**, a
payment-lane contract with no admin and no owner.

A caller escrows TARI in a lane to the router's provider key once, on-chain. Each API request then carries a voucher,
which the caller signs off-chain, for the running total it allows the router to have claimed. The router checks the
voucher, holds a small reserve while the turn runs, and charges the turn's real cost (tokens and minutes, priced in
µT) when it finishes. From time to time the router claims the latest voucher on-chain. The caller can close a lane
and get back whatever wasn't claimed.

The Console's own turns are free; only API-key callers pay.

| Folder | What |
|---|---|
| `template/` | the OotleRouterLanes contract (Rust; `cargo test` runs its engine tests in `tests/`) |
| `pay/server.mjs` | the payment service the gateway asks to admit and charge each turn; also claims vouchers |
| `pay/cli.mjs` | `ootlerouter-lanes`: open, fund, close and refund lanes; sign vouchers; claim |
| `prices.json` | µT per `harness.session_minute` and per 1k tokens (`llm.<model>.<kind>`; `llm.*.<kind>` for any model) |
| `deploy/publish.mjs` | publishes the contract and creates the component; writes `deployments/esmeralda.json` |
| `../gateway/ootle_pay.py` | the gateway's side |

## Run a paid router

```bash
docker run -d --name ootlerouter -p 127.0.0.1:3000:3000 -v ootlerouter:/data \
  -e OOTLE_PROVIDER_KEY=<your account's public key> \
  -e OOTLE_LANES_COMPONENT=<lanes component, unless deployments/esmeralda.json names one> \
  ootlerouter
```

Optional: `OOTLE_RESERVE` (µT a turn holds, default 10000), `OOTLE_PRICES` (a prices file), and, to claim
automatically, `WALLETD_URL` (and `WALLETD_TOKEN`) plus `OOTLE_ACCOUNT` (a walletd account whose key is `OOTLE_PROVIDER_KEY`;
`OOTLE_CLAIM_MIN` µT, default 100000, `OOTLE_CLAIM_EVERY_S`, default 600). The ledger lives in `/data/ootle-pay.json`.

## Pay for a turn

```bash
cd ootle/pay && npm install
curl -H "Authorization: Bearer $KEY" $BASE/v1/ootle             # component, provider_key, reserve, prices
node cli.mjs keygen --out voucher.key                           # prints the voucher public key
node cli.mjs open --account me <provider_key> 1000000 <voucher public key> --live   # prints the lane number
V=$(node cli.mjs voucher --key-file voucher.key <lane> 50000)   # allow up to 0.05 TARI in all
curl $BASE/v1/responses -H "Authorization: Bearer $KEY" -H "X-Ootle-Voucher: $V" -H 'content-type: application/json' \
  -d '{"input":"Reply with exactly: it works.","metadata":{"harness_id":"codex"},"model":"gpt-5.4-mini"}'
curl -H "Authorization: Bearer $KEY" $BASE/v1/ootle/lanes/<lane>  # charged so far and balance
```

Raise the voucher's total as you go. A refused turn answers `402` with the total a voucher needs
(`voucher_cum_needed`). To stop, run `close`, then `refund` once the close window (6 epochs) has passed.

A voucher authorises at most its total, so that is the most a router can take. The charges themselves are the
router's own count: see them at `/v1/ootle/lanes/<lane>`, and keep your vouchers close to what you have used.

## Status

Built and tested against the Ootle engine (`cargo test`, `npm test` in `pay/`, `gateway/tests/test_ootle_pay.py`).
**Not deployed yet:** Esmeralda was reset on 2026-11-02 and its faucet has been empty since, so `deployments/` is
empty. To deploy: `cargo build --release --target wasm32-unknown-unknown -p ootlerouter_lanes`, then
`node deploy/publish.mjs --account A` (a dry run) and again with `--live`.
