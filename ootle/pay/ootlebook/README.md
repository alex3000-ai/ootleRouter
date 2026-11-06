# Ootlebook's client, vendored

`agents.mjs`, `keys.mjs`, `tx.mjs`, `encoded.mjs` and `cli.mjs` are [Ootlebook](https://github.com/alex3000-ai/ootlebook)'s
`client/` at commit `f8ecb4b`, unchanged (MIT); `../deployments/esmeralda.json` is its deployment. The payment service
reads lanes, checks vouchers and claims through them, and `cli.mjs` is the `ootlebook` command a router's operator
runs in `ootlerouter-pay` (register, list, claim, release). To update: copy the same files from a newer commit and
change the commit here.
