# Ootle payments

ootleRouter charges API callers per use in TARI on [Tari Ootle](https://tari.com), through **OotleRouterLanes**, a
payment-lane contract with no admin and no owner.

A caller escrows TARI in a lane to the router's provider key once, on-chain. Each API request then carries a voucher,
which the caller signs off-chain: a cap on the running total the router may claim. The router checks the voucher,
holds a small reserve while the turn runs, and charges the turn's real cost (tokens and minutes, priced in µT) when
it finishes. From time to time it claims on-chain what it has charged, never more than the cap. The caller can close
a lane and get back whatever wasn't claimed.

The Console's own turns are free; only API-key callers pay.

| Folder | What |
|---|---|
| `template/` | the OotleRouterLanes contract (Rust; `cargo test` runs its engine tests in `tests/`) |
| `pay/server.mjs` | the payment service the gateway asks to admit and charge each turn; also claims vouchers |
| `pay/cli.mjs` | `ootlerouter-lanes`: open, fund, close and refund lanes; sign vouchers; claim |
| `prices.json` | µT per `harness.session_minute` and per 1k tokens (`llm.<model>.<kind>`; `llm.*.<kind>` for any model) |
| `deploy/publish.mjs` | publishes the contract and creates the component; writes `deployments/<network>.json` |
| `public/` | `up.sh` / `down.sh`: a public router as a Tor onion service, on networks with no way out |
| `../gateway/ootle_pay.py` | the gateway's side |

## Run a paid router

```bash
docker run -d --name ootlerouter -p 127.0.0.1:3000:3000 -v ootlerouter:/data \
  -e OOTLE_PROVIDER_KEY=<your account's public key> \
  -e OOTLE_LANES_COMPONENT=<lanes component, unless deployments/esmeralda.json names one> \
  ootlerouter
```

Optional: `OOTLE_RESERVE` (µT a turn holds, default 10000), `OOTLE_PRICES` (a prices file),
`OOTLE_CORS_ORIGINS` (pages that may call the API from a browser, e.g. `https://ootlebook.com`), and, to claim
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

A voucher caps the claim, so its total is the most a router can take. The charges themselves are the router's own
count: see them at `/v1/ootle/lanes/<lane>`, and keep your vouchers close to what you have used (charged plus what
running tasks hold plus one reserve, as [ootlebook.com/router](https://ootlebook.com/router) does).

## Status

**Live on Esmeralda** (Ootle 0.49.2): OotleRouterLanes `component_a524d57c1de85bf39db9dab3501338f8c1928ef141233d1683649659ac725dc2`
(`deployments/esmeralda.json`). On 2026-11-04 a router ran publicly from `public/up.sh` and was paid from
[ootlebook.com/router](https://ootlebook.com/router): a lane opened, two tasks on a local model, the router claimed
exactly the 1,210 µT they cost, the lane closed and refunded. It was then taken offline; no public router runs now.
Also tested on a private one-machine network (`tari_swarm_daemon`).

- Running one publicly: [public/README.md](public/README.md)
- Threat model, findings, checklists for operators and payers, measured costs: [SECURITY.md](SECURITY.md)

To deploy elsewhere: `cargo build --release --target wasm32-unknown-unknown -p ootlerouter_lanes`, then
`node deploy/publish.mjs --account A --network <network>` (a dry run) and again with `--live`. It writes
`deployments/<network>.json`, which the CLI and the payment service read (`OOTLE_LANES_DEPLOYMENT`).
