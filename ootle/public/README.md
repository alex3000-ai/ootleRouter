# Hosting an ootleRouter

This folder runs a router that payers reach over Tor without learning where it is, and whose agents can reach
nothing outside it. For the why, in plain words, see the [top-level README](../../README.md#why-its-safe); for the
measurements behind it, [../SECURITY.md](../SECURITY.md).

| Script | What it does |
|---|---|
| `setup-host.sh [env]` | checks this machine (Docker, gVisor, firewall, your model) and prints any sudo commands you need |
| `up.sh <env>` | starts everything and prints your two `.onion` addresses |
| `check.sh [--tor]` | attacks the running router from inside, the way a hostile task would, and prints PASS/FAIL |
| `down.sh [--purge \| --purge-wallet]` | stops everything; `--purge` also deletes its data, `--purge-wallet` its wallet too |

## You need

- Linux with **Docker 28 or later** (only the `docker` command; nothing else is installed on your machine).
- **gVisor**, registered with Docker as `runsc-netraw`. `setup-host.sh` prints the commands. Without it the router
  still runs and is still cut off, but agents share your kernel.
- **An AI model** with an OpenAI-compatible API on `127.0.0.1` (llama.cpp, vLLM, Ollama, ...). It stays on your
  loopback; the router reaches it through one relay.
- **A firewall** that drops incoming connections (`setup-host.sh` checks ufw).

## Run

```bash
ootle/public/setup-host.sh ~/ootlerouter.env      # until it says Ready
cp ootle/public/example.env ~/ootlerouter.env && chmod 600 ~/ootlerouter.env   # set OR_MODEL_PORT and OR_MODEL
ootle/public/up.sh ~/ootlerouter.env
```

```
[pay] account router: otl_esm_1…        <- your router's wallet: send it a little TARI for claim fees
[up] router (runsc-netraw): on front and back only
[harnessrouter] agent egress: only root and agent connect beyond loopback
[up] API (for payers):  http://<56 characters>.onion/api/harness
[up] console (you):     http://<56 characters>.onion
```

The first start takes a few minutes: it downloads the images
(`ghcr.io/alex3000-ai/ootlerouter`, `…/ootlerouter-edge`) and installs the agent harnesses into the router's data
volume, in a throwaway container. Later starts take seconds. The onion addresses, the console key and the wallet
are kept, so they stay the same from one `up.sh` to the next. `OR_BUILD=1` builds both images from your checkout
instead of downloading them.

Then:

1. **Check it:** `ootle/public/check.sh --tor`. Every line should say PASS.
2. **Fund the wallet** printed as `[pay] account router`: each claim costs about 5,000 µT (0.005 TARI). Don't fund it
   from an account that carries your name.
3. **Open the console:** in Tor Browser go to the console address. It asks for a key: paste the contents of
   `~/.config/ootlerouter/console.priv`. Sign in as `harnessrouter` with the password in
   `~/.config/ootlerouter/console-password`. Your model is already set up for every harness.
4. **Make API keys** for payers (Keys in the console), and give them the API address.

Payers use the API address from any Tor client: Tor Browser (where ootlebook.com/router should work, though that
hasn't been tried yet), or for example
`curl --socks5-hostname 127.0.0.1:9050 http://<api>.onion/api/harness/v1/ootle -H "Authorization: Bearer $KEY"`.

## Your wallet

The router's wallet lives in its own container, `ootlerouter-pay`; its keys never enter the router's. To use the lanes
CLI against it:

```bash
docker exec ootlerouter-pay sh -c 'WALLETD_URL=http://127.0.0.1:5100/json_rpc \
  WALLETD_TOKEN_FILE=/home/edge/wallet/esmeralda/.cookie node /app/ootle/pay/cli.mjs <command>'
```

Move what claims bring in to a wallet of your own from time to time; keep only claim fees here.

## How the pieces connect

```
payer ── Tor ──► ootlerouter-tor ── API onion ─────► ootlerouter-gate ──► router   (only /api/harness/v1/*)
                                 └─ console onion ─────────────────────► router   (only with your client key)

front  (isolated):  tor, gate, router
back   (isolated):  router ──► ootlerouter-pay :8090 (token)   router ──► relay :<model port> ──► forwarder ──► your model
egress (isolated):  pay (its own walletd) ──► relay :443 ──► Tor SOCKS ──► the Ootle indexer
```

- All three networks are internal and *isolated*: they have no route out, and this machine has no address on them.
- Inside the router, only its own code (root and the gateway's user) may connect beyond the container's loopback,
  and only to what these networks hold. Agent processes reach the router's relays on loopback and nothing else.
- Only Tor and the relay touch Docker's bridge. The forwarder is the one container on your host's network, and it
  passes one port from the bridge address to your model.

## Stop

```bash
ootle/public/down.sh                 # containers and networks; data, onion addresses and wallet stay
ootle/public/down.sh --purge         # also the router's data, payment ledger, onion addresses, pay token
ootle/public/down.sh --purge-wallet  # and the router's wallet: sweep its funds out first, its keys go with it
```

## What stays visible

- **To payers:** your model's answers and name, what the API returns, and on-chain your router's provider key
  and claims.
- **To an agent, under gVisor:** gVisor's kernel, a CPU model of "unknown", and the container's own core and
  memory limits (`OR_CPUS`, `OR_MEMORY`). Under plain runc: your real kernel version, CPU model, core count and
  memory size.
- **To Tari's indexer:** reads and claims arrive from Tor exits, not from you.
- **To anyone who can run `docker` on this machine:** everything. The docker group is root.
