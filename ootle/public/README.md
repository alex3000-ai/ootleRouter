# A public ootleRouter, hidden and isolated

`up.sh` publishes ootleRouter as a Tor onion service. Payers reach it without learning where it runs, nobody between
them and the router can read the traffic, and the router's container (where payers' agent tasks run) can reach
nothing but its model and its payment service. `down.sh` takes it all down. Why each piece is there:
[../SECURITY.md](../SECURITY.md).

```
payer ── Tor ──► ootlerouter-tor ── API onion ─────► ootlerouter-gate ──► router   (only /api/harness/v1/*)
                                 └─ console onion ─────────────────────► router   (only with your client key)

front (isolated):  tor, gate, router
back (isolated):   router ──► ootlerouter-pay :8090 (token)   router ──► relay :<model port> ──► host 127.0.0.1 model
egress (isolated): pay (its own walletd) ──► relay :443 ──► Tor SOCKS ──► the indexer
```

All three networks are internal and *isolated*: there's no route out, and this machine has no address on them,
so the router can't reach any service here, on your LAN or on the internet. Only Tor (and, with a local model,
the relay) touches the Docker bridge. Measured from inside the router as a task's user: internet, LAN, host
(bridge and network gateways), Tor's SOCKS port and the indexer are all unreachable, and DNS doesn't resolve. Open
are the gate, the payment service (401 without its token) and the model port, and to agent processes not even
those: they may connect on the container's loopback only, where the runner's relays are (`HR_TASK_EGRESS=loopback`;
the runner calls the model for them, and meters it). Tasks can't read the token or the console's password.

## Before

- Docker 28 or later. The router image is built with `docker build -t ootlerouter:local .` at the repo root;
  `up.sh` builds the other image (`Dockerfile` here) itself.
- **gVisor**, strongly recommended: install `runsc` and add a runtime `runsc-netraw` to `/etc/docker/daemon.json`
  (`"runsc-netraw": {"path": "/usr/bin/runsc", "runtimeArgs": ["--net-raw"]}`, then `systemctl reload docker`).
  `up.sh` then uses it for the router, so agent tasks run on gVisor's kernel instead of yours (a kernel bug no
  longer reaches the host, and tasks don't see your kernel version). `--net-raw` is what lets gVisor enforce the
  agent-egress rule below. Without it, `up.sh` warns and uses runc.
- A lanes deployment (`../deployments/<network>.json`) and a `tari_ootle_walletd` binary (0.49 or later). The
  router gets a wallet of its own, inside the payment container: no wallet on this machine is exposed to it.
- Optional: an OpenAI-compatible model server on 127.0.0.1.
- An env file, mode 600, outside git; the variables are listed at the top of `up.sh`.

## Run

```bash
ootle/public/up.sh my.env
# [pay] account router: otl_esm_1…   <- fund this address for claim fees (a claim costs ~5,000 µT)
# [up] API (for payers):  http://<56 chars>.onion/api/harness
# [up] console (you):     http://<56 chars>.onion
```

The first start installs the harnesses (`OR_BACKENDS`) into the data volume, in a throwaway container that does
have the bridge. The router itself never gets a route out. The onion addresses and the wallet live in volumes, so
they stay the same from one `up.sh` to the next.

- **Console:** open its onion in Tor Browser. It asks for a key: paste `~/.config/ootlerouter/console.priv`.
  For a tor client, put `console.auth_private` in its `ClientOnionAuthDir`. Without the key the address can't even
  be found. Sign in (user `harnessrouter`, password in `OR_PASSWORD_FILE`) and make API keys for payers. With
  `OR_MODEL_PORT` and `OR_MODEL`, that model is already offered to every harness (integration `local`, via the relay).
- **Payers** use the API onion from any client through Tor (ootlebook.com/router in Tor Browser should work, since
  Tor Browser treats onions as secure, but it hasn't been tried yet), e.g.
  `curl --socks5-hostname 127.0.0.1:9050 http://<api>.onion/api/harness/v1/ootle -H "Authorization: Bearer $KEY"`.
- **The wallet:** `docker exec ootlerouter-pay sh -c 'WALLETD_TOKEN_FILE=/home/edge/wallet/esmeralda/.cookie
  node /app/ootle/pay/cli.mjs …'` runs the lanes CLI against it. Sweep claims out to a wallet of yours.

## Stop

```bash
ootle/public/down.sh                 # containers, networks, forwarder; volumes stay
ootle/public/down.sh --purge         # also the router's data, payment ledger, onion addresses, the pay token
ootle/public/down.sh --purge-wallet  # and the router's wallet: sweep its funds out first
```

## What stays visible

- To payers: the API's answers, your model's name and behaviour, and on-chain the provider key and claims. Tasks
  can read this machine's CPU model, core count and memory size (`OR_CPUS`/`OR_MEMORY` limit use, not what
  `/proc` shows), and under runc its kernel version. That narrows down hardware, not location.
- To Tari's indexer: claims and reads arrive from Tor exits, not from you.
- To anyone who can run `docker` on this machine: everything (the docker group is root).
