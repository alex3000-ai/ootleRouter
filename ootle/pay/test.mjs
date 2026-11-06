// The payment rules: which vouchers start a turn, what a turn holds and is charged, and which voucher to claim.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keygen, signVoucher, verifyVoucher } from "./ootlebook/keys.mjs";
import { admit, charge, claimable, emptyLedger, HOLD_TTL_MS, IDLE_MS, offer, ours, start, START_TTL_MS, status } from "./server.mjs";

const hub = "component_" + "ab".repeat(32);
const voucherKey = keygen();
const settings = { hub, network: "esmeralda", provider: "router", reserve: 1_000 };
const chain = (over = {}) => ({ id: "router.0", buyer: "hirer", provider: "router", voucher_key: voucherKey.publicKey, deposited: 10_000, claimed: 0, close_requested_epoch: null, closed: false, ...over });
const voucher = (cum, lane = "router.0", key = voucherKey, network = "esmeralda") => signVoucher(key.secretKey, hub, lane, cum, network);

test("Ootlebook vouchers sign and verify, and any change breaks them", () => {
  const v = voucher(2_500);
  assert.ok(verifyVoucher(v));
  assert.ok(!verifyVoucher({ ...v, spent_cum: "2501" }));
  assert.ok(!verifyVoucher({ ...v, lane: "router.1" }));
  assert.ok(!verifyVoucher({ ...v, network: "localnet" }), "a voucher is bound to its network");
});

test("only this router's lanes are ours, decided before any chain read", () => {
  assert.ok(ours("router.0", "router") && ours("router.12", "router"));
  for (const id of ["routerx.0", "other.0", "router.", "router.1a", "router", null, 3]) assert.ok(!ours(id, "router"), String(id));
});

test("a turn starts only on a valid voucher for a lane that pays this router", () => {
  const ledger = emptyLedger();
  const code = (r) => r.refused?.code;
  assert.equal(code(admit(ledger, null, chain(), settings)), "voucher_required");
  assert.equal(code(admit(ledger, { ...voucher(2_000), hub: "component_" + "cd".repeat(32) }, chain(), settings)), "voucher_invalid");
  assert.equal(code(admit(ledger, { ...voucher(2_000), spent_cum: "3000" }, chain(), settings)), "voucher_invalid");
  assert.equal(code(admit(ledger, voucher(2_000, "router.0", voucherKey, "localnet"), chain(), settings)), "voucher_invalid");
  assert.equal(code(admit(ledger, voucher(2_000, "other.0"), chain({ provider: "other" }), settings)), "voucher_invalid", "another agent's lane");
  assert.equal(code(admit(ledger, voucher(2_000), null, settings)), "lane_not_found");
  assert.equal(code(admit(ledger, voucher(2_000, "router.0", keygen()), chain(), settings)), "voucher_invalid");
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
  assert.ok(admit(ledger, voucher(1_000), chain(), settings).hold, "an older voucher still admits on the best one kept");
  assert.equal(status(ledger, "router.0").voucher_cum, 2_500);
});

test("a hold lapses in minutes unless its turn starts, and then within hours, but can still be charged", () => {
  const ledger = emptyLedger();
  const t0 = 1_000_000, at = (now) => ({ ...settings, now });
  const never = admit(ledger, voucher(2_000), chain(), at(t0));
  const ran = admit(ledger, voucher(2_000), chain(), at(t0));
  assert.equal(admit(ledger, voucher(2_000), chain(), at(t0)).refused.code, "payment_required");
  assert.ok(start(ledger, ran.hold, t0));
  assert.ok(!start(ledger, "no-such-hold", t0));
  assert.equal(status(ledger, "router.0", t0 + START_TTL_MS).held, 1_000, "only the started turn still holds");
  assert.equal(status(ledger, "router.0", t0 + HOLD_TTL_MS).held, 0);
  assert.equal(charge(ledger, never.hold, 300, t0).charged, 300, "a lapsed hold is still charged if its turn ran");
  assert.equal(charge(ledger, ran.hold, 700, t0).balance, 1_000);
});

test("an offered voucher is checked and kept, and starts nothing", () => {
  const ledger = emptyLedger();
  assert.equal(offer(ledger, voucher(2_000, "router.0", keygen()), chain(), settings).refused.code, "voucher_invalid");
  assert.equal(offer(ledger, voucher(2_000), chain(), settings).voucher_cum, 2_000);
  assert.deepEqual(ledger.holds, {});
});

test("claims take the highest voucher at or below the charges; above them only when a lane closes or idles", () => {
  const t0 = 10_000_000, ledger = emptyLedger(), lanes = { "router.0": chain() };
  const claims = (min, fee = 0, now = t0) => claimable(ledger, (id) => lanes[id], min, fee, now).map((c) => Number(c.voucher.spent_cum));
  charge(ledger, admit(ledger, voucher(5_000), chain(), { ...settings, now: t0 }).hold, 4_200, t0);
  assert.deepEqual(claims(1), [], "a lane holding only a voucher above its charges isn't claimed while it's in use");
  offer(ledger, voucher(4_200), chain(), settings);
  assert.deepEqual(claims(4_000), [4_200], "a settlement voucher is claimed exactly");
  assert.deepEqual(claims(4_201), [], "not until it adds the minimum");
  lanes["router.0"] = chain({ claimed: 4_200 });
  charge(ledger, admit(ledger, voucher(6_000), chain(), { ...settings, now: t0 }).hold, 900, t0);
  assert.deepEqual(claims(1), [5_000], "charged 5,100: the 5,000 voucher is the highest at or below, and is claimed");
  lanes["router.0"] = chain({ claimed: 5_000 });
  assert.deepEqual(claims(1), [], "the last 100 µT has no voucher at or below the charges, so the lane in use waits");
  assert.deepEqual(claims(1, 0, t0 + IDLE_MS), [6_000], "an idle lane is claimed on the voucher above: at most a reserve over");
  lanes["router.0"] = chain({ claimed: 5_000, close_requested_epoch: 9 });
  assert.deepEqual(claims(1_000_000, 5_000), [], "a closing lane isn't claimed for less than a claim's fee");
  assert.deepEqual(claims(1_000_000, 500), [6_000], "a closing lane is claimed above the minimum");
  lanes["router.0"] = chain({ closed: true });
  assert.deepEqual(claims(0), [], "a closed lane is never claimed");
});
