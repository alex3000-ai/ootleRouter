// The payment rules: which vouchers start a turn, what a turn holds and is charged, and when to claim.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keygen, signVoucher, verifyVoucher } from "./keys.mjs";
import { admit, charge, claimable, emptyLedger, HOLD_TTL_MS, start, START_TTL_MS, status } from "./server.mjs";

const hub = "component_" + "ab".repeat(32);
const provider = keygen(), voucherKey = keygen();
const settings = { hub, network: "esmeralda", providerKey: provider.publicKey, reserve: 1_000 };
const chain = (over = {}) => ({ id: 0, provider_key: provider.publicKey, voucher_key: voucherKey.publicKey, deposited: 10_000, claimed: 0, close_requested_epoch: null, closed: false, ...over });
const voucher = (cum, lane = 0, key = voucherKey, network = "esmeralda") => signVoucher(key.secretKey, hub, lane, cum, network);

test("vouchers sign and verify, and any change breaks them", () => {
  const v = voucher(2_500);
  assert.ok(verifyVoucher(v));
  assert.ok(!verifyVoucher({ ...v, spent_cum: "2501" }));
  assert.ok(!verifyVoucher({ ...v, lane: 1 }));
  assert.ok(!verifyVoucher({ ...v, signature: "00" }));
  assert.ok(!verifyVoucher({ ...v, network: "localnet" }), "a voucher is bound to its network");
});

test("a turn starts only on a valid voucher for a lane that pays this router", () => {
  const ledger = emptyLedger();
  const code = (r) => r.refused?.code;
  assert.equal(code(admit(ledger, null, chain(), settings)), "voucher_required");
  assert.equal(code(admit(ledger, { ...voucher(2_000), hub: "component_" + "cd".repeat(32) }, chain(), settings)), "voucher_invalid");
  assert.equal(code(admit(ledger, { ...voucher(2_000), spent_cum: "3000" }, chain(), settings)), "voucher_invalid");
  assert.equal(code(admit(ledger, voucher(2_000, 0, voucherKey, "localnet"), chain(), settings)), "voucher_invalid");
  assert.equal(code(admit(ledger, voucher(2_000), null, settings)), "lane_not_found");
  assert.equal(code(admit(ledger, voucher(2_000), chain({ provider_key: keygen().publicKey }), settings)), "voucher_invalid");
  assert.equal(code(admit(ledger, voucher(2_000, 0, keygen()), chain(), settings)), "voucher_invalid");
  assert.equal(code(admit(ledger, voucher(2_000), chain({ close_requested_epoch: 7 }), settings)), "lane_closed");
  assert.equal(code(admit(ledger, voucher(20_000), chain(), settings)), "voucher_invalid");
  assert.deepEqual(ledger, emptyLedger(), "nothing refused is kept");
  const ok = admit(ledger, voucher(2_000), chain(), settings);
  assert.ok(ok.hold);
  assert.equal(ok.balance, 1_000);
});

test("running turns hold the reserve, finished ones are charged their cost, and the balance gates the next", () => {
  const ledger = emptyLedger();
  const a = admit(ledger, voucher(2_500), chain(), settings);
  const b = admit(ledger, voucher(2_500), chain(), settings);
  assert.equal(b.balance, 500);
  const c = admit(ledger, voucher(2_500), chain(), settings);
  assert.equal(c.refused.code, "payment_required");
  assert.equal(c.refused.voucher_cum_needed, 3_000);
  assert.equal(charge(ledger, a.hold, 1_234.2).charged, 1_235, "charges round up to whole µT");
  assert.equal(charge(ledger, a.hold, 99), null, "a hold is charged once");
  assert.equal(charge(ledger, b.hold, 0).balance, 1_265, "charging 0 releases a hold");
  // An older voucher still admits on the best one kept.
  assert.ok(admit(ledger, voucher(1_000), chain(), settings).hold);
  assert.equal(status(ledger, 0).voucher_cum, 2_500);
});

test("a hold lapses in minutes unless its turn starts, and then within hours, but can still be charged", () => {
  const ledger = emptyLedger();
  const t0 = 1_000_000, at = (now) => ({ ...settings, now });
  const never = admit(ledger, voucher(2_000), chain(), at(t0));
  const ran = admit(ledger, voucher(2_000), chain(), at(t0));
  assert.equal(admit(ledger, voucher(2_000), chain(), at(t0)).refused.code, "payment_required");
  assert.ok(start(ledger, ran.hold, t0));
  assert.ok(!start(ledger, "no-such-hold", t0));
  assert.equal(status(ledger, 0, t0 + START_TTL_MS).held, 1_000, "only the started turn still holds");
  assert.equal(status(ledger, 0, t0 + HOLD_TTL_MS).held, 0);
  assert.equal(charge(ledger, never.hold, 300).charged, 300, "a lapsed hold is still charged if its turn ran");
  assert.equal(charge(ledger, ran.hold, 700).balance, 1_000);
});

test("claims take what turns were charged, never the whole voucher, and wait for the minimum unless a lane closes", () => {
  const ledger = emptyLedger();
  charge(ledger, admit(ledger, voucher(5_000), chain(), settings).hold, 4_200);
  charge(ledger, admit(ledger, voucher(9_000, 1), chain({ id: 1 }), settings).hold, 300);
  const lanes = { 0: chain({ claimed: 200 }), 1: chain({ id: 1 }) };
  const claims = (min) => claimable(ledger, (n) => lanes[n], min).map((c) => [c.voucher.lane, c.amount]);
  assert.deepEqual(claims(4_000), [[0, 4_200]]);
  assert.deepEqual(claims(4_001), []);
  lanes[1].close_requested_epoch = 9;
  assert.deepEqual(claims(4_001), [[1, 300]]);
  assert.deepEqual(claimable(ledger, (n) => lanes[n], 4_001, 5_000), [], "a closing lane isn't claimed for less than the claim's fee");
  lanes[1].closed = true;
  ledger.lanes[0].charged = 7_000;
  assert.deepEqual(claims(0), [[0, 5_000]], "never above the voucher");
});
