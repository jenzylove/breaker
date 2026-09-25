#![allow(unexpected_cfgs)]

//! Breaker: a trade time compliance guard for tokenized equity venues.
//!
//! The SEC's Innovation Exemption (effective 2026-09-17, expiring 2031-09-17)
//! lets tokenized NMS stocks trade through AMM pools on public permissionless
//! chains, on conditions no AMM currently enforces. A pool does not know that
//! the listing exchange halted the stock, does not know what 0.25% of last
//! month's average daily volume is, and emits raw token amounts rather than the
//! dollar denominated tape the order requires within ten minutes of every fill.
//!
//! A venue calls `check_and_record` before it settles. The call reverts the
//! parent transaction when the symbol is halted or when the fill would breach
//! the venue's cap, and otherwise emits the tape entry.

use anchor_lang::prelude::*;
use breaker_core::{
    cap_shares, effective_multiplier_e9, evaluate, pause_until, raw_to_nano_shares, Decision,
    HaltState as CoreHalt, Rejection, SymbolState, Tier, TradeCheck, VolumeWindow,
    DEFAULT_HALT_MAX_AGE_SECONDS,
};

mod mint;
use mint::read_mint;

declare_id!("EdTGUwJPq5RNy4RjLRzKYbajtkDzaim3MYiPi8yB9obe");

/// Token-2022. Tokenized equities on Solana use it for the extensions the
/// order's permissioning condition relies on.
pub const TOKEN_2022_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Tape amounts are USD micros (1e6), which holds a trillion dollars in a u64.
pub const USD_SCALE: u128 = 1_000_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteKind {
    /// A dollar stablecoin. The executed quote amount is already the dollar
    /// value of the trade, so the tape reports what settled rather than a mark.
    UsdStable,
    /// A non dollar quote asset such as wrapped SOL. Producing a dollar tape
    /// requires converting it, which is what the Pyth feed is for.
    PythPriced,
}

#[program]
pub mod breaker {
    use super::*;

    /// Creates a venue. The operator nominates the two attested publishers the
    /// order's conditions depend on: a halt feed mirroring the listing
    /// exchanges, and an average daily volume feed. Both are disclosed as
    /// trusted roles because both originate off chain.
    pub fn initialize_venue(
        ctx: Context<InitializeVenue>,
        halt_publisher: Pubkey,
        adv_publisher: Pubkey,
    ) -> Result<()> {
        let venue = &mut ctx.accounts.venue;
        venue.authority = ctx.accounts.authority.key();
        venue.halt_publisher = halt_publisher;
        venue.adv_publisher = adv_publisher;
        venue.tier1_count = 0;
        venue.tier2_count = 0;
        venue.paused = false;
        venue.bump = ctx.bumps.venue;
        Ok(())
    }

    /// Lists a symbol, enforcing the order's ceiling of 75 Tier 1 and 250
    /// Tier 2 symbols per venue.
    pub fn list_symbol(ctx: Context<ListSymbol>, ticker: [u8; 8], tier: u8) -> Result<()> {
        let parsed = Tier::from_u8(tier).ok_or(error!(BreakerError::InvalidTier))?;
        let venue = &mut ctx.accounts.venue;

        match parsed {
            Tier::One => {
                require!(
                    venue.tier1_count < Tier::One.max_symbols(),
                    BreakerError::TierSymbolLimitReached
                );
                venue.tier1_count += 1;
            }
            Tier::Two => {
                require!(
                    venue.tier2_count < Tier::Two.max_symbols(),
                    BreakerError::TierSymbolLimitReached
                );
                venue.tier2_count += 1;
            }
        }

        // Proves the mint is a Token-2022 equity token with a readable
        // multiplier before the venue can list it at all.
        let facts = read_mint(&ctx.accounts.mint, &TOKEN_2022_ID)?;

        let symbol = &mut ctx.accounts.symbol;
        symbol.venue = venue.key();
        symbol.mint = ctx.accounts.mint.key();
        symbol.ticker = ticker;
        symbol.tier = tier;
        symbol.decimals = facts.decimals;
        symbol.adv_shares = 0;
        symbol.adv_updated_at = 0;
        symbol.window_start = 0;
        symbol.window_shares = 0;
        symbol.breach_count = 0;
        symbol.paused_until = 0;
        symbol.bump = ctx.bumps.symbol;

        let halt = &mut ctx.accounts.halt_state;
        halt.venue = venue.key();
        halt.symbol = symbol.key();
        // A freshly listed symbol is halted until the publisher says otherwise.
        // Nothing trades on an unproven halt state.
        halt.halted = true;
        halt.updated_at = Clock::get()?.unix_timestamp;
        halt.max_age_seconds = DEFAULT_HALT_MAX_AGE_SECONDS;
        halt.bump = ctx.bumps.halt_state;

        Ok(())
    }

    /// Registers an asset a pool may quote in. A dollar stablecoin needs no
    /// oracle because the fill is already denominated in dollars.
    pub fn register_quote_asset(
        ctx: Context<RegisterQuoteAsset>,
        decimals: u8,
        kind: QuoteKind,
        pyth_feed_id: [u8; 32],
    ) -> Result<()> {
        require!(decimals <= 18, BreakerError::InvalidQuoteDecimals);
        if matches!(kind, QuoteKind::PythPriced) {
            require!(pyth_feed_id != [0u8; 32], BreakerError::PythFeedRequired);
        }
        let quote = &mut ctx.accounts.quote_asset;
        quote.venue = ctx.accounts.venue.key();
        quote.mint = ctx.accounts.quote_mint.key();
        quote.decimals = decimals;
        quote.kind = kind;
        quote.pyth_feed_id = pyth_feed_id;
        quote.bump = ctx.bumps.quote_asset;
        Ok(())
    }

    /// Publishes the prior month's average daily share volume, in nano-shares.
    /// The cap is meaningless without it, so a symbol cannot trade until it is
    /// set.
    pub fn update_adv(ctx: Context<UpdateAdv>, adv_shares: u64) -> Result<()> {
        require!(adv_shares > 0, BreakerError::InvalidAdv);
        let symbol = &mut ctx.accounts.symbol;
        symbol.adv_shares = adv_shares;
        symbol.adv_updated_at = Clock::get()?.unix_timestamp;
        emit!(AdvPublished {
            venue: symbol.venue,
            symbol: symbol.key(),
            ticker: symbol.ticker,
            adv_shares,
            cap_shares: cap_shares(adv_shares, tier_of(symbol)?.cap_bps()).unwrap_or(0),
            timestamp: symbol.adv_updated_at,
        });
        Ok(())
    }

    /// Mirrors the listing exchange. The publisher must refresh this inside the
    /// symbol's `max_age_seconds` or trading fails closed on staleness alone.
    pub fn set_halt(ctx: Context<SetHalt>, halted: bool) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let halt = &mut ctx.accounts.halt_state;
        halt.halted = halted;
        halt.updated_at = now;
        emit!(HaltChanged {
            venue: halt.venue,
            symbol: halt.symbol,
            halted,
            timestamp: now,
        });
        Ok(())
    }

    /// Tightens or loosens how long a halt state stays trustworthy. Capped so a
    /// venue cannot disable the staleness check by setting a year.
    pub fn set_halt_max_age(ctx: Context<SetHaltMaxAge>, max_age_seconds: i64) -> Result<()> {
        require!(
            (1..=3_600).contains(&max_age_seconds),
            BreakerError::InvalidHaltMaxAge
        );
        ctx.accounts.halt_state.max_age_seconds = max_age_seconds;
        Ok(())
    }

    /// The enforcement path. A pool calls this before it settles a fill.
    ///
    /// `base_raw_amount` is the equity token amount in the mint's base units.
    /// `quote_raw_amount` is what moved on the other side. `side` is 0 when the
    /// pool sold the equity token to the taker and 1 when it bought.
    pub fn check_and_record(
        ctx: Context<CheckAndRecord>,
        base_raw_amount: u64,
        quote_raw_amount: u64,
        side: u8,
    ) -> Result<()> {
        require!(side <= 1, BreakerError::InvalidSide);
        require!(base_raw_amount > 0, BreakerError::ZeroSizeTrade);
        require!(!ctx.accounts.venue.paused, BreakerError::VenuePaused);

        let now = Clock::get()?.unix_timestamp;
        let facts = read_mint(&ctx.accounts.mint, &TOKEN_2022_ID)?;

        // The issuer's own pause is a halt the listing exchange never sees.
        require!(!facts.issuer_paused, BreakerError::IssuerPaused);

        // Which multiplier is actually in force decides the share count, and
        // the share count is what the cap is measured in.
        let multiplier_e9 = effective_multiplier_e9(
            facts.multiplier_e9,
            facts.new_multiplier_e9,
            facts.activation_timestamp,
            now,
        )
        .ok_or(error!(BreakerError::MultiplierInvalid))?;

        let shares_nano = raw_to_nano_shares(base_raw_amount, facts.decimals, multiplier_e9)
            .ok_or(error!(BreakerError::ShareConversionOverflow))?;
        require!(shares_nano > 0, BreakerError::ZeroSizeTrade);

        let symbol = &ctx.accounts.symbol;
        let halt = &ctx.accounts.halt_state;
        let tier = tier_of(symbol)?;

        let outcome = evaluate(TradeCheck {
            now,
            halt: CoreHalt {
                halted: halt.halted,
                updated_at: halt.updated_at,
                max_age_seconds: halt.max_age_seconds,
            },
            symbol: SymbolState {
                tier,
                adv_shares: symbol.adv_shares,
                window: VolumeWindow {
                    window_start: symbol.window_start,
                    window_shares: symbol.window_shares,
                },
                breach_count: symbol.breach_count,
                paused_until: symbol.paused_until,
            },
            trade_shares: shares_nano,
        });

        let first_breach = match outcome.decision {
            Decision::Allow => false,
            Decision::AllowFirstBreach => true,
            Decision::Reject(reason) => return Err(rejection_to_error(reason)),
        };

        // Dollar value of what actually settled, for the public tape.
        let usd_notional_micros = usd_notional(
            &ctx.accounts.quote_asset,
            quote_raw_amount,
        )?;
        let price_usd_micros = u64::try_from(
            (usd_notional_micros as u128)
                .checked_mul(breaker_core::SHARE_SCALE)
                .and_then(|v| v.checked_div(shares_nano as u128))
                .ok_or(error!(BreakerError::ShareConversionOverflow))?,
        )
        .map_err(|_| error!(BreakerError::ShareConversionOverflow))?;

        let symbol = &mut ctx.accounts.symbol;
        symbol.window_start = outcome.window.window_start;
        symbol.window_shares = outcome.window.window_shares;
        symbol.breach_count = outcome.breach_count;

        emit!(TradeRecorded {
            venue: symbol.venue,
            symbol: symbol.key(),
            ticker: symbol.ticker,
            mint: symbol.mint,
            pool: ctx.accounts.pool.key(),
            side,
            shares_nano,
            base_raw_amount,
            quote_raw_amount,
            quote_mint: ctx.accounts.quote_asset.mint,
            usd_notional_micros,
            price_usd_micros,
            multiplier_e9,
            cap_shares: outcome.cap_shares,
            window_shares: outcome.window.window_shares,
            first_breach,
            timestamp: now,
        });

        if first_breach {
            emit!(CapBreached {
                venue: symbol.venue,
                symbol: symbol.key(),
                ticker: symbol.ticker,
                window_shares: outcome.window.window_shares,
                cap_shares: outcome.cap_shares,
                breach_count: symbol.breach_count,
                timestamp: now,
            });
        }

        Ok(())
    }

    /// Applies the order's three month pause. Used when a breach happened
    /// somewhere this program cannot observe, such as an affiliated venue whose
    /// volume aggregates with this one.
    pub fn report_breach(ctx: Context<ReportBreach>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let symbol = &mut ctx.accounts.symbol;
        symbol.breach_count = symbol.breach_count.saturating_add(1);
        symbol.paused_until = pause_until(now);
        emit!(SymbolPaused {
            venue: symbol.venue,
            symbol: symbol.key(),
            ticker: symbol.ticker,
            paused_until: symbol.paused_until,
            breach_count: symbol.breach_count,
            timestamp: now,
        });
        Ok(())
    }

    /// Venue wide kill switch.
    pub fn set_venue_paused(ctx: Context<SetVenuePaused>, paused: bool) -> Result<()> {
        ctx.accounts.venue.paused = paused;
        Ok(())
    }

    /// Names a pool that may call `check_and_record` for this venue.
    ///
    /// Signing alone is not enough: without an approval any account could sign
    /// as a "pool", write trades into the record and use up a stock's daily
    /// limit so real trades get refused. A venue approves the program derived
    /// address its pool program signs with, so a record can only come from
    /// inside that program's swap, in the same transaction that settles it.
    pub fn approve_pool(ctx: Context<ApprovePool>, pool: Pubkey) -> Result<()> {
        let approved = &mut ctx.accounts.approved_pool;
        approved.venue = ctx.accounts.venue.key();
        approved.pool = pool;
        approved.bump = ctx.bumps.approved_pool;
        emit!(PoolApproval {
            venue: approved.venue,
            pool,
            approved: true,
        });
        Ok(())
    }

    /// Withdraws a pool's approval. Its next call to `check_and_record` fails.
    pub fn revoke_pool(ctx: Context<RevokePool>) -> Result<()> {
        emit!(PoolApproval {
            venue: ctx.accounts.venue.key(),
            pool: ctx.accounts.approved_pool.pool,
            approved: false,
        });
        Ok(())
    }
}

fn tier_of(symbol: &Account<Symbol>) -> Result<Tier> {
    Tier::from_u8(symbol.tier).ok_or(error!(BreakerError::InvalidTier))
}

/// Converts what settled on the quote side into USD micros.
fn usd_notional(quote: &Account<QuoteAsset>, quote_raw_amount: u64) -> Result<u64> {
    match quote.kind {
        QuoteKind::UsdStable => {
            let amount = quote_raw_amount as u128;
            let scaled = if (quote.decimals as u128) >= 6 {
                let div = 10u128
                    .checked_pow(quote.decimals as u32 - 6)
                    .ok_or(error!(BreakerError::ShareConversionOverflow))?;
                amount / div
            } else {
                let mul = 10u128
                    .checked_pow(6 - quote.decimals as u32)
                    .ok_or(error!(BreakerError::ShareConversionOverflow))?;
                amount
                    .checked_mul(mul)
                    .ok_or(error!(BreakerError::ShareConversionOverflow))?
            };
            u64::try_from(scaled).map_err(|_| error!(BreakerError::ShareConversionOverflow))
        }
        // Not implemented. Converting a non dollar quote asset would need the
        // Pyth feed named on the quote asset account; until that exists a trade
        // against one is refused rather than recorded at a guessed dollar
        // value, so a venue must quote in a dollar stablecoin.
        QuoteKind::PythPriced => Err(error!(BreakerError::QuotePricingUnavailable)),
    }
}

fn rejection_to_error(reason: Rejection) -> Error {
    match reason {
        Rejection::Halted => error!(BreakerError::SymbolHalted),
        Rejection::HaltStateStale => error!(BreakerError::HaltStateStale),
        Rejection::Paused => error!(BreakerError::SymbolPausedForBreach),
        Rejection::CapExceeded => error!(BreakerError::VolumeCapExceeded),
        Rejection::AdvUnset => error!(BreakerError::AdvUnset),
        Rejection::MultiplierInvalid => error!(BreakerError::MultiplierInvalid),
        Rejection::Overflow => error!(BreakerError::ShareConversionOverflow),
    }
}

// ---------------------------------------------------------------- accounts

#[account]
#[derive(InitSpace)]
pub struct Venue {
    pub authority: Pubkey,
    pub halt_publisher: Pubkey,
    pub adv_publisher: Pubkey,
    pub tier1_count: u16,
    pub tier2_count: u16,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Symbol {
    pub venue: Pubkey,
    pub mint: Pubkey,
    pub ticker: [u8; 8],
    pub tier: u8,
    pub decimals: u8,
    pub adv_shares: u64,
    pub adv_updated_at: i64,
    pub window_start: i64,
    pub window_shares: u64,
    pub breach_count: u16,
    pub paused_until: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct HaltState {
    pub venue: Pubkey,
    pub symbol: Pubkey,
    pub halted: bool,
    pub updated_at: i64,
    pub max_age_seconds: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct QuoteAsset {
    pub venue: Pubkey,
    pub mint: Pubkey,
    pub decimals: u8,
    pub kind: QuoteKind,
    pub pyth_feed_id: [u8; 32],
    pub bump: u8,
}

/// A venue's approval for one pool to call `check_and_record`.
#[account]
#[derive(InitSpace)]
pub struct ApprovedPool {
    pub venue: Pubkey,
    pub pool: Pubkey,
    pub bump: u8,
}

impl anchor_lang::Space for QuoteKind {
    const INIT_SPACE: usize = 1 + 1;
}

// ------------------------------------------------------------- instructions

#[derive(Accounts)]
pub struct InitializeVenue<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Venue::INIT_SPACE,
        seeds = [b"venue", authority.key().as_ref()],
        bump
    )]
    pub venue: Account<'info, Venue>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ListSymbol<'info> {
    #[account(mut, has_one = authority, seeds = [b"venue", authority.key().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, Venue>,
    #[account(
        init,
        payer = authority,
        space = 8 + Symbol::INIT_SPACE,
        seeds = [b"symbol", venue.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub symbol: Account<'info, Symbol>,
    #[account(
        init,
        payer = authority,
        space = 8 + HaltState::INIT_SPACE,
        seeds = [b"halt", symbol.key().as_ref()],
        bump
    )]
    pub halt_state: Account<'info, HaltState>,
    /// CHECK: ownership and extension layout are validated by read_mint.
    pub mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterQuoteAsset<'info> {
    #[account(has_one = authority, seeds = [b"venue", authority.key().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, Venue>,
    #[account(
        init,
        payer = authority,
        space = 8 + QuoteAsset::INIT_SPACE,
        seeds = [b"quote", venue.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub quote_asset: Account<'info, QuoteAsset>,
    /// CHECK: recorded as the quote mint; its decimals are supplied by the venue.
    pub quote_mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAdv<'info> {
    #[account(seeds = [b"venue", venue.authority.as_ref()], bump = venue.bump)]
    pub venue: Account<'info, Venue>,
    #[account(mut, has_one = venue)]
    pub symbol: Account<'info, Symbol>,
    #[account(address = venue.adv_publisher @ BreakerError::UnauthorizedPublisher)]
    pub adv_publisher: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetHalt<'info> {
    #[account(seeds = [b"venue", venue.authority.as_ref()], bump = venue.bump)]
    pub venue: Account<'info, Venue>,
    #[account(mut, has_one = venue, seeds = [b"halt", halt_state.symbol.as_ref()], bump = halt_state.bump)]
    pub halt_state: Account<'info, HaltState>,
    #[account(address = venue.halt_publisher @ BreakerError::UnauthorizedPublisher)]
    pub halt_publisher: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetHaltMaxAge<'info> {
    #[account(has_one = authority, seeds = [b"venue", authority.key().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, Venue>,
    #[account(mut, has_one = venue)]
    pub halt_state: Account<'info, HaltState>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CheckAndRecord<'info> {
    pub venue: Account<'info, Venue>,
    #[account(mut, has_one = venue, has_one = mint)]
    pub symbol: Account<'info, Symbol>,
    #[account(has_one = venue, seeds = [b"halt", symbol.key().as_ref()], bump = halt_state.bump)]
    pub halt_state: Account<'info, HaltState>,
    #[account(has_one = venue, seeds = [b"quote", venue.key().as_ref(), quote_asset.mint.as_ref()], bump = quote_asset.bump)]
    pub quote_asset: Account<'info, QuoteAsset>,
    /// CHECK: ownership and extension layout are validated by read_mint.
    pub mint: UncheckedAccount<'info>,
    /// The pool settling the fill. It signs so a tape entry cannot be forged on
    /// another pool's behalf.
    pub pool: Signer<'info>,
    /// The venue's approval for that pool. An unapproved signer cannot record
    /// trades or consume the daily limit.
    #[account(
        has_one = venue,
        constraint = approved_pool.pool == pool.key() @ BreakerError::PoolNotApproved,
        seeds = [b"approved", venue.key().as_ref(), pool.key().as_ref()],
        bump = approved_pool.bump
    )]
    pub approved_pool: Account<'info, ApprovedPool>,
}

#[derive(Accounts)]
pub struct ReportBreach<'info> {
    #[account(has_one = authority, seeds = [b"venue", authority.key().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, Venue>,
    #[account(mut, has_one = venue)]
    pub symbol: Account<'info, Symbol>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetVenuePaused<'info> {
    #[account(mut, has_one = authority, seeds = [b"venue", authority.key().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, Venue>,
    pub authority: Signer<'info>,
}

// ------------------------------------------------------------------ events

/// One entry of the dollar denominated tape the order requires to be public
/// within ten minutes of every fill.
#[derive(Accounts)]
#[instruction(pool: Pubkey)]
pub struct ApprovePool<'info> {
    #[account(has_one = authority, seeds = [b"venue", authority.key().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, Venue>,
    #[account(
        init,
        payer = authority,
        space = 8 + ApprovedPool::INIT_SPACE,
        seeds = [b"approved", venue.key().as_ref(), pool.as_ref()],
        bump
    )]
    pub approved_pool: Account<'info, ApprovedPool>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokePool<'info> {
    #[account(has_one = authority, seeds = [b"venue", authority.key().as_ref()], bump = venue.bump)]
    pub venue: Account<'info, Venue>,
    #[account(mut, close = authority, has_one = venue)]
    pub approved_pool: Account<'info, ApprovedPool>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[event]
pub struct PoolApproval {
    pub venue: Pubkey,
    pub pool: Pubkey,
    pub approved: bool,
}

#[event]
pub struct TradeRecorded {
    pub venue: Pubkey,
    pub symbol: Pubkey,
    pub ticker: [u8; 8],
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub quote_mint: Pubkey,
    pub side: u8,
    pub shares_nano: u64,
    pub base_raw_amount: u64,
    pub quote_raw_amount: u64,
    pub usd_notional_micros: u64,
    pub price_usd_micros: u64,
    pub multiplier_e9: u64,
    pub cap_shares: u64,
    pub window_shares: u64,
    pub first_breach: bool,
    pub timestamp: i64,
}

#[event]
pub struct CapBreached {
    pub venue: Pubkey,
    pub symbol: Pubkey,
    pub ticker: [u8; 8],
    pub window_shares: u64,
    pub cap_shares: u64,
    pub breach_count: u16,
    pub timestamp: i64,
}

#[event]
pub struct SymbolPaused {
    pub venue: Pubkey,
    pub symbol: Pubkey,
    pub ticker: [u8; 8],
    pub paused_until: i64,
    pub breach_count: u16,
    pub timestamp: i64,
}

#[event]
pub struct HaltChanged {
    pub venue: Pubkey,
    pub symbol: Pubkey,
    pub halted: bool,
    pub timestamp: i64,
}

#[event]
pub struct AdvPublished {
    pub venue: Pubkey,
    pub symbol: Pubkey,
    pub ticker: [u8; 8],
    pub adv_shares: u64,
    pub cap_shares: u64,
    pub timestamp: i64,
}

// ------------------------------------------------------------------ errors

#[error_code]
pub enum BreakerError {
    #[msg("Trading in this symbol is halted on its primary listing exchange")]
    SymbolHalted,
    #[msg("Halt state is stale, so the venue cannot prove it mirrors the listing exchange")]
    HaltStateStale,
    #[msg("Symbol is inside a three month pause from an earlier cap breach")]
    SymbolPausedForBreach,
    #[msg("Trade would exceed the venue's share volume cap for this symbol")]
    VolumeCapExceeded,
    #[msg("No prior month average daily volume has been published for this symbol")]
    AdvUnset,
    #[msg("Mint is not owned by the Token-2022 program")]
    MintOwnerMismatch,
    #[msg("Mint account could not be decoded")]
    MintUnreadable,
    #[msg("Mint has no Scaled UI Amount extension")]
    ScaledUiAmountMissing,
    #[msg("Mint multiplier is unusable, so the share count behind this trade is unknown")]
    MultiplierInvalid,
    #[msg("Issuer has paused this mint")]
    IssuerPaused,
    #[msg("Share conversion overflowed")]
    ShareConversionOverflow,
    #[msg("Venue is paused")]
    VenuePaused,
    #[msg("Invalid tier, expected 1 or 2")]
    InvalidTier,
    #[msg("Venue has reached the symbol limit for this tier")]
    TierSymbolLimitReached,
    #[msg("Signer is not the publisher nominated for this venue")]
    UnauthorizedPublisher,
    #[msg("Average daily volume must be greater than zero")]
    InvalidAdv,
    #[msg("Halt max age must be between 1 and 3600 seconds")]
    InvalidHaltMaxAge,
    #[msg("Side must be 0 or 1")]
    InvalidSide,
    #[msg("Trade size resolves to zero shares")]
    ZeroSizeTrade,
    #[msg("Quote asset decimals are out of range")]
    InvalidQuoteDecimals,
    #[msg("A Pyth priced quote asset requires a feed id")]
    PythFeedRequired,
    #[msg("This quote asset cannot be denominated in dollars yet")]
    QuotePricingUnavailable,
    #[msg("This pool is not approved by the venue")]
    PoolNotApproved,
}
