// OotleRouterLanes from JavaScript: reads from a public Ootle indexer, and the instructions and inputs for every call.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callMethod, callMethodWs, cbor, depositReturned, NETWORKS, withdrawTari } from "./tx.mjs";
import { plainBody } from "./encoded.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The deployment (../deployments/esmeralda.json, or the file OOTLE_LANES_DEPLOYMENT names); OOTLE_LANES_COMPONENT
 *  and OOTLE_INDEXER override its component and indexer. */
export function deployment() {
  const path = process.env.OOTLE_LANES_DEPLOYMENT || join(HERE, "..", "deployments", "esmeralda.json");
  const file = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const hub = process.env.OOTLE_LANES_COMPONENT || file.component;
  if (!hub) throw new Error("no OotleRouterLanes component configured (deployments/esmeralda.json or OOTLE_LANES_COMPONENT)");
  return { ...file, hub, indexer: (process.env.OOTLE_INDEXER || file.indexer || "https://ootle-indexer-a.tari.com").replace(/\/+$/, "") };
}

/** Where transactions go: the deployment's network byte and indexer, for submitInstructions. */
export function txTarget() {
  const { network = "esmeralda", indexer } = deployment();
  if (!(network in NETWORKS)) throw new Error(`unknown network ${network}`);
  return { network: NETWORKS[network], indexer };
}

export async function indexer(path) {
  const res = await fetch(`${deployment().indexer}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`indexer ${res.status} on ${path.slice(0, 80)}`);
  return plainBody(await res.json());
}

const hexOf = (v) => (v?.["@cbor"] === "bytes" ? v.hex : v?.["@cbor"] === "tag" ? hexOf(v.value) : null);
const num = (v) => Number(v?.["@cbor"] === "tag" ? v.value : v);

let checked = null;
/** The component's settings, after checking its lanes resource is the one the deployment names (or a look-alike
 *  could serve made-up lanes). State: [lanes, pages, count, escrow, close_epochs]. */
export async function hubState({ fresh = false } = {}) {
  const { hub, lanes_resource } = deployment();
  if (checked?.hub === hub && !fresh) return checked.state;
  const s = (await indexer(`/substates/${hub}`))?.state?.up?.substate?.Component?.body?.state;
  if (!Array.isArray(s) || s.length !== 5) throw new Error(`${hub} is not an OotleRouterLanes component`);
  const resource = `resource_${hexOf(s[0])}`;
  if (lanes_resource && lanes_resource !== resource) throw new Error(`the lanes resource isn't the one ${hub} created`);
  const state = { lanes_resource: resource, count: num(s[2]), close_epochs: num(s[4]) };
  checked = { hub, state };
  return state;
}

export async function currentEpoch() {
  return Number((await indexer("/epoch-manager/stats")).current_epoch);
}

const substate = (n) => `nft_${(checked?.state.lanes_resource ?? deployment().lanes_resource).replace(/^resource_/, "")}_u64_${n}`;

/** Lane `n`, or null. data [buyer_key, provider_key, voucher_key, opened_epoch]; mutable [deposited, claimed, refunded,
 *  close_requested_epoch, closed]. */
export async function lane(n) {
  if (!/^\d+$/.test(String(n))) throw new Error("a lane is a whole number");
  await hubState();
  const nft = (await indexer(`/substates/${substate(n)}`))?.state?.up?.substate?.NonFungible;
  if (!nft) return null;
  const [buyer, provider, voucherKey, opened] = nft.data;
  const [deposited, claimed, refunded, closeRequested, closed] = nft.mutable_data;
  return {
    id: Number(n), buyer_key: hexOf(buyer), provider_key: hexOf(provider), voucher_key: hexOf(voucherKey), opened_epoch: num(opened),
    deposited: num(deposited), claimed: num(claimed), refunded: num(refunded), remaining: num(deposited) - num(claimed) - num(refunded),
    close_requested_epoch: closeRequested === null ? null : num(closeRequested), closed: closed === true,
  };
}

// ---- writes: the instructions for each call and the substates walletd can't detect ----

const hubCall = (method, args) => callMethod(deployment().hub, method, args);
const paidCall = (account, amount, method, args) => [...withdrawTari(account, amount), callMethodWs(deployment().hub, method, [...args, { ws: 0 }])];
const writes = (n) => ({ id: substate(n), write: true });

export const calls = {
  open: (account, amount, providerKey, voucherKey) => ({
    instructions: paidCall(account, amount, "open_lane", [cbor.key(providerKey, "provider key"), cbor.key(voucherKey, "voucher key")]),
    inputs: [],
  }),
  fund: (account, amount, n) => ({ instructions: paidCall(account, amount, "fund_lane", [cbor.uint(n)]), inputs: [writes(n)] }),
  /** Claims up to `claimCum` µT in all, within `voucher`'s cap. */
  claim: (account, voucher, claimCum = voucher.spent_cum) => ({
    instructions: [hubCall("claim", [cbor.uint(voucher.lane), cbor.uint(claimCum), cbor.uint(voucher.spent_cum), cbor.signature(voucher)]), ...depositReturned(account)],
    inputs: [writes(voucher.lane)],
  }),
  requestClose: (n) => ({ instructions: [hubCall("request_close", [cbor.uint(n)])], inputs: [writes(n)] }),
  release: (n) => ({ instructions: [hubCall("release_lane", [cbor.uint(n)])], inputs: [writes(n)] }),
  refund: (account, n) => ({ instructions: [hubCall("refund", [cbor.uint(n)]), ...depositReturned(account)], inputs: [writes(n)] }),
};
