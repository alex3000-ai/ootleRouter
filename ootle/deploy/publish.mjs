#!/usr/bin/env node
// Publishes the OotleRouterLanes template and creates its component through a local wallet daemon, recording both in
// deployments/<network>.json. Dry-runs by default; --live spends. The close window is fixed forever once created.
//   PATH="$HOME/.cargo/bin:$PATH" cargo build --release --target wasm32-unknown-unknown -p ootlerouter_lanes
//   node deploy/publish.mjs --account A [--network esmeralda|localnet|mainnet] [--indexer URL] [--close-epochs E] [--live]
//   --create-only skips publishing and creates from the template already recorded.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountInfo, callFunction, cbor, NETWORKS, parseArgs, publishTemplate, submitInstructions, TARI, usage, walletd } from "../pay/tx.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = join(ROOT, "target/wasm32-unknown-unknown/release/ootlerouter_lanes.wasm");
const { flags } = parseArgs(process.argv.slice(2));
if (!flags.account) usage(import.meta.url, "missing");
const network = flags.network ?? "esmeralda";
if (!(network in NETWORKS)) usage(import.meta.url, "network");
const indexer = flags.indexer ?? "https://ootle-indexer-a.tari.com";
const PATH = join(ROOT, "deployments", `${network}.json`);
process.env.OOTLE_LANES_DEPLOYMENT = PATH;
const live = flags.live === true;
const closeEpochs = BigInt(flags["close-epochs"] ?? 6);

const dep = existsSync(PATH) ? JSON.parse(readFileSync(PATH, "utf8")) : {};
const save = () => (mkdirSync(dirname(PATH), { recursive: true }), writeFileSync(PATH, JSON.stringify(dep, null, 2) + "\n"));
const rpc = walletd();

if (!flags["create-only"]) {
  const p = await publishTemplate(rpc, { wasm: WASM, account: flags.account, live });
  if (!live) {
    console.log(`publish: dry run fee ${p.dry_run_fee} µT for a ${(readFileSync(WASM).length / 1024).toFixed(0)} KiB template. Add --live to publish and create.`);
    process.exit(0);
  }
  Object.assign(dep, { network, indexer, template: p.template, transactions: { publish: p.transaction_id } });
  save();
  console.log(`published ${p.template} in ${p.transaction_id} (fee ${p.fee} µT)`);
}

const acct = await accountInfo(rpc, flags.account);
const r = await submitInstructions(rpc, {
  feeAccount: acct.component, signerIndex: acct.index, live, ceiling: Number(flags["max-fee"] ?? 30_000), network: NETWORKS[network], indexer,
  instructions: [callFunction(dep.template, "new", [cbor.resource(TARI), cbor.uint(closeEpochs)])],
});
if (!live) {
  console.log(`create: dry run fee ${r.required_fee} µT`);
  process.exit(0);
}
const component = JSON.stringify(r.result).match(/component_[0-9a-f]{64}/g)?.find((c) => c !== acct.component);
Object.assign(dep, { deployed: new Date().toISOString().slice(0, 10), component, payment_resource: TARI, close_epochs: Number(closeEpochs) });
dep.transactions.create = r.transaction_id;
delete dep.lanes_resource;
save();
// Record the lanes resource the component created, read back from the indexer.
const { hubState } = await import("../pay/lanes.mjs");
for (let i = 0; i < 30 && !dep.lanes_resource; i++) {
  dep.lanes_resource = await hubState().then((s) => s.lanes_resource, () => new Promise((ok) => setTimeout(ok, 2000)));
}
save();
console.log(`created ${component} in ${r.transaction_id} (fee ${r.fee} µT); lanes resource ${dep.lanes_resource}`);
