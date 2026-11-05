# A public ootleRouter, isolated

`up.sh` puts ootleRouter on a public HTTPS address without exposing the machine it runs on; `down.sh` removes
everything again. Why each piece is there: [../SECURITY.md](../SECURITY.md).

```
internet ── Cloudflare quick tunnel ── ootlerouter-tunnel ──┐
                                                            │  ootlerouter-public-net (internal: no route out)
                         ootlerouter-public (router) ───────┤
                                                            │
host 127.0.0.1:{model, walletd} ◄── bridge forwarder ◄── ootlerouter-relay ──► indexer :443
```

## Before

- The router image: `docker build -t ootlerouter:local .` at the repo root.
- A lanes deployment (`../deployments/<network>.json`) and a walletd on 127.0.0.1 with
  `--authentication webauthn --cookie-auth true`, holding the provider account.
- An API key for the payment service, scoped to that account and expiring soon, minted from an admin session:

  ```js
  auth.create_api_key { name: "ootlerouter-pay", confirm_admin: false, expires_at: <unix seconds>,
    permissions: ["accounts:read:<account component>", "transactions:read", "transactions:create",
                  "transfer:create:<account component>", "substates:read"] }
  ```
- A model server on 127.0.0.1 (any OpenAI-compatible one).
- An env file, mode 600, outside git; the variables are listed at the top of `up.sh`.

## Run

```bash
ootle/public/up.sh my.env          # prints https://<name>.trycloudflare.com
```

Then, on that address: sign in to the console (user `harnessrouter`, the password in `OR_PASSWORD_FILE`), add the
model under Bring your own key (base URL `http://172.31.250.2:<model port>/v1`, the relay), and make API keys for
payers. Payers use `https://<name>.trycloudflare.com/api/harness`, from the CLI or
[ootlebook.com/router](https://ootlebook.com/router).

## Stop

```bash
ootle/public/down.sh --purge       # containers, network, forwarder and the router's data volume
```

Then revoke the payment service's walletd key (needs an admin session; see SECURITY.md, finding 2) and delete it.
