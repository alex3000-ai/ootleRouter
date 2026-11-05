# Security: running or paying an ootleRouter

What we measured on 2026-11-04 running ootleRouter on a public address against Esmeralda (Ootle 0.49.2), and what
each side should do about it. Run a public router with [`public/`](public/README.md); pay one with
[ootlebook.com/router](https://ootlebook.com/router) or the [CLI](README.md#pay-for-a-turn).

## Who trusts whom

| | Can lose | Bounded by |
|---|---|---|
| **Payer** (opens a lane, signs vouchers) | at most its latest voucher's total | the voucher it signs; the contract pays out no more than that cap, and the rest comes back on close |
| **Router operator** (provider) | the cost of a turn past what the payer's voucher covers; its machine, if a task escapes | the reserve each turn holds; the isolation below |
| **Ootlebook.com** | nothing: it never sees keys, vouchers or tasks | the page talks only to the router the visitor names |

- A voucher is a cap, not a payment: the router claims only what it charged (`claim_cum ≤ voucher_cum`). What it
  charged is the router's own count, shown at `/v1/ootle/lanes/<n>`. Keep vouchers close to use: the
  ootlebook.com page signs charged + held + one reserve, never more than you enter as your escrow.
- Vouchers are bound to the network and the lanes component (Ootle 0.49 template signatures): one can't be replayed
  on another network, another component, or another lane.
- After a payer asks to close, the router can still claim for the close window (6 epochs). The payment service
  claims closing lanes at its next round (10 minutes by default), so run it until your lanes settle.

## Findings

1. **A container reaches every service on its host that listens beyond loopback.** From a plain container we
   reached the host's other agent service (`hermes`, 0.0.0.0:8644), an Ootle base node and validator, and every
   port forwarded onto the Docker bridge, including a wallet daemon with no authentication. Agent tasks run inside
   the router's container, so a paying user's task could probe or use all of that.
   **Fix (used):** [`public/up.sh`](public/up.sh) puts the router on a Docker network with no route out; a relay is
   its only door, passing the model, walletd and the indexer, nothing else. Measured from inside the router: host
   services, the home network and the internet blocked; relay ports open, any other relay port closed.
2. **`walletd --authentication none` gives anyone who reaches it admin** (`auth.request` hands out an admin session).
   **Fix (used):** run walletd with `--authentication webauthn --cookie-auth true`: anonymous calls are refused,
   host tools use `<base>/esmeralda/.cookie`, and the payment service gets an API key scoped to the provider account
   (`accounts:read:<acct>`, `transactions:read|create`, `transfer:create:<acct>`, `substates:read`), expiring in
   days. Measured: that key reads its account and is refused every other. The cookie can't mint keys either.
   **Gotcha:** creating, listing and revoking keys needs an interactive (WebAuthn) session; headless, switch to
   `none` briefly with nothing else able to reach the port, revoke, switch back (that is how we revoked ours).
3. **Secrets in the container's environment.** The entrypoint strips `WALLETD_TOKEN`, `OOTLE_PAY_TOKEN` and the
   console credentials from the runner (verified in its `/proc/<pid>/environ`), and agent tasks run as their own
   users, so tasks don't see them. Anyone in the host's `docker` group does (`docker inspect`, `docker exec`).
4. **Agent tasks can call the model directly** through the relay, without metering. With a local model that costs
   only GPU time. With a cloud provider key, set a spending limit at the provider.
5. **The console login isn't rate-limited:** 12 wrong passwords in a row, 12 × 401. The instance makes a long random
   password at first start. For more than a short test, publish only `/api/harness/v1/*` (a named Cloudflare
   tunnel's ingress rules can), or put Cloudflare Access or a rate limit in front of `/login`.
6. **Quick tunnels are temporary.** Ours dropped after about an hour on QUIC ("no recent network activity") and the
   name stopped resolving; `--protocol http2` (now in `up.sh`) was stable. Their names take a minute to reach every
   resolver. For a lasting router use a named tunnel on a domain you own.
7. **ootlebook.com loads Cloudflare Web Analytics** (`static.cloudflareinsights.com/beacon.min.js`), injected at
   Cloudflare's edge, not in the site's code, contrary to its privacy page. Turn off the zone's Web Analytics
   automatic setup in the Cloudflare dashboard.

## Operator checklist

- Isolate: [`public/up.sh`](public/up.sh), never a plain `docker run -p` on a machine with anything else on it.
- walletd: WebAuthn + cookie auth; a scoped, expiring API key for the payment service; revoke it when done.
- A provider account holding little more than claim fees; sweep claims elsewhere.
- Prices in `prices.json`; `OOTLE_CLAIM_MIN` well above a claim's fee (about 5,000 µT).
- `OOTLE_CORS_ORIGINS` only for pages you trust to call your API from browsers.
- Take it down with [`public/down.sh --purge`](public/down.sh); check nothing is left (it lists what remains).

## Payer checklist

- Escrow only what you mean to spend; vouchers cap the router, and the page never signs above your escrow figure.
- Keep your voucher key in your browser or a file; it signs spending, nothing else. Your account key opens,
  closes and refunds the lane.
- Watch `/v1/ootle/lanes/<n>`; stop by closing the lane and refunding after the window (or at once if the router
  releases it).
- Your tasks run on the operator's machine with the operator's model: don't send what you wouldn't send them.

## Measured costs on Esmeralda (µT; 1 TARI = 1,000,000 µT)

| Step | Fee |
|---|---|
| Publish OotleRouterLanes (418 KiB) / create the component | 2,333,826 / 4,425 |
| Open a lane / close / release / refund | 4,550 / 2,889 / 2,861 / ~3,745 |
| Claim | ~4,950 |
| Move stealth funds to a revealed balance | 14,284 |
| A short task on a 27B local model (prices.json defaults) | ~600 |

Esmeralda advanced about an epoch an hour on 2026-11-04, so the 6-epoch close window was several hours.

## Ootle 0.49 changes builders will meet

- Transactions: `main_signer: "SealSigner"` and `blobs: []` replace `is_seal_signer_authorized`, `blob_hashes`,
  `blob_sizes`.
- Templates must build with `tari_template_lib` 0.37: 0.49 refuses components built with 0.35
  (`CreateComponentArg::upgrade_rule` missing).
- Template signatures commit to the network and a scope (shared, template or component); signers outside Rust must
  reproduce `engine_signature.rs`'s framed Blake2b. [`pay/keys.mjs`](pay/keys.mjs) does, checked by an engine test.
- walletd 0.49: `stealth_transfer`'s `pay_ref` is now `destination_tag`; a dry run returns its result and
  `required_fees` directly; `accounts.list` needs an unscoped read (use `accounts.get` with a scoped key).
