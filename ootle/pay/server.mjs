#!/usr/bin/env node
// ootleRouter's payment service: the gateway asks it to admit a paid turn and then charges what the turn cost.
// Listens on loopback (or OOTLE_PAY_HOST, when it runs in a container of its own); every request carries
// OOTLE_PAY_TOKEN in x-ootle-pay-token.
//
// Payment runs on Ootlebook's lanes (ootlebook/, vendored): a hiring agent with an Ootlebook card opens a lane to this
// router's card (OOTLE_PROVIDER_AGENT) and sends a voucher with each request. A lane's balance is its best voucher less
// what finished turns cost and what running turns hold. A turn starts only while the balance covers OOTLE_RESERVE; it
// then holds that reserve until it is charged its real cost. A hold whose turn the gateway never starts lapses in two
// minutes.
//
// An Ootlebook claim takes a voucher's whole total, so the service keeps every voucher a lane sends and claims the
// highest one at or below what it has charged: a payer who signs a voucher for exactly the charges (a settlement
// voucher, POST /offer) pays exactly them. Only from a lane that is closing, or idle for a day, with charges no such
// voucher covers, does it claim the smallest voucher above them: at most a reserve more than the charges.
// With WALLETD_URL and OOTLE_ACCOUNT (the card's agent key's account) set, it claims on-chain from time to time.
//
//   POST /admit  {voucher}          -> {hold, lane, balance} | 402 {code, message, ...lane status}
//   POST /offer  {voucher}          -> lane status | 402: the voucher is kept, no turn starts (a key, or a settlement)
//   POST /start  {hold}             -> {} (the turn is running: keep the hold for up to three hours)
//   POST /charge {hold, amount}     -> lane status (amount in µT)
//   GET  /lanes/<agent>.<n>         -> lane status
//   GET  /info                      -> what a hiring agent needs to open a lane here
//
// Env: OOTLE_PAY_TOKEN, OOTLE_PROVIDER_AGENT (this router's Ootlebook card), OOTLE_PAY_HOST (127.0.0.1),
//      OOTLE_PAY_PORT (8090), OOTLE_PAY_LEDGER (./ootle-pay.json), OOTLE_RESERVE (10000 µT), OOTLE_CLAIM_MIN
//      (100000 µT), OOTLE_CLAIM_FEE (5000 µT, about a claim's fee), OOTLE_CLAIM_EVERY_S (600), WALLETD_URL, OOTLE_ACCOUNT.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyVoucher } from "./ootlebook/keys.mjs";

/** A running turn's hold lapses after this; turns are capped well below it (HARNESS_DEFAULT_TIMEOUT_S, 2 h). */
export const HOLD_TTL_MS = 3 * 3600_000;
/** An admitted turn the gateway refused after all, or that failed to start, holds nothing after this. */
export const START_TTL_MS = 120_000;
/** Holds are kept this long, lapsed or not, so a turn that ran without being started can still be charged. */
const KEEP_MS = 24 * 3600_000;
/** A lane with no charge for this long may be claimed above its charges, like a closing one. */
export const IDLE_MS = 24 * 3600_000;
const live = (h, now) => now - h.at < (h.started ? HOLD_TTL_MS : START_TTL_MS);

export const emptyLedger = () => ({ lanes: {}, holds: {} });
const cums = (l) => Object.keys(l?.vouchers ?? {}).map(Number).sort((a, b) => a - b);

/** Whether `id` is a lane of `provider`'s (`<provider>.<n>`): checked before anything is read from the chain. */
export const ours = (id, provider) => typeof id === "string" && id.startsWith(`${provider}.`) && /^\d+$/.test(id.slice(provider.length + 1));

export function status(ledger, id, now = Date.now()) {
  const l = ledger.lanes[id] ?? { vouchers: {}, charged: 0 };
  const held = Object.values(ledger.holds).filter((h) => h.lane === id && live(h, now)).reduce((s, h) => s + h.amount, 0);
  const voucherCum = cums(l).at(-1) ?? 0;
  return { lane: id, voucher_cum: voucherCum, charged: l.charged, held, balance: voucherCum - l.charged - held };
}

const refuse = (code, message, extra = {}) => ({ refused: { code, message, ...extra } });

/** Why `voucher` can't pay here for its lane as read from the chain (`chain`, or null), or null when it can. */
export function check(voucher, chain, { hub, network, provider }) {
  if (!voucher || typeof voucher !== "object") return refuse("voucher_required", "Send a voucher for your lane in the X-Ootle-Voucher header.");
  if (voucher.hub !== hub || voucher.network !== network) return refuse("voucher_invalid", `Vouchers here are for Ootlebook (${hub}) on ${network}.`);
  if (!ours(voucher.lane, provider)) return refuse("voucher_invalid", `This router is the Ootlebook agent ${provider}: open a lane to it (${provider}.<n>).`);
  if (!verifyVoucher(voucher)) return refuse("voucher_invalid", "The voucher's signature doesn't check out.");
  if (!chain) return refuse("lane_not_found", `There is no lane ${voucher.lane}.`);
  if (chain.voucher_key !== voucher.public_key) return refuse("voucher_invalid", `That key isn't lane ${voucher.lane}'s voucher key.`);
  if (chain.closed || chain.close_requested_epoch !== null) return refuse("lane_closed", `Lane ${voucher.lane} is closing or closed; open a new one.`);
  if (!(Number(voucher.spent_cum) <= chain.deposited)) return refuse("voucher_invalid", `The voucher is above lane ${voucher.lane}'s ${chain.deposited} µT escrow; fund the lane first.`);
  return null;
}

/** Keeps a voucher that `check` passed. Vouchers below the best one a claim could take are of no further use. */
function keep(ledger, voucher, now) {
  const l = (ledger.lanes[voucher.lane] ??= { vouchers: {}, charged: 0, at: now });
  l.vouchers[Number(voucher.spent_cum)] = voucher;
  const floor = cums(l).filter((c) => c <= l.charged).at(-1);
  for (const c of cums(l)) if (c < floor) delete l.vouchers[c];
}

/** Checks `voucher`, keeps it, and holds `reserve` for a new turn. Returns {hold, ...status} or {refused}. */
export function admit(ledger, voucher, chain, { reserve, now = Date.now(), ...settings }) {
  for (const [id, h] of Object.entries(ledger.holds)) if (now - h.at >= KEEP_MS) delete ledger.holds[id];
  const bad = check(voucher, chain, settings);
  if (bad) return bad;
  keep(ledger, voucher, now);
  const s = status(ledger, voucher.lane, now);
  if (s.balance < reserve) {
    const need = s.charged + s.held + reserve;
    return refuse("payment_required", `Lane ${voucher.lane} needs a voucher for at least ${need} µT in all to start a turn.`, { ...s, reserve, voucher_cum_needed: need });
  }
  const hold = randomUUID();
  ledger.holds[hold] = { lane: voucher.lane, amount: reserve, at: now, started: false };
  return { hold, ...status(ledger, voucher.lane, now) };
}

/** Checks and keeps `voucher` without starting a turn: to get a key for its lane, or to settle what was charged. */
export function offer(ledger, voucher, chain, { now = Date.now(), ...settings }) {
  const bad = check(voucher, chain, settings);
  if (bad) return bad;
  keep(ledger, voucher, now);
  return status(ledger, voucher.lane, now);
}

export function start(ledger, hold, now = Date.now()) {
  const h = ledger.holds[hold];
  if (h) Object.assign(h, { started: true, at: now });
  return Boolean(h);
}

/** Charges a turn's cost and lets go of its hold. Charging the same hold twice does nothing the second time. */
export function charge(ledger, hold, amount, now = Date.now()) {
  const h = ledger.holds[hold];
  if (!h) return null;
  delete ledger.holds[hold];
  const l = ledger.lanes[h.lane];
  l.charged += Math.max(0, Math.ceil(Number(amount) || 0));
  l.at = now;
  return status(ledger, h.lane, now);
}

/** Claims worth making now, as [{voucher, lane}] (a claim takes the voucher's whole total). The highest voucher at or
 *  below the charges, if it adds at least `min`, or on a closing lane more than a claim's `fee`. On a closing or idle
 *  lane whose charges no such voucher covers, the smallest voucher above them instead. */
export function claimable(ledger, chainOf, min, fee = 0, now = Date.now()) {
  return Object.entries(ledger.lanes).flatMap(([id, l]) => {
    const c = chainOf(id);
    if (!c || c.closed) return [];
    const ending = c.close_requested_epoch !== null || now - (l.at ?? now) >= IDLE_MS;
    const enough = (cum) => cum - c.claimed >= (c.close_requested_epoch !== null ? Math.max(fee, 1) : min);
    const under = cums(l).filter((cum) => cum <= l.charged).at(-1);
    if (under !== undefined && enough(under)) return [{ voucher: l.vouchers[under], lane: c }];
    const over = cums(l).find((cum) => cum > l.charged);
    if (ending && over !== undefined && l.charged > Math.max(under ?? 0, c.claimed) && enough(over)) return [{ voucher: l.vouchers[over], lane: c }];
    return [];
  });
}

// ---- the service ----

async function main() {
  const A = await import("./ootlebook/agents.mjs");
  const env = process.env;
  const token = env.OOTLE_PAY_TOKEN ?? "";
  const provider = env.OOTLE_PROVIDER_AGENT ?? "";
  if (token.length < 16 || !A.validName(provider)) throw new Error("set OOTLE_PAY_TOKEN (16+ characters) and OOTLE_PROVIDER_AGENT (this router's Ootlebook card)");
  const { hub, network = "esmeralda" } = A.deployment();
  const settings = { hub, network, provider, reserve: Number(env.OOTLE_RESERVE ?? 10_000) };
  const card = await A.card(provider);
  if (!card || card.retired) throw new Error(`${provider} isn't an active Ootlebook card: register it first (ootle/public/ootlebook.sh)`);
  const claimMin = Number(env.OOTLE_CLAIM_MIN ?? 100_000), claimFee = Number(env.OOTLE_CLAIM_FEE ?? 5_000);
  const path = env.OOTLE_PAY_LEDGER ?? "ootle-pay.json";
  let ledger = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : emptyLedger();
  // Lane ids belong to one Ootlebook component: a new one starts a new ledger, and the old one is kept beside it.
  if (ledger.hub && ledger.hub !== hub) {
    renameSync(path, `${path}.${ledger.hub}`);
    ledger = emptyLedger();
  }
  ledger.hub = hub;
  const save = () => (writeFileSync(`${path}.tmp`, JSON.stringify(ledger)), renameSync(`${path}.tmp`, path));

  // A lane read from the chain lasts a minute, or until a voucher asks for more than it was seen to hold.
  const seen = new Map();
  const chainLane = async (id, cum = 0) => {
    const c = seen.get(id);
    if (c && Date.now() - c.at < 60_000 && (!c.lane || cum <= c.lane.deposited)) return c.lane;
    const fresh = await A.lane(id);
    seen.set(id, { lane: fresh?.provider === provider ? fresh : null, at: Date.now() });
    return seen.get(id).lane;
  };
  const read = async (voucher) => (ours(voucher?.lane, provider) ? chainLane(voucher.lane, Number(voucher.spent_cum) || 0) : null);

  // Constant time: in ootle/public the router's agent tasks can reach this port, so they may time their guesses.
  const digest = (s) => createHash("sha256").update(String(s ?? "")).digest();
  const sameToken = (t) => timingSafeEqual(digest(t), digest(token));

  const routes = {
    "POST /admit": async ({ voucher }) => {
      const r = admit(ledger, voucher, await read(voucher), settings);
      if (r.hold) save();
      return r.refused ? [402, r.refused] : [200, r];
    },
    "POST /offer": async ({ voucher }) => {
      const r = offer(ledger, voucher, await read(voucher), settings);
      if (r.refused) return [402, r.refused];
      save();
      return [200, r];
    },
    "POST /start": async ({ hold }) => (start(ledger, String(hold)) ? (save(), [200, {}]) : [404, { code: "hold_not_found", message: "No such hold." }]),
    "POST /charge": async ({ hold, amount }) => {
      const s = charge(ledger, String(hold), amount);
      if (!s) return [404, { code: "hold_not_found", message: "No such hold." }];
      save();
      return [200, s];
    },
    "GET /info": async () => [200, { network, ootlebook: hub, agent: provider, reserve_microtari: settings.reserve,
      lanes: `Open an Ootlebook lane to ${provider}; send its vouchers in X-Ootle-Voucher. POST /v1/ootle/keys with one gets you a key.` }],
  };

  createServer(async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      if (!sameToken(req.headers["x-ootle-pay-token"])) return reply(401, { code: "unauthorized" });
      const m = /^\/lanes\/([a-z0-9_.-]{3,48})$/.exec(req.url);
      if (req.method === "GET" && m) return ours(m[1], provider) ? reply(200, status(ledger, m[1])) : reply(404, { code: "not_found" });
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return reply(404, { code: "not_found" });
      let raw = "";
      for await (const chunk of req) if ((raw += chunk).length > 16_384) return reply(413, { code: "too_large" });
      reply(...(await route(raw ? JSON.parse(raw) : {})));
    } catch (e) {
      reply(500, { code: "internal_error", message: String(e.message).slice(0, 200) });
    }
  }).listen(Number(env.OOTLE_PAY_PORT ?? 8090), env.OOTLE_PAY_HOST ?? "127.0.0.1", () => console.log(`[ootle-pay] ready; Ootlebook ${hub}, agent ${provider}`));

  if (env.WALLETD_URL && env.OOTLE_ACCOUNT) {
    const { accountInfo, submitInstructions, walletd } = await import("./ootlebook/tx.mjs");
    const rpc = walletd();
    const acct = await accountInfo(rpc, env.OOTLE_ACCOUNT);
    if (acct.key !== card.agent_key) throw new Error(`walletd account ${env.OOTLE_ACCOUNT} doesn't hold ${provider}'s agent key, so it can't claim`);
    const claimRound = async () => {
      const chain = new Map();
      for (const id of Object.keys(ledger.lanes)) chain.set(id, await A.lane(id).catch(() => null));
      for (const { voucher: v, lane } of claimable(ledger, (id) => chain.get(id), claimMin, claimFee)) {
        try {
          const { instructions, inputs } = A.calls.claim(acct.component, lane, v);
          const r = await submitInstructions(rpc, { feeAccount: acct.component, signerIndex: acct.index, instructions, inputs, live: true, indexer: A.deployment().indexer });
          console.log(`[ootle-pay] claimed lane ${v.lane} up to ${v.spent_cum} µT (charged ${ledger.lanes[v.lane].charged}): ${r.transaction_id} (fee ${r.fee} µT)`);
        } catch (e) {
          console.log(`[ootle-pay] claim on lane ${v.lane} failed: ${String(e.message).slice(0, 300)}`);
        }
      }
    };
    setInterval(() => claimRound().catch((e) => console.log(`[ootle-pay] claim round: ${e.message}`)), Number(env.OOTLE_CLAIM_EVERY_S ?? 600) * 1000);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`[ootle-pay] ${e.message}`); process.exit(1); });
