//! End-to-end tests for OotleRouterLanes, executed in-process by the Ootle engine (`tari_template_test_tooling`).

use ootle_byte_type::ToByteType;
use ootlerouter_lanes::*;
use tari_crypto::{
    keys::{PublicKey as _, SecretKey as _},
    ristretto::{RistrettoPublicKey, RistrettoSchnorr, RistrettoSecretKey},
    tari_utilities::hex::Hex,
};
use tari_engine_types::{
    indexed_value::IndexedValue,
    virtual_substate::{VirtualSubstate, VirtualSubstateId},
};
use tari_ootle_common_types::RistrettoSchnorrBlake2bVerifier;
use tari_ootle_transaction::{args, builder::named_args::NamedArg, Transaction};
use tari_template_lib_types::{
    constants::TARI_TOKEN,
    crypto::{RistrettoPublicKeyBytes, SignaturePayload},
    Amount, ComponentAddress, NonFungibleAddress, ResourceAddress,
};
use tari_template_test_tooling::TemplateTest;

const CLOSE_WINDOW: u64 = 6;

fn pk(key: &RistrettoSecretKey) -> RistrettoPublicKeyBytes {
    RistrettoPublicKey::from_secret_key(key).to_byte_type()
}

fn new_key() -> RistrettoSecretKey {
    RistrettoSecretKey::random(&mut rand::rng())
}

fn schnorr(key: &RistrettoSecretKey, message: &[u8]) -> SignaturePayload {
    let (nonce, public_nonce) = RistrettoPublicKey::random_keypair(&mut rand::rng());
    let challenge = RistrettoSchnorrBlake2bVerifier::compute_challenge(VOUCHER_DOMAIN, message, &pk(key), &public_nonce.to_byte_type());
    SignaturePayload::RistrettoSchnorrBlake2b(RistrettoSchnorr::sign_raw_uniform(key, nonce, &challenge).expect("sign").to_byte_type())
}

struct Party {
    account: ComponentAddress,
    proof: NonFungibleAddress,
    key: RistrettoSecretKey,
}

struct Hub {
    test: TemplateTest,
    hub: ComponentAddress,
    reader: Party,
}

impl Hub {
    fn deploy() -> Self {
        let mut test = TemplateTest::new(env!("CARGO_MANIFEST_DIR"), ["../template"]);
        let (account, proof, key) = test.create_funded_account();
        let template = test.get_template_address("OotleRouterLanes");
        test.execute_expect_success(test.transaction().call_function(template, "new", args![TARI_TOKEN, CLOSE_WINDOW]).finish().seal(&key), vec![proof.clone()]);
        let hub = *test.return_values()[0].component_addresses().first().expect("component");
        Self { test, hub, reader: Party { account, proof, key } }
    }

    fn party(&mut self) -> Party {
        let (account, proof, key) = self.test.create_funded_account();
        Party { account, proof, key }
    }

    /// `method` signed by `payer`, with `amount` withdrawn from its account as the last argument.
    fn paid(&self, payer: &Party, amount: u64, method: &str, mut args: Vec<NamedArg>) -> Transaction {
        args.push(NamedArg::Workspace("funds".into()));
        self.test.transaction()
            .call_method(payer.account, "withdraw", args![TARI_TOKEN, amount])
            .put_last_instruction_output_on_workspace("funds")
            .call_method(self.hub, method, args)
            .finish()
            .seal(&payer.key)
    }

    /// `method`, whose returned bucket goes into `p`'s account.
    fn payout(&self, p: &Party, method: &str, args: Vec<NamedArg>) -> Transaction {
        self.test.transaction()
            .call_method(self.hub, method, args)
            .put_last_instruction_output_on_workspace("out")
            .call_method(p.account, "deposit", args![Workspace("out")])
            .finish()
            .seal(&p.key)
    }

    fn ok(&mut self, tx: Transaction, p: &Party) {
        self.test.execute_expect_success(tx, vec![p.proof.clone()]);
    }

    fn fails(&mut self, tx: Transaction, p: &Party, expected: &str) {
        let reason = self.test.execute_expect_failure(tx, vec![p.proof.clone()]).to_string();
        assert!(reason.contains(expected), "expected rejection containing {expected:?}, got: {reason}");
    }

    fn call(&mut self, p: &Party, method: &str, args: Vec<NamedArg>) {
        let tx = self.test.transaction().call_method(self.hub, method, args).finish().seal(&p.key);
        self.ok(tx, p);
    }

    fn call_fails(&mut self, p: &Party, method: &str, args: Vec<NamedArg>, expected: &str) {
        let tx = self.test.transaction().call_method(self.hub, method, args).finish().seal(&p.key);
        self.fails(tx, p, expected);
    }

    fn read(&mut self, method: &str, args: Vec<NamedArg>) -> IndexedValue {
        let tx = self.test.transaction().call_method(self.hub, method, args).finish().seal(&self.reader.key);
        self.test.execute_expect_success(tx, vec![self.reader.proof.clone()]);
        self.test.return_values()[0].clone()
    }

    fn open(&mut self, buyer: &Party, provider: &Party, voucher_key: &RistrettoSecretKey, amount: u64) -> u64 {
        let tx = self.paid(buyer, amount, "open_lane", args![pk(&provider.key), pk(voucher_key)]);
        self.ok(tx, buyer);
        self.test.return_values().iter().find_map(|v| v.decoded::<u64>().ok()).expect("a lane number")
    }

    fn voucher(&self, key: &RistrettoSecretKey, lane: u64, spent: u64) -> SignaturePayload {
        schnorr(key, &voucher_message(&self.hub, lane, spent.into()))
    }

    fn claim(&self, p: &Party, lane: u64, spent: u64, voucher: SignaturePayload) -> Transaction {
        self.payout(p, "claim", args![lane, Amount::from(spent), voucher])
    }

    fn lane(&mut self, lane: u64) -> LaneState {
        self.read("get_lane", args![lane]).decoded::<(Lane, LaneState)>().expect("lane").1
    }

    fn balance(&mut self, p: &Party) -> Amount {
        self.test.call_method(p.account, "balance", args![TARI_TOKEN], vec![])
    }

    fn settings(&mut self) -> (ResourceAddress, u64, Amount, u64) {
        self.read("settings", args![]).decoded().expect("settings")
    }

    /// escrow == what every lane still holds.
    fn assert_conserved(&mut self, lanes: &[u64]) {
        let held = lanes.iter().map(|l| self.lane(*l).remaining()).fold(Amount::zero(), |a, b| a + b);
        assert_eq!(self.settings().2, held, "escrow doesn't match the lanes");
    }

    fn set_epoch(&mut self, epoch: u64) {
        self.test.set_virtual_substate(VirtualSubstateId::CurrentEpoch, VirtualSubstate::CurrentEpoch(epoch));
    }
}

#[test]
fn claims_pay_the_provider_and_escrow_is_conserved() {
    let mut h = Hub::deploy();
    let (buyer, provider) = (h.party(), h.party());
    let vk = new_key();
    assert_eq!(h.open(&buyer, &provider, &vk, 10_000), 0);
    assert_eq!(h.open(&buyer, &provider, &vk, 1_000), 1);
    assert_eq!(h.settings().1, 2);
    let before = h.balance(&provider);
    let tx = h.claim(&provider, 0, 3_000, h.voucher(&vk, 0, 3_000));
    h.ok(tx, &provider);
    let tx = h.claim(&provider, 0, 5_000, h.voucher(&vk, 0, 5_000));
    h.ok(tx, &provider);
    assert!(h.balance(&provider) > before + Amount::from(4_000u64), "the provider got the 5,000 less its fees");
    assert_eq!(h.lane(0).claimed, Amount::from(5_000u64));
    h.assert_conserved(&[0, 1]);

    let tx = h.claim(&provider, 0, 5_000, h.voucher(&vk, 0, 5_000));
    h.fails(tx, &provider, "does not exceed");
    let tx = h.claim(&provider, 0, 10_001, h.voucher(&vk, 0, 10_001));
    h.fails(tx, &provider, "exceeds the lane's escrow");
    let tx = h.claim(&provider, 0, 6_000, h.voucher(&new_key(), 0, 6_000));
    h.fails(tx, &provider, "invalid voucher signature");
    // A voucher for one lane can't be spent on another.
    let tx = h.claim(&provider, 0, 600, h.voucher(&vk, 1, 600));
    h.fails(tx, &provider, "does not exceed");
    let tx = h.claim(&provider, 1, 600, h.voucher(&vk, 0, 600));
    h.fails(tx, &provider, "invalid voucher signature");
    let tx = h.claim(&buyer, 0, 6_000, h.voucher(&vk, 0, 6_000));
    h.fails(tx, &buyer, "only the lane's own key");
    let tx = h.paid(&buyer, 1_000, "open_lane", args![pk(&buyer.key), pk(&vk)]);
    h.fails(tx, &buyer, "cannot open a lane to yourself");
}

#[test]
fn closing_waits_for_the_window_and_release_refunds_at_once() {
    let mut h = Hub::deploy();
    let (buyer, provider, outsider) = (h.party(), h.party(), h.party());
    let vk = new_key();
    h.set_epoch(100);
    let a = h.open(&buyer, &provider, &vk, 10_000);
    let b = h.open(&buyer, &provider, &vk, 4_000);
    let tx = h.paid(&outsider, 1_000, "fund_lane", args![a]);
    h.fails(tx, &outsider, "only the lane's own key");
    let tx = h.paid(&buyer, 1_000, "fund_lane", args![a]);
    h.ok(tx, &buyer);
    h.call_fails(&provider, "request_close", args![a], "only the lane's own key");
    h.call(&buyer, "request_close", args![a]);
    let tx = h.payout(&buyer, "refund", args![a]);
    h.fails(tx, &buyer, "close window has not passed");
    let tx = h.paid(&buyer, 1_000, "fund_lane", args![a]);
    h.fails(tx, &buyer, "closing or closed");
    let tx = h.claim(&provider, a, 2_000, h.voucher(&vk, a, 2_000));
    h.ok(tx, &provider);
    h.set_epoch(100 + CLOSE_WINDOW);
    let before = h.balance(&buyer);
    let tx = h.payout(&buyer, "refund", args![a]);
    h.ok(tx, &buyer);
    assert!(h.balance(&buyer) > before + Amount::from(8_000u64), "the buyer got the 9,000 left less its fees");
    let tx = h.claim(&provider, a, 3_000, h.voucher(&vk, a, 3_000));
    h.fails(tx, &provider, "lane is closed");

    h.call_fails(&buyer, "release_lane", args![b], "only the lane's own key");
    h.call(&provider, "release_lane", args![b]);
    let tx = h.claim(&provider, b, 1_000, h.voucher(&vk, b, 1_000));
    h.fails(tx, &provider, "lane is closed");
    let tx = h.payout(&outsider, "refund", args![b]);
    h.fails(tx, &outsider, "only the lane's own key");
    let tx = h.payout(&buyer, "refund", args![b]);
    h.ok(tx, &buyer);
    let tx = h.payout(&buyer, "refund", args![b]);
    h.fails(tx, &buyer, "nothing to refund");
    h.assert_conserved(&[a, b]);
}

#[test]
fn lanes_roll_over_into_a_new_page_vault() {
    let mut h = Hub::deploy();
    let (buyer, provider) = (h.party(), h.party());
    let vk = new_key();
    for _ in 0..PAGE_SIZE + 1 {
        h.open(&buyer, &provider, &vk, 1);
    }
    assert_eq!(h.lane(PAGE_SIZE).deposited, Amount::from(1u64));
}

#[test]
fn vouchers_from_the_javascript_client_are_accepted() {
    let mut h = Hub::deploy();
    let (buyer, provider) = (h.party(), h.party());
    let vk = new_key();
    let lane = h.open(&buyer, &provider, &vk, 5_000);
    let script = "import { signVoucher } from './pay/keys.mjs'; \
        const [key, hub, lane, spent] = process.argv.slice(1); \
        const v = signVoucher(key, hub, lane, spent); process.stdout.write(v.public_nonce + ' ' + v.signature);";
    let out = std::process::Command::new("node")
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/.."))
        .args(["--input-type=module", "-e", script, &vk.to_hex(), &h.hub.to_string(), &lane.to_string(), "2500"])
        .output()
        .expect("run node (install Node.js and `npm install` in pay/)");
    assert!(out.status.success(), "node failed: {}", String::from_utf8_lossy(&out.stderr));
    let out = String::from_utf8(out.stdout).expect("utf8");
    let (nonce, s) = out.split_once(' ').expect("nonce and signature");
    let (nonce, s) = (RistrettoPublicKey::from_hex(nonce).expect("nonce"), RistrettoSecretKey::from_hex(s).expect("s"));
    let voucher = SignaturePayload::RistrettoSchnorrBlake2b(RistrettoSchnorr::new(nonce, s).to_byte_type());
    let tx = h.claim(&provider, lane, 2_500, voucher);
    h.ok(tx, &provider);
}
