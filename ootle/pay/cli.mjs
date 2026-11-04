#!/usr/bin/env node
// ootlerouter-lanes: pay an ootleRouter per use through OotleRouterLanes on Tari Ootle. Writes dry-run unless --live.
//   keygen --out FILE                                 a new voucher key (secret to FILE); prints the public key
//   lane <n>                                          a lane as the chain has it
//   voucher --key-file FILE <lane> <spent_cum µT>     a voucher: send it as the X-Ootle-Voucher header
//   open --account A <provider key> <µT> <voucher public key>
//   fund --account A <lane> <µT>
//   claim --account A <voucher.json> [µT]             (provider) up to µT in all (default: the voucher's cap)
//   release --account A <lane>                        (provider) end a lane at once; the buyer can refund
//   close --account A <lane> ; refund --account A <lane>   (buyer) refund works once the close window has passed
// Writes go through tari_ootle_walletd at WALLETD_URL (default http://127.0.0.1:5100/json_rpc) with WALLETD_TOKEN or
// WALLETD_TOKEN_FILE; the lanes component is deployments/esmeralda.json's unless OOTLE_LANES_COMPONENT is set.

import { readFileSync, writeFileSync } from "node:fs";
import { isPublicKey, keygen, signVoucher, verifyVoucher } from "./keys.mjs";
import { calls, currentEpoch, deployment, hubState, lane, txTarget } from "./lanes.mjs";
import { accountInfo, parseArgs, report, submitInstructions, usage, walletd } from "./tx.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const { flags, args } = parseArgs(rest);
const fail = (msg) => { console.error(msg); process.exit(1); };
const need = (ok, msg) => ok || fail(msg);
const whole = (s) => /^[1-9]\d*$/.test(s ?? "");

async function send(what, build) {
  need(typeof flags.account === "string", "--account is required");
  const rpc = walletd();
  const acct = await accountInfo(rpc, flags.account);
  await hubState();
  const { instructions, inputs } = build(acct);
  const r = await submitInstructions(rpc, { feeAccount: acct.component, signerIndex: acct.index, instructions, inputs, live: flags.live === true, ceiling: Number(flags["max-fee"] ?? 15_000), ...txTarget() });
  report(r, what);
  return { r, acct };
}

const laneOf = async (n) => (need(/^\d+$/.test(n ?? ""), "a lane is a whole number"), (await lane(n)) ?? fail(`no lane ${n}`));

switch (cmd) {
  case "keygen": {
    need(typeof flags.out === "string", "usage: keygen --out FILE");
    const k = keygen();
    writeFileSync(flags.out, k.secretKey + "\n", { mode: 0o600, flag: "wx" });
    console.log(k.publicKey);
    break;
  }
  case "lane":
    console.log(JSON.stringify(await laneOf(args[0]), null, 2));
    break;
  case "voucher": {
    const [n, spent] = args;
    const l = await laneOf(n);
    need(/^\d+$/.test(spent ?? "") && BigInt(spent) <= BigInt(l.deposited), `the voucher must be a whole µT amount up to the lane's ${l.deposited}`);
    const v = signVoucher(readFileSync(flags["key-file"] ?? fail("--key-file is required"), "utf8").trim(), deployment().hub, n, spent);
    need(v.public_key === l.voucher_key && verifyVoucher(v), `that key isn't lane ${n}'s voucher key`);
    console.log(JSON.stringify(v));
    break;
  }
  case "open": {
    const [providerKey, amount, voucherKey] = args;
    need(isPublicKey(providerKey) && whole(amount) && isPublicKey(voucherKey), "usage: open --account A <provider key> <µT> <voucher public key>");
    const before = (await hubState({ fresh: true })).count;
    const { r, acct } = await send(`opened a lane to ${providerKey.slice(0, 12)}…`, (a) => calls.open(a.component, amount, providerKey, voucherKey));
    if (r.dry_run) break;
    // Others may open lanes at the same moment: ours is the new one with our keys.
    const after = (await hubState({ fresh: true })).count;
    for (let n = after - 1; n >= before; n--) {
      const l = await lane(n);
      if (l?.buyer_key === acct.key && l.voucher_key === voucherKey) { console.log(`lane ${n}`); break; }
    }
    break;
  }
  case "fund": {
    const [n, amount] = args;
    need(whole(amount), "usage: fund --account A <lane> <µT>");
    const l = await laneOf(n);
    need(!l.closed && l.close_requested_epoch === null, `lane ${n} is closing or closed`);
    await send(`funded lane ${n}`, (a) => calls.fund(a.component, amount, n));
    break;
  }
  case "claim": {
    const v = JSON.parse(readFileSync(args[0] ?? fail("usage: claim --account A <voucher.json> [µT]"), "utf8"));
    const amount = args[1] ?? v.spent_cum;
    const l = await laneOf(String(v.lane));
    need(v.hub === deployment().hub && v.public_key === l.voucher_key && verifyVoucher(v), "the voucher isn't valid for this lane");
    need(/^\d+$/.test(amount) && BigInt(amount) <= BigInt(v.spent_cum), `claim at most the voucher's ${v.spent_cum} µT`);
    need(!l.closed && BigInt(amount) > BigInt(l.claimed), `nothing to claim: lane ${l.id} has paid out ${l.claimed} µT${l.closed ? " and is closed" : ""}`);
    await send(`claimed lane ${l.id} up to ${amount} µT`, (a) => calls.claim(a.component, v, amount));
    break;
  }
  case "close":
  case "release":
  case "refund": {
    const l = await laneOf(args[0]);
    need(!l.closed || cmd === "refund", `lane ${l.id} is closed`);
    if (cmd === "close") need(l.close_requested_epoch === null, `lane ${l.id} is already closing`);
    if (cmd === "refund") {
      need(l.remaining > 0, `lane ${l.id} has nothing to refund`);
      if (!l.closed) {
        need(l.close_requested_epoch !== null, `close lane ${l.id} first`);
        const ready = l.close_requested_epoch + (await hubState()).close_epochs;
        need((await currentEpoch()) >= ready, `lane ${l.id} can be refunded from epoch ${ready}`);
      }
    }
    const build = { close: () => calls.requestClose(l.id), release: () => calls.release(l.id), refund: (a) => calls.refund(a.component, l.id) }[cmd];
    await send(`${cmd} lane ${l.id}`, build);
    break;
  }
  default:
    usage(import.meta.url, cmd);
}
