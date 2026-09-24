//! Reads the Token-2022 state a venue needs in order to account for a trade
//! correctly.
//!
//! Two extensions matter here. `ScaledUiAmount` decides how many shares a raw
//! token amount actually represents, and it carries two multipliers with an
//! activation timestamp, so the live value is frequently not the one in the
//! obvious field. `Pausable` is a second halt vector the issuer controls
//! directly, independent of the listing exchange.

use anchor_lang::prelude::*;
use spl_token_2022_interface::{
    extension::{
        pausable::PausableConfig, scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensions,
        PodStateWithExtensions,
    },
    pod::PodMint,
};

use crate::BreakerError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MintFacts {
    pub decimals: u8,
    pub multiplier_e9: u64,
    pub new_multiplier_e9: u64,
    pub activation_timestamp: i64,
    pub issuer_paused: bool,
}

/// Token-2022 stores the Scaled UI Amount multipliers as f64. A venue's share
/// accounting has to be integral, so they are converted to a 1e9 fixed point
/// value. Anything non finite, negative or zero is rejected rather than
/// coerced, because a bad multiplier means the share count behind a trade is
/// unknowable.
fn multiplier_to_e9(value: f64) -> Option<u64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let scaled = (value * 1_000_000_000f64).round();
    if !scaled.is_finite() || scaled <= 0.0 || scaled > u64::MAX as f64 {
        return None;
    }
    Some(scaled as u64)
}

pub fn read_mint(account: &UncheckedAccount<'_>, token_program: &Pubkey) -> Result<MintFacts> {
    require_keys_eq!(*account.owner, *token_program, BreakerError::MintOwnerMismatch);

    let data = account.try_borrow_data()?;
    let state = PodStateWithExtensions::<PodMint>::unpack(&data)
        .map_err(|_| error!(BreakerError::MintUnreadable))?;

    let scaled = state
        .get_extension::<ScaledUiAmountConfig>()
        .map_err(|_| error!(BreakerError::ScaledUiAmountMissing))?;

    let multiplier: f64 = scaled.multiplier.into();
    let new_multiplier: f64 = scaled.new_multiplier.into();
    let multiplier_e9 =
        multiplier_to_e9(multiplier).ok_or(error!(BreakerError::MultiplierInvalid))?;
    let new_multiplier_e9 =
        multiplier_to_e9(new_multiplier).ok_or(error!(BreakerError::MultiplierInvalid))?;
    let activation_timestamp: i64 = scaled.new_multiplier_effective_timestamp.into();

    // A mint without the Pausable extension simply cannot be issuer paused.
    let issuer_paused = state
        .get_extension::<PausableConfig>()
        .map(|c| bool::from(c.paused))
        .unwrap_or(false);

    Ok(MintFacts {
        decimals: state.base.decimals,
        multiplier_e9,
        new_multiplier_e9,
        activation_timestamp,
        issuer_paused,
    })
}
