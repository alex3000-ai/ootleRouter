#!/usr/bin/env node
// ootleRouter's payment service: the gateway asks it to admit a paid turn and then charges what the turn cost.
// Listens on loopback; every request carries OOTLE_PAY_TOKEN in x-ootle-pay-token.
//
// A caller pays through an OotleRouterLanes lane to this router's provider key, sending its latest voucher with each
// request. A lane's balance is its best voucher less what finished turns cost and what running turns hold. A turn
// starts only while the balance covers OOTLE_RESERVE; it then holds that reserve until it is charged its real cost.
// A hold whose turn the gateway never starts lapses in two minutes.
// With WALLETD_URL and OOTLE_ACCOUNT set, the service claims on-chain from time to time what turns have been charged,
// never more: a voucher only caps the claim.
//
//   POST /admit  {voucher}          -> {hold, lane, balance} | 402 {code, message, ...lane status}
//   POST /start  {hold}             -> {} (the turn is running: keep the hold for up to three hours)
//   POST /charge {hold, amount}     -> lane status (amount in µT)
//   GET  /lanes/<n>                 -> lane status
//   GET  /info                      -> what a caller needs to open a lane here
//
// Env: OOTLE_PAY_TOKEN, OOTLE_PROVIDER_KEY (hex), OOTLE_PAY_PORT (8090), OOTLE_PAY_LEDGER (./ootle-pay.json),
//      OOTLE_RESERVE (10000 µT), OOTLE_CLAIM_MIN (100000 µT), OOTLE_CLAIM_EVERY_S (600), WALLETD_URL, OOTLE_ACCOUNT.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyVoucher } from "./keys.mjs";

/** A running turn's hold lapses after this; turns are capped well below it (HARNESS_DEFAULT_TIMEOUT_S, 2 h). */
export const HOLD_TTL_MS = 3 * 3600_000;
/** An admitted turn the gateway refused after all, or that failed to start, holds nothing after this. */
export const START_TTL_MS = 120_000;
/** Holds are kept this long, lapsed or not, so a turn that ran without being started can still be charged. */
const KEEP_MS = 24 * 3600_000;
const live = (h, now) => now - h.at < (h.started ? HOLD_TTL_MS : START_TTL_MS);

export const emptyLedger = () => ({ lanes: {}, holds: {} });

export function status(ledger, n, now = Date.now()) {
  const l = ledger.lanes[n] ?? { voucher: null, charged: 0 };
  const held = Object.values(ledger.holds).filter((h) => h.lane === n && live(h, now)).reduce((s, h) => s + h.amount, 0);
  const voucherCum = Number(l.voucher?.spent_cum ?? 0);
  return { lane: n, voucher_cum: voucherCum, charged: l.charged, held, balance: voucherCum - l.charged - held };
}

const refuse = (code, message, extra = {}) => ({ refused: { code, message, ...extra } });

/**
 * Checks `voucher` against its lane as read from the chain (`chain`, or null) and this router's settings, keeps it
 * if it is the best so far, and holds `reserve` for a new turn. Returns {hold, ...status} or {refused}.
 */
export function admit(ledger, voucher, chain, { hub, providerKey, reserve, now = Date.now() }) {
  for (const [id, h] of Object.entries(ledger.holds)) if (now - h.at >= KEEP_MS) delete ledger.holds[id];
  if (!voucher || typeof voucher !== "object") return refuse("voucher_required", "Send a voucher for your lane in the X-Ootle-Voucher header.");
  if (voucher.hub !== hub) return refuse("voucher_invalid", `Vouchers here are for the lanes component ${hub}.`);
  if (!verifyVoucher(voucher)) return refuse("voucher_invalid", "The voucher's signature doesn't check out.");
  const n = Number(voucher.lane);
  if (!chain) return refuse("lane_not_found", `There is no lane ${n}.`);
  if (chain.provider_key !== providerKey) return refuse("voucher_invalid", `Lane ${n} doesn't pay this router (provider key ${providerKey}).`);
  if (chain.voucher_key !== voucher.public_key) return refuse("voucher_invalid", `That key isn't lane ${n}'s voucher key.`);
  if (chain.closed || chain.close_requested_epoch !== null) return refuse("lane_closed", `Lane ${n} is closing or closed; open a new one.`);
  const cum = Number(voucher.spent_cum);
  if (!(cum <= chain.deposited)) return refuse("voucher_invalid", `The voucher is above lane ${n}'s ${chain.deposited} µT escrow; fund the lane first.`);
  const l = (ledger.lanes[n] ??= { voucher: null, charged: 0 });
  if (cum > Number(l.voucher?.spent_cum ?? -1)) l.voucher = voucher;
  const s = status(ledger, n, now);
  if (s.balance < reserve) {
    const need = s.charged + s.held + reserve;
    return refuse("payment_required", `Lane ${n} needs a voucher for at least ${need} µT in all to start a turn.`, { ...s, reserve, voucher_cum_needed: need });
  }
  const hold = randomUUID();
  ledger.holds[hold] = { lane: n, amount: reserve, at: now, started: false };
  return { hold, ...status(ledger, n, now) };
}

export function start(ledger, hold, now = Date.now()) {
  const h = ledger.holds[hold];
  if (h) Object.assign(h, { started: true, at: now });
  return Boolean(h);
}

/** Charges a turn's cost and lets go of its hold. Charging the same hold twice does nothing the second time. */
export function charge(ledger, hold, amount) {
  const h = ledger.holds[hold];
  if (!h) return null;
  delete ledger.holds[hold];
  ledger.lanes[h.lane].charged += Math.max(0, Math.ceil(Number(amount) || 0));
  return status(ledger, h.lane);
}

/** Claims worth making now: what's charged (within the best voucher) and not yet claimed, if at least `min`, or any
 *  such amount on a closing lane. Returns [{voucher, amount}], amount being the new claimed total. */
export function claimable(ledger, chainOf, min) {
  return Object.entries(ledger.lanes).flatMap(([n, l]) => {
    const c = chainOf(Number(n));
    if (!c || !l.voucher || c.closed) return [];
    const amount = Math.min(l.charged, Number(l.voucher.spent_cum));
    const unclaimed = amount - c.claimed;
    return unclaimed > 0 && (unclaimed >= min || c.close_requested_epoch !== null) ? [{ voucher: l.voucher, amount }] : [];
  });
}

// ---- the service ----

async function main() {
  const { deployment, hubState, lane } = await import("./lanes.mjs");
  const env = process.env;
  const token = env.OOTLE_PAY_TOKEN ?? "";
  const providerKey = (env.OOTLE_PROVIDER_KEY ?? "").toLowerCase();
  if (token.length < 16 || !/^[0-9a-f]{64}$/.test(providerKey)) throw new Error("set OOTLE_PAY_TOKEN (16+ characters) and OOTLE_PROVIDER_KEY (64 hex)");
  const settings = { hub: deployment().hub, providerKey, reserve: Number(env.OOTLE_RESERVE ?? 10_000) };
  const claimMin = Number(env.OOTLE_CLAIM_MIN ?? 100_000);
  const path = env.OOTLE_PAY_LEDGER ?? "ootle-pay.json";
  let ledger = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : emptyLedger();
  // Lane numbers belong to one lanes component: a new one starts a new ledger, and the old one is kept beside it.
  if (ledger.hub && ledger.hub !== settings.hub) {
    renameSync(path, `${path}.${ledger.hub}`);
    ledger = emptyLedger();
  }
  ledger.hub = settings.hub;
  const save = () => (writeFileSync(`${path}.tmp`, JSON.stringify(ledger)), renameSync(`${path}.tmp`, path));
  await hubState();

  // A lane read from the chain lasts a minute, or until a voucher asks for more than it was seen to hold.
  const seen = new Map();
  const chainLane = async (n, cum = 0) => {
    const c = seen.get(n);
    if (c && Date.now() - c.at < 60_000 && (!c.lane || cum <= c.lane.deposited)) return c.lane;
    const fresh = await lane(n);
    seen.set(n, { lane: fresh, at: Date.now() });
    return fresh;
  };

  const routes = {
    "POST /admit": async ({ voucher }) => {
      const n = Number(voucher?.lane);
      const chain = Number.isSafeInteger(n) && n >= 0 ? await chainLane(n, Number(voucher.spent_cum) || 0) : null;
      const r = admit(ledger, voucher, chain, settings);
      if (r.hold) save();
      return r.refused ? [402, r.refused] : [200, r];
    },
    "POST /start": async ({ hold }) => (start(ledger, String(hold)) ? (save(), [200, {}]) : [404, { code: "hold_not_found", message: "No such hold." }]),
    "POST /charge": async ({ hold, amount }) => {
      const s = charge(ledger, String(hold), amount);
      if (!s) return [404, { code: "hold_not_found", message: "No such hold." }];
      save();
      return [200, s];
    },
    "GET /info": async () => [200, { network: deployment().network, component: settings.hub, provider_key: providerKey, reserve_microtari: settings.reserve }],
  };

  createServer(async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      if (req.headers["x-ootle-pay-token"] !== token) return reply(401, { code: "unauthorized" });
      const m = /^\/lanes\/(\d+)$/.exec(req.url);
      if (req.method === "GET" && m) return reply(200, status(ledger, Number(m[1])));
      const route = routes[`${req.method} ${req.url}`];
      if (!route) return reply(404, { code: "not_found" });
      let raw = "";
      for await (const chunk of req) if ((raw += chunk).length > 16_384) return reply(413, { code: "too_large" });
      reply(...(await route(raw ? JSON.parse(raw) : {})));
    } catch (e) {
      reply(500, { code: "internal_error", message: String(e.message).slice(0, 200) });
    }
  }).listen(Number(env.OOTLE_PAY_PORT ?? 8090), "127.0.0.1", () => console.log(`[ootle-pay] ready; lanes ${settings.hub}, provider ${providerKey}`));

  if (env.WALLETD_URL && env.OOTLE_ACCOUNT) {
    const { accountInfo, submitInstructions, walletd } = await import("./tx.mjs");
    const { calls, txTarget } = await import("./lanes.mjs");
    const rpc = walletd();
    const acct = await accountInfo(rpc, env.OOTLE_ACCOUNT);
    if (acct.key !== providerKey) throw new Error(`walletd account ${env.OOTLE_ACCOUNT}'s key isn't OOTLE_PROVIDER_KEY`);
    const claimRound = async () => {
      const chain = new Map();
      for (const n of Object.keys(ledger.lanes)) chain.set(Number(n), await lane(n).catch(() => null));
      for (const { voucher: v, amount } of claimable(ledger, (n) => chain.get(n), claimMin)) {
        try {
          const { instructions, inputs } = calls.claim(acct.component, v, amount);
          const r = await submitInstructions(rpc, { feeAccount: acct.component, signerIndex: acct.index, instructions, inputs, live: true, ...txTarget() });
          console.log(`[ootle-pay] claimed lane ${v.lane} up to ${amount} µT: ${r.transaction_id} (fee ${r.fee} µT)`);
        } catch (e) {
          console.log(`[ootle-pay] claim on lane ${v.lane} failed: ${String(e.message).slice(0, 300)}`);
        }
      }
    };
    setInterval(() => claimRound().catch((e) => console.log(`[ootle-pay] claim round: ${e.message}`)), Number(env.OOTLE_CLAIM_EVERY_S ?? 600) * 1000);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`[ootle-pay] ${e.message}`); process.exit(1); });
