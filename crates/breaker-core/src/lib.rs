//! Deterministic compliance engine for the SEC Innovation Exemption.
//!
//! The order (Release 34-XXXXX, effective 2026-09-17, expiring 2031-09-17)
//! grants Tokenized Securities Venues conditional relief from the definition of
//! "exchange". Three of its conditions have to be enforced at trade time:
//!
//!   1. A venue must stop trading a tokenized stock concurrently with a halt or
//!      suspension of the underlying on its primary listing exchange.
//!   2. Trading in a Tier 1 symbol may not exceed 0.25% of the prior month's
//!      average daily share volume; Tier 2 is capped at 2.5%. The first
//!      exceedance requires no action. Any later one forces a three month pause
//!      in that symbol.
//!   3. Every fill has to reach a public, dollar denominated tape.
//!
//! This crate holds the arithmetic for 1 and 2 with no Solana dependencies so it
//! can be tested directly. Rule 3 is a reporting concern and lives in the
//! program, which emits the event the indexer serves.
//!
//! Units: share quantities are nano-shares (1e9 per share) throughout, so a
//! Token-2022 mint's raw amount and a prior-month ADV figure meet on one scale.

#![no_std]

/// Fixed point scale for share quantities and for Scaled UI Amount multipliers.
pub const SHARE_SCALE: u128 = 1_000_000_000;
pub const MULTIPLIER_SCALE: u128 = 1_000_000_000;
pub const BPS_SCALE: u128 = 10_000;

/// Cap on trading as a fraction of the prior month's average daily share
/// volume, per the order.
pub const TIER1_CAP_BPS: u16 = 25; // 0.25%
pub const TIER2_CAP_BPS: u16 = 250; // 2.5%

/// Ceiling on how many symbols a venue may list in each tier.
pub const TIER1_MAX_SYMBOLS: u16 = 75;
pub const TIER2_MAX_SYMBOLS: u16 = 250;

/// The order measures the cap against a daily volume figure, so the venue's
/// running total rolls every 24 hours.
pub const VOLUME_WINDOW_SECONDS: i64 = 24 * 60 * 60;

/// "immediately pause trading for three months in that security"
pub const BREACH_PAUSE_SECONDS: i64 = 90 * 24 * 60 * 60;

/// A halt state older than this is treated as unknown, and unknown fails closed.
/// The venue cannot prove it is mirroring the listing exchange with a stale feed.
pub const DEFAULT_HALT_MAX_AGE_SECONDS: i64 = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Tier {
    One = 1,
    Two = 2,
}

impl Tier {
    pub const fn cap_bps(self) -> u16 {
        match self {
            Tier::One => TIER1_CAP_BPS,
            Tier::Two => TIER2_CAP_BPS,
        }
    }

    pub const fn max_symbols(self) -> u16 {
        match self {
            Tier::One => TIER1_MAX_SYMBOLS,
            Tier::Two => TIER2_MAX_SYMBOLS,
        }
    }

    pub const fn from_u8(v: u8) -> Option<Tier> {
        match v {
            1 => Some(Tier::One),
            2 => Some(Tier::Two),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Rejection {
    /// The underlying is halted or suspended on its primary listing exchange.
    Halted = 0,
    /// The halt feed has not been refreshed recently enough to be trusted.
    HaltStateStale = 1,
    /// The symbol is inside a three month pause from an earlier breach.
    Paused = 2,
    /// The trade would cross the cap and a breach is already on record.
    CapExceeded = 3,
    /// No prior month average daily volume has been published for this symbol.
    AdvUnset = 4,
    /// The mint's Scaled UI Amount multiplier is unusable, so the share count
    /// backing this trade cannot be established.
    MultiplierInvalid = 5,
    /// Arithmetic overflow. Unreachable with sane inputs; never silently allow.
    Overflow = 6,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Under the cap. Settle normally.
    Allow,
    /// Crosses the cap for the first time. The order requires no action on a
    /// first exceedance, so the fill settles and the breach is recorded. Every
    /// later crossing is rejected instead.
    AllowFirstBreach,
    Reject(Rejection),
}

impl Decision {
    pub const fn is_allowed(self) -> bool {
        matches!(self, Decision::Allow | Decision::AllowFirstBreach)
    }
}

/// The venue's running volume total for one symbol.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct VolumeWindow {
    pub window_start: i64,
    /// Nano-shares traded since `window_start`.
    pub window_shares: u64,
}

impl VolumeWindow {
    /// Rolls the window forward if the current one has expired. Returns the
    /// window that applies at `now`.
    pub fn rolled(self, now: i64) -> VolumeWindow {
        if now.saturating_sub(self.window_start) >= VOLUME_WINDOW_SECONDS {
            VolumeWindow { window_start: now, window_shares: 0 }
        } else {
            self
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SymbolState {
    pub tier: Tier,
    /// Prior month average daily volume, in nano-shares, as published by the
    /// venue's attested ADV publisher.
    pub adv_shares: u64,
    pub window: VolumeWindow,
    /// How many times this symbol has already crossed its cap.
    pub breach_count: u16,
    /// Unix timestamp the symbol may trade again, or 0.
    pub paused_until: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HaltState {
    pub halted: bool,
    pub updated_at: i64,
    pub max_age_seconds: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TradeCheck {
    pub now: i64,
    pub halt: HaltState,
    pub symbol: SymbolState,
    /// The trade's size in nano-shares, already adjusted for the mint's
    /// effective Scaled UI Amount multiplier.
    pub trade_shares: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub decision: Decision,
    /// The window to persist when the decision allows the trade.
    pub window: VolumeWindow,
    /// The breach count to persist when the decision allows the trade.
    pub breach_count: u16,
    /// Cap for this window, in nano-shares. Surfaced so the venue can publish
    /// headroom without recomputing it.
    pub cap_shares: u64,
}

/// Cap in nano-shares: `adv_shares * cap_bps / 10_000`.
pub fn cap_shares(adv_shares: u64, cap_bps: u16) -> Option<u64> {
    let cap = (adv_shares as u128).checked_mul(cap_bps as u128)?.checked_div(BPS_SCALE)?;
    u64::try_from(cap).ok()
}

/// Resolves which Scaled UI Amount multiplier is actually in force.
///
/// A Token-2022 mint carries both `multiplier` and `new_multiplier` with an
/// activation timestamp. Once that timestamp passes, the live value is the one
/// that is *not* in the obvious field. Reading the wrong one misstates the share
/// count behind a trade, which corrupts both the cap accounting and the tape.
pub fn effective_multiplier_e9(
    multiplier_e9: u64,
    new_multiplier_e9: u64,
    effective_timestamp: i64,
    now: i64,
) -> Option<u64> {
    let chosen = if now >= effective_timestamp { new_multiplier_e9 } else { multiplier_e9 };
    if chosen == 0 {
        None
    } else {
        Some(chosen)
    }
}

/// Converts a raw Token-2022 amount into nano-shares.
///
/// `raw_amount` is in the mint's base units. `decimals` is the mint's decimals.
/// The multiplier scales the raw amount into the share quantity a holder
/// actually owns.
pub fn raw_to_nano_shares(raw_amount: u64, decimals: u8, multiplier_e9: u64) -> Option<u64> {
    if multiplier_e9 == 0 {
        return None;
    }
    let base = 10u128.checked_pow(decimals as u32)?;
    let scaled = (raw_amount as u128)
        .checked_mul(multiplier_e9 as u128)?
        .checked_mul(SHARE_SCALE)?
        .checked_div(MULTIPLIER_SCALE)?
        .checked_div(base)?;
    u64::try_from(scaled).ok()
}

/// The whole trade time decision, in one pure function.
///
/// Ordering matters and is deliberate: halt state is checked before anything
/// else, because a halted symbol must not trade regardless of headroom, and an
/// unverifiable halt state fails closed.
pub fn evaluate(check: TradeCheck) -> Outcome {
    let TradeCheck { now, halt, symbol, trade_shares } = check;

    let cap = cap_shares(symbol.adv_shares, symbol.tier.cap_bps()).unwrap_or(0);
    let reject = |r: Rejection| Outcome {
        decision: Decision::Reject(r),
        window: symbol.window,
        breach_count: symbol.breach_count,
        cap_shares: cap,
    };

    // 1. Mirror the listing exchange.
    if halt.halted {
        return reject(Rejection::Halted);
    }
    if now.saturating_sub(halt.updated_at) > halt.max_age_seconds {
        return reject(Rejection::HaltStateStale);
    }

    // 2. Honour an in force breach pause.
    if now < symbol.paused_until {
        return reject(Rejection::Paused);
    }

    // 3. A cap cannot be enforced without a published ADV.
    if symbol.adv_shares == 0 || cap == 0 {
        return reject(Rejection::AdvUnset);
    }

    // 4. Roll the daily window, then test the cap against this fill.
    let window = symbol.window.rolled(now);
    let Some(projected) = window.window_shares.checked_add(trade_shares) else {
        return reject(Rejection::Overflow);
    };

    if projected <= cap {
        return Outcome {
            decision: Decision::Allow,
            window: VolumeWindow { window_start: window.window_start, window_shares: projected },
            breach_count: symbol.breach_count,
            cap_shares: cap,
        };
    }

    // Crossing the cap. The order excuses the first exceedance and requires a
    // three month pause for any later one, so once a breach is on record we
    // refuse the trade rather than let a second breach happen at all.
    if symbol.breach_count == 0 {
        Outcome {
            decision: Decision::AllowFirstBreach,
            window: VolumeWindow { window_start: window.window_start, window_shares: projected },
            breach_count: 1,
            cap_shares: cap,
        }
    } else {
        reject(Rejection::CapExceeded)
    }
}

/// The pause a venue must apply when it self reports a breach that happened
/// somewhere this program could not see, such as an affiliated venue.
pub fn pause_until(now: i64) -> i64 {
    now.saturating_add(BREACH_PAUSE_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHARE: u64 = 1_000_000_000; // one share in nano-shares

    fn healthy_halt(now: i64) -> HaltState {
        HaltState { halted: false, updated_at: now, max_age_seconds: DEFAULT_HALT_MAX_AGE_SECONDS }
    }

    fn symbol(adv_shares: u64) -> SymbolState {
        SymbolState {
            tier: Tier::One,
            adv_shares,
            window: VolumeWindow { window_start: 1_000, window_shares: 0 },
            breach_count: 0,
            paused_until: 0,
        }
    }

    #[test]
    fn tier_caps_match_the_order() {
        assert_eq!(Tier::One.cap_bps(), 25);
        assert_eq!(Tier::Two.cap_bps(), 250);
        assert_eq!(Tier::One.max_symbols(), 75);
        assert_eq!(Tier::Two.max_symbols(), 250);
    }

    #[test]
    fn cap_is_a_quarter_percent_for_tier_one() {
        // 90,000,000 shares ADV -> 225,000 shares of headroom.
        let adv = 90_000_000 * SHARE;
        let cap = cap_shares(adv, TIER1_CAP_BPS).unwrap();
        assert_eq!(cap, 225_000 * SHARE);
    }

    #[test]
    fn cap_is_two_and_a_half_percent_for_tier_two() {
        let adv = 1_000_000 * SHARE;
        let cap = cap_shares(adv, TIER2_CAP_BPS).unwrap();
        assert_eq!(cap, 25_000 * SHARE);
    }

    #[test]
    fn a_halted_symbol_never_trades_however_much_headroom_it_has() {
        let now = 2_000;
        let out = evaluate(TradeCheck {
            now,
            halt: HaltState { halted: true, updated_at: now, max_age_seconds: 120 },
            symbol: symbol(90_000_000 * SHARE),
            trade_shares: SHARE,
        });
        assert_eq!(out.decision, Decision::Reject(Rejection::Halted));
    }

    #[test]
    fn a_stale_halt_feed_fails_closed() {
        let now = 10_000;
        let out = evaluate(TradeCheck {
            now,
            halt: HaltState { halted: false, updated_at: now - 121, max_age_seconds: 120 },
            symbol: symbol(90_000_000 * SHARE),
            trade_shares: SHARE,
        });
        assert_eq!(out.decision, Decision::Reject(Rejection::HaltStateStale));
    }

    #[test]
    fn halt_state_exactly_at_the_age_limit_is_still_good() {
        let now = 10_000;
        let out = evaluate(TradeCheck {
            now,
            halt: HaltState { halted: false, updated_at: now - 120, max_age_seconds: 120 },
            symbol: symbol(90_000_000 * SHARE),
            trade_shares: SHARE,
        });
        assert_eq!(out.decision, Decision::Allow);
    }

    #[test]
    fn a_paused_symbol_is_rejected_until_the_pause_expires() {
        let now = 5_000;
        let mut s = symbol(90_000_000 * SHARE);
        s.paused_until = now + 1;
        assert_eq!(
            evaluate(TradeCheck { now, halt: healthy_halt(now), symbol: s, trade_shares: SHARE })
                .decision,
            Decision::Reject(Rejection::Paused)
        );

        s.paused_until = now;
        assert_eq!(
            evaluate(TradeCheck { now, halt: healthy_halt(now), symbol: s, trade_shares: SHARE })
                .decision,
            Decision::Allow
        );
    }

    #[test]
    fn no_published_adv_means_no_trading() {
        let now = 2_000;
        let out = evaluate(TradeCheck {
            now,
            halt: healthy_halt(now),
            symbol: symbol(0),
            trade_shares: SHARE,
        });
        assert_eq!(out.decision, Decision::Reject(Rejection::AdvUnset));
    }

    #[test]
    fn a_fill_landing_exactly_on_the_cap_is_allowed() {
        let now = 2_000;
        let adv = 100_000 * SHARE;
        let cap = cap_shares(adv, TIER1_CAP_BPS).unwrap(); // 250 shares
        let out = evaluate(TradeCheck {
            now,
            halt: healthy_halt(now),
            symbol: symbol(adv),
            trade_shares: cap,
        });
        assert_eq!(out.decision, Decision::Allow);
        assert_eq!(out.window.window_shares, cap);
    }

    #[test]
    fn the_first_crossing_settles_and_is_recorded() {
        let now = 2_000;
        let adv = 100_000 * SHARE;
        let cap = cap_shares(adv, TIER1_CAP_BPS).unwrap();
        let out = evaluate(TradeCheck {
            now,
            halt: healthy_halt(now),
            symbol: symbol(adv),
            trade_shares: cap + 1,
        });
        assert_eq!(out.decision, Decision::AllowFirstBreach);
        assert_eq!(out.breach_count, 1);
        assert!(out.decision.is_allowed());
    }

    #[test]
    fn a_second_crossing_is_refused_rather_than_allowed_and_punished() {
        let now = 2_000;
        let adv = 100_000 * SHARE;
        let cap = cap_shares(adv, TIER1_CAP_BPS).unwrap();
        let mut s = symbol(adv);
        s.breach_count = 1;
        let out = evaluate(TradeCheck {
            now,
            halt: healthy_halt(now),
            symbol: s,
            trade_shares: cap + 1,
        });
        assert_eq!(out.decision, Decision::Reject(Rejection::CapExceeded));
        // The window must not move when the trade never settles.
        assert_eq!(out.window.window_shares, 0);
    }

    #[test]
    fn a_symbol_with_a_breach_on_record_still_trades_under_its_cap() {
        let now = 2_000;
        let adv = 100_000 * SHARE;
        let mut s = symbol(adv);
        s.breach_count = 1;
        let out = evaluate(TradeCheck {
            now,
            halt: healthy_halt(now),
            symbol: s,
            trade_shares: SHARE,
        });
        assert_eq!(out.decision, Decision::Allow);
    }

    #[test]
    fn volume_accumulates_within_a_window_and_resets_after_it() {
        let adv = 100_000 * SHARE;
        let cap = cap_shares(adv, TIER1_CAP_BPS).unwrap(); // 250 shares
        let mut s = symbol(adv);
        s.window = VolumeWindow { window_start: 1_000, window_shares: cap - SHARE };

        // Still inside the window: one more share fits, two do not.
        let inside = 1_000 + VOLUME_WINDOW_SECONDS - 1;
        assert_eq!(
            evaluate(TradeCheck {
                now: inside,
                halt: healthy_halt(inside),
                symbol: s,
                trade_shares: SHARE
            })
            .decision,
            Decision::Allow
        );
        assert_eq!(
            evaluate(TradeCheck {
                now: inside,
                halt: healthy_halt(inside),
                symbol: s,
                trade_shares: 2 * SHARE
            })
            .decision,
            Decision::AllowFirstBreach
        );

        // The window has rolled: the full cap is available again.
        let after = 1_000 + VOLUME_WINDOW_SECONDS;
        let out = evaluate(TradeCheck {
            now: after,
            halt: healthy_halt(after),
            symbol: s,
            trade_shares: cap,
        });
        assert_eq!(out.decision, Decision::Allow);
        assert_eq!(out.window.window_start, after);
        assert_eq!(out.window.window_shares, cap);
    }

    #[test]
    fn halt_is_checked_before_the_cap() {
        // A symbol that is both halted and over its cap reports the halt, so the
        // venue's disclosure names the binding reason.
        let now = 2_000;
        let adv = 100_000 * SHARE;
        let cap = cap_shares(adv, TIER1_CAP_BPS).unwrap();
        let mut s = symbol(adv);
        s.breach_count = 1;
        let out = evaluate(TradeCheck {
            now,
            halt: HaltState { halted: true, updated_at: now, max_age_seconds: 120 },
            symbol: s,
            trade_shares: cap + 1,
        });
        assert_eq!(out.decision, Decision::Reject(Rejection::Halted));
    }

    #[test]
    fn the_live_multiplier_is_the_one_that_is_in_force() {
        // Mirrors the OpenAI PreStock mint: stored 1.0, new 1.4861347, already
        // active. Reading the stored field understates the trade by 48.61%.
        let stored = 1_000_000_000u64;
        let new = 1_486_134_700u64;
        let activation = 1_752_769_800i64;

        assert_eq!(
            effective_multiplier_e9(stored, new, activation, activation - 1),
            Some(stored)
        );
        assert_eq!(effective_multiplier_e9(stored, new, activation, activation), Some(new));
        assert_eq!(effective_multiplier_e9(0, 0, activation, activation), None);
    }

    #[test]
    fn share_counts_follow_the_effective_multiplier() {
        // 100 tokens at 8 decimals.
        let raw = 100 * 100_000_000u64;
        let naive = raw_to_nano_shares(raw, 8, 1_000_000_000).unwrap();
        let correct = raw_to_nano_shares(raw, 8, 1_486_134_700).unwrap();
        assert_eq!(naive, 100 * SHARE);
        assert_eq!(correct, 148_613_470_000);
        // The gap the venue would misreport to the SEC.
        assert_eq!((correct - naive) * 10_000 / naive, 4_861);
    }

    #[test]
    fn a_zero_multiplier_yields_no_share_count() {
        assert_eq!(raw_to_nano_shares(1_000, 8, 0), None);
    }

    #[test]
    fn a_breach_pause_is_three_months() {
        assert_eq!(pause_until(0), 90 * 24 * 60 * 60);
    }
}
