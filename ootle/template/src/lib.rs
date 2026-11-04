//! OotleRouterLanes: pay-per-use payment lanes between any buyer and any provider on Ootle, in one component with
//! no admin and no owner. The close window is fixed when it is created.
//!
//! A buyer escrows funds for a provider (named by its account key) and signs vouchers off-chain for the cumulative
//! amount spent, with a voucher key it names when opening the lane. The provider claims the latest voucher whenever
//! it likes. To stop, the buyer requests a close and refunds the rest once the close window has passed, or at once
//! if the provider releases the lane. The buyer and provider are the keys that sign their transactions.
//! Lanes are non-fungibles numbered 0, 1, 2… in page vaults of 256, so a call costs the same however many there are.
//! Escrow sits in one vault: `escrow == sum over lanes of (deposited - claimed - refunded)`.

use minicbor::{CborLen, Decode, Encode};
use tari_template_lib::prelude::*;

/// Signature domain for vouchers.
pub const VOUCHER_DOMAIN: &[u8] = b"ootlerouter-voucher-v1";
/// Lanes per page vault.
pub const PAGE_SIZE: u64 = 256;

/// What a lane's voucher key signs: the cumulative amount the provider may have claimed.
pub fn voucher_message(hub: &ComponentAddress, lane: u64, spent_cum: Amount) -> Vec<u8> {
    format!("{hub}|{lane}|{}", spent_cum.to_u128()).into_bytes()
}

#[derive(Debug, Clone, Encode, Decode, CborLen)]
pub struct Lane {
    /// Funds, closes and refunds the lane.
    #[n(0)]
    pub buyer_key: RistrettoPublicKeyBytes,
    /// Claims and releases.
    #[n(1)]
    pub provider_key: RistrettoPublicKeyBytes,
    /// The only key whose vouchers this lane accepts.
    #[n(2)]
    pub voucher_key: RistrettoPublicKeyBytes,
    #[n(3)]
    pub opened_epoch: u64,
}

#[derive(Debug, Clone, Encode, Decode, CborLen)]
pub struct LaneState {
    #[n(0)]
    pub deposited: Amount,
    /// The highest voucher claimed so far.
    #[n(1)]
    pub claimed: Amount,
    #[n(2)]
    pub refunded: Amount,
    #[n(3)]
    pub close_requested_epoch: Option<u64>,
    /// Released by the provider or refunded by the buyer: no more claims.
    #[n(4)]
    pub closed: bool,
}

impl LaneState {
    pub fn remaining(&self) -> Amount {
        self.deposited.checked_sub(self.claimed).and_then(|a| a.checked_sub(self.refunded)).expect("lane paid out more than deposited")
    }
}

#[template]
mod ootlerouter_lanes {
    use super::*;

    pub struct OotleRouterLanes {
        lanes: ResourceAddress,
        pages: Vec<Vault>,
        count: u64,
        escrow: Vault,
        close_epochs: u64,
    }

    impl OotleRouterLanes {
        /// Lanes escrow `payment_resource`; a provider can still claim for `close_epochs` after its buyer asks to close.
        pub fn new(payment_resource: ResourceAddress, close_epochs: u64) -> Component<Self> {
            assert!(close_epochs > 0, "the close window must be at least one epoch");
            let alloc = CallerContext::allocate_component_address(None);
            let this = rule!(component(alloc.get_address()));
            let lanes = ResourceBuilder::non_fungible()
                .with_token_symbol("LANE")
                .mintable(this.clone(), UpdateRule::Locked)
                .update_non_fungible_data(this, UpdateRule::Locked)
                .burnable(rule!(deny_all), UpdateRule::Locked)
                .recallable(rule!(deny_all), UpdateRule::Locked)
                .freezable(rule!(deny_all), UpdateRule::Locked)
                .withdrawable(rule!(deny_all), UpdateRule::Locked)
                .with_owner_rule(OwnerRule::None)
                .disable_total_supply_tracking()
                .build();
            Component::new(Self { lanes, pages: vec![Vault::new_empty(lanes)], count: 0, escrow: Vault::new_empty(payment_resource), close_epochs })
                .with_address_allocation(alloc)
                .with_access_rules(AccessRules::new().default(rule!(allow_all)))
                .with_owner_rule(OwnerRule::None)
                .create()
        }

        /// The signer opens a lane to `provider_key`, escrowing `funds`. `voucher_key` signs its vouchers. Returns its number.
        pub fn open_lane(&mut self, provider_key: RistrettoPublicKeyBytes, voucher_key: RistrettoPublicKeyBytes, funds: Bucket) -> u64 {
            let buyer_key = CallerContext::transaction_signer_public_key();
            assert!(buyer_key != provider_key, "cannot open a lane to yourself");
            let amount = self.take_escrow(funds);
            let id = self.count;
            self.count += 1;
            let lane = ResourceManager::get(self.lanes).mint_non_fungible(
                NonFungibleId::from_u64(id),
                &Lane { buyer_key, provider_key, voucher_key, opened_epoch: Consensus::current_epoch() },
                &LaneState { deposited: amount, claimed: Amount::zero(), refunded: Amount::zero(), close_requested_epoch: None, closed: false },
            );
            if self.pages.last().expect("at least one page").balance() >= Amount::from(PAGE_SIZE) {
                self.pages.push(Vault::new_empty(self.lanes));
            }
            self.pages.last().expect("at least one page").deposit(lane);
            emit_event("lanes.opened", metadata!("id" => id.to_string(), "amount" => amount.to_string()));
            id
        }

        /// The buyer adds escrow to a lane that isn't closing.
        pub fn fund_lane(&mut self, lane: u64, funds: Bucket) {
            let (info, mut state) = self.load(lane);
            signed_by(&info.buyer_key);
            assert!(!state.closed && state.close_requested_epoch.is_none(), "lane is closing or closed");
            let amount = self.take_escrow(funds);
            state.deposited = state.deposited.checked_add(amount).expect("deposit overflow");
            self.save(lane, state, "lanes.funded");
        }

        /// Pays the provider for a voucher over `spent_cum`, the cumulative amount the buyer has authorised; the
        /// provider receives the part not yet claimed. Works while a close is pending, until the buyer refunds.
        pub fn claim(&mut self, lane: u64, spent_cum: Amount, voucher: SignaturePayload) -> Bucket {
            let (info, mut state) = self.load(lane);
            signed_by(&info.provider_key);
            assert!(!state.closed, "lane is closed");
            assert!(spent_cum > state.claimed, "voucher does not exceed the amount already claimed");
            assert!(spent_cum <= state.deposited, "voucher exceeds the lane's escrow");
            let message = voucher_message(&CallerContext::current_component_address(), lane, spent_cum);
            assert!(SignatureVerifier::with_domain(VOUCHER_DOMAIN).verify(&PublicKey::Ristretto25519(info.voucher_key), &message, &voucher), "invalid voucher signature");
            let payout = spent_cum.checked_sub(state.claimed).expect("checked above");
            state.claimed = spent_cum;
            self.save(lane, state, "lanes.claimed");
            self.escrow.withdraw(payout)
        }

        /// The buyer starts closing a lane; the provider can still claim until the close window has passed.
        pub fn request_close(&self, lane: u64) {
            let (info, mut state) = self.load(lane);
            signed_by(&info.buyer_key);
            assert!(!state.closed && state.close_requested_epoch.is_none(), "lane is closing or closed");
            state.close_requested_epoch = Some(Consensus::current_epoch());
            self.save(lane, state, "lanes.close_requested");
        }

        /// The provider closes a lane at once; the buyer can then refund.
        pub fn release_lane(&self, lane: u64) {
            let (info, mut state) = self.load(lane);
            signed_by(&info.provider_key);
            assert!(!state.closed, "lane is closed");
            state.closed = true;
            self.save(lane, state, "lanes.released");
        }

        /// The buyer takes back what wasn't claimed, once the provider released the lane or the close window passed.
        pub fn refund(&mut self, lane: u64) -> Bucket {
            let (info, mut state) = self.load(lane);
            signed_by(&info.buyer_key);
            if !state.closed {
                let requested = state.close_requested_epoch.expect("close was not requested");
                assert!(Consensus::current_epoch() >= requested.saturating_add(self.close_epochs), "close window has not passed");
            }
            let amount = state.remaining();
            assert!(amount.is_positive(), "nothing to refund");
            state.refunded = state.refunded.checked_add(amount).expect("refund overflow");
            state.closed = true;
            self.save(lane, state, "lanes.refunded");
            self.escrow.withdraw(amount)
        }

        // ---- reads (readers usually fetch the substates from an indexer instead) ----

        /// (lanes resource, lanes opened, escrow held, close window).
        pub fn settings(&self) -> (ResourceAddress, u64, Amount, u64) {
            (self.lanes, self.count, self.escrow.balance(), self.close_epochs)
        }

        pub fn get_lane(&self, lane: u64) -> (Lane, LaneState) {
            self.load(lane)
        }

        fn load(&self, lane: u64) -> (Lane, LaneState) {
            let nft = ResourceManager::get(self.lanes).get_non_fungible(&NonFungibleId::from_u64(lane));
            (nft.get_data(), nft.get_mutable_data())
        }

        fn save(&self, lane: u64, state: LaneState, event: &str) {
            ResourceManager::get(self.lanes).update_non_fungible_data(NonFungibleId::from_u64(lane), &state);
            emit_event(event, metadata!("id" => lane.to_string()));
        }

        fn take_escrow(&self, funds: Bucket) -> Amount {
            assert_eq!(funds.resource_address(), self.escrow.resource_address(), "wrong payment resource");
            let amount = funds.amount();
            assert!(amount.is_positive(), "lane amount must be positive");
            self.escrow.deposit(funds);
            amount
        }
    }
}

fn signed_by(key: &RistrettoPublicKeyBytes) {
    assert!(CallerContext::transaction_signer_public_key() == *key, "only the lane's own key can do this");
}
