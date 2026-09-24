#![allow(unexpected_cfgs)]

//! A minimal constant product pool for tokenized equities, in two versions.
//!
//! `swap_unguarded` is what an AMM does today: it settles whenever the curve
//! says it can, with no idea whether the listing exchange halted the stock or
//! how much of the venue's volume cap the fill consumes.
//!
//! `swap_guarded` runs identical curve maths but calls Breaker first, so a halt
//! or a cap breach reverts the whole transaction before any tokens move.
//!
//! The two exist side by side so the difference is demonstrable on chain rather
//! than asserted in a README.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("4EWRfxyMmze3F3e9Lff84PK1W9L7EFGdKa147icdJLxU");

#[program]
pub mod reference_pool {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.base_mint = ctx.accounts.base_mint.key();
        pool.quote_mint = ctx.accounts.quote_mint.key();
        pool.base_vault = ctx.accounts.base_vault.key();
        pool.quote_vault = ctx.accounts.quote_vault.key();
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Seeds the curve. No LP tokens: this pool exists to demonstrate the
    /// guard, not to be a production AMM.
    pub fn add_liquidity<'info>(
        ctx: Context<'info, AddLiquidity<'info>>,
        base_amount: u64,
        quote_amount: u64,
    ) -> Result<()> {
        transfer(
            &ctx.accounts.token_program,
            Deposit {
                from: &ctx.accounts.provider_base,
                mint: &ctx.accounts.base_mint,
                to: &ctx.accounts.base_vault,
                authority: ctx.accounts.provider.to_account_info(),
            },
            base_amount,
            ctx.remaining_accounts,
        )?;
        transfer(
            &ctx.accounts.token_program,
            Deposit {
                from: &ctx.accounts.provider_quote,
                mint: &ctx.accounts.quote_mint,
                to: &ctx.accounts.quote_vault,
                authority: ctx.accounts.provider.to_account_info(),
            },
            quote_amount,
            ctx.remaining_accounts,
        )?;
        Ok(())
    }

    /// Settles with no compliance check, the way a pool behaves today.
    pub fn swap_unguarded<'info>(
        ctx: Context<'info, SwapUnguarded<'info>>,
        base_amount: u64,
    ) -> Result<()> {
        let quote_out = quote_for_base(
            ctx.accounts.base_vault.amount,
            ctx.accounts.quote_vault.amount,
            base_amount,
        )?;
        settle(
            &ctx.accounts.token_program,
            &ctx.accounts.pool,
            SettleAccounts {
                user: ctx.accounts.user.to_account_info(),
                user_base: ctx.accounts.user_base.to_account_info(),
                user_quote: ctx.accounts.user_quote.to_account_info(),
                base_vault: ctx.accounts.base_vault.to_account_info(),
                quote_vault: ctx.accounts.quote_vault.to_account_info(),
                base_mint: &ctx.accounts.base_mint,
                quote_mint: &ctx.accounts.quote_mint,
            },
            base_amount,
            quote_out,
            ctx.remaining_accounts,
        )
    }

    /// Identical maths, but Breaker sees the fill first. A halted symbol, a
    /// stale halt feed, an in force breach pause, or a fill that would cross
    /// the venue's cap all abort the transaction before any transfer happens.
    pub fn swap_guarded<'info>(
        ctx: Context<'info, SwapGuarded<'info>>,
        base_amount: u64,
    ) -> Result<()> {
        let quote_out = quote_for_base(
            ctx.accounts.base_vault.amount,
            ctx.accounts.quote_vault.amount,
            base_amount,
        )?;

        let base_mint_key = ctx.accounts.base_mint.key();
        let quote_mint_key = ctx.accounts.quote_mint.key();
        let seeds: &[&[u8]] = &[
            b"pool",
            base_mint_key.as_ref(),
            quote_mint_key.as_ref(),
            &[ctx.accounts.pool.bump],
        ];

        breaker::cpi::check_and_record(
            CpiContext::new_with_signer(
                ctx.accounts.breaker_program.key(),
                breaker::cpi::accounts::CheckAndRecord {
                    venue: ctx.accounts.venue.to_account_info(),
                    symbol: ctx.accounts.symbol.to_account_info(),
                    halt_state: ctx.accounts.halt_state.to_account_info(),
                    quote_asset: ctx.accounts.quote_asset.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    pool: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            base_amount,
            quote_out,
            SIDE_POOL_BOUGHT_BASE,
        )?;

        settle(
            &ctx.accounts.token_program,
            &ctx.accounts.pool,
            SettleAccounts {
                user: ctx.accounts.user.to_account_info(),
                user_base: ctx.accounts.user_base.to_account_info(),
                user_quote: ctx.accounts.user_quote.to_account_info(),
                base_vault: ctx.accounts.base_vault.to_account_info(),
                quote_vault: ctx.accounts.quote_vault.to_account_info(),
                base_mint: &ctx.accounts.base_mint,
                quote_mint: &ctx.accounts.quote_mint,
            },
            base_amount,
            quote_out,
            ctx.remaining_accounts,
        )
    }
}

/// Breaker's side is from the pool's point of view: 0 when it sold the equity
/// token, 1 when it bought. This swap takes the taker's equity tokens into the
/// vault and pays quote out, so the pool bought and the taker sold.
const SIDE_POOL_BOUGHT_BASE: u8 = 1;

/// Constant product with no fee, so the arithmetic in the proof run is easy to
/// check by hand.
fn quote_for_base(base_reserve: u64, quote_reserve: u64, base_in: u64) -> Result<u64> {
    require!(base_in > 0, PoolError::ZeroAmount);
    require!(
        base_reserve > 0 && quote_reserve > 0,
        PoolError::EmptyReserves
    );
    let out = (quote_reserve as u128)
        .checked_mul(base_in as u128)
        .and_then(|n| n.checked_div((base_reserve as u128).checked_add(base_in as u128)?))
        .ok_or(error!(PoolError::MathOverflow))?;
    let out = u64::try_from(out).map_err(|_| error!(PoolError::MathOverflow))?;
    require!(out > 0, PoolError::ZeroAmount);
    Ok(out)
}

struct SettleAccounts<'a, 'info> {
    user: AccountInfo<'info>,
    user_base: AccountInfo<'info>,
    user_quote: AccountInfo<'info>,
    base_vault: AccountInfo<'info>,
    quote_vault: AccountInfo<'info>,
    base_mint: &'a InterfaceAccount<'info, Mint>,
    quote_mint: &'a InterfaceAccount<'info, Mint>,
}

fn settle<'info>(
    token_program: &Interface<'info, TokenInterface>,
    pool: &Account<'info, Pool>,
    accounts: SettleAccounts<'_, 'info>,
    base_amount: u64,
    quote_out: u64,
    remaining: &[AccountInfo<'info>],
) -> Result<()> {
    // Taker pays the base token in.
    let cpi = CpiContext::new(
        token_program.key(),
        TransferChecked {
            from: accounts.user_base,
            mint: accounts.base_mint.to_account_info(),
            to: accounts.base_vault,
            authority: accounts.user,
        },
    )
    .with_remaining_accounts(remaining.to_vec());
    token_interface::transfer_checked(cpi, base_amount, accounts.base_mint.decimals)?;

    // Pool pays the quote token out.
    let base_mint_key = pool.base_mint;
    let quote_mint_key = pool.quote_mint;
    let seeds: &[&[u8]] = &[
        b"pool",
        base_mint_key.as_ref(),
        quote_mint_key.as_ref(),
        &[pool.bump],
    ];
    let signer_seeds = [seeds];
    let cpi = CpiContext::new_with_signer(
        token_program.key(),
        TransferChecked {
            from: accounts.quote_vault,
            mint: accounts.quote_mint.to_account_info(),
            to: accounts.user_quote,
            authority: pool.to_account_info(),
        },
        &signer_seeds,
    )
    .with_remaining_accounts(remaining.to_vec());
    token_interface::transfer_checked(cpi, quote_out, accounts.quote_mint.decimals)?;

    Ok(())
}

struct Deposit<'a, 'info> {
    from: &'a InterfaceAccount<'info, TokenAccount>,
    mint: &'a InterfaceAccount<'info, Mint>,
    to: &'a InterfaceAccount<'info, TokenAccount>,
    authority: AccountInfo<'info>,
}

fn transfer<'info>(
    token_program: &Interface<'info, TokenInterface>,
    deposit: Deposit<'_, 'info>,
    amount: u64,
    remaining: &[AccountInfo<'info>],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let cpi = CpiContext::new(
        token_program.key(),
        TransferChecked {
            from: deposit.from.to_account_info(),
            mint: deposit.mint.to_account_info(),
            to: deposit.to.to_account_info(),
            authority: deposit.authority,
        },
    )
    .with_remaining_accounts(remaining.to_vec());
    token_interface::transfer_checked(cpi, amount, deposit.mint.decimals)
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    pub base_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = base_mint, token::authority = pool)]
    pub base_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(token::mint = quote_mint, token::authority = pool)]
    pub quote_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(seeds = [b"pool", base_mint.key().as_ref(), quote_mint.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    pub base_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = pool.base_vault)]
    pub base_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.quote_vault)]
    pub quote_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub provider_base: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub provider_quote: InterfaceAccount<'info, TokenAccount>,
    pub provider: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SwapUnguarded<'info> {
    #[account(seeds = [b"pool", base_mint.key().as_ref(), quote_mint.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    pub base_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = pool.base_vault)]
    pub base_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.quote_vault)]
    pub quote_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user_base: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user_quote: InterfaceAccount<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SwapGuarded<'info> {
    #[account(seeds = [b"pool", base_mint.key().as_ref(), quote_mint.key().as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    pub base_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = pool.base_vault)]
    pub base_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.quote_vault)]
    pub quote_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user_base: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user_quote: InterfaceAccount<'info, TokenAccount>,
    pub user: Signer<'info>,

    /// CHECK: validated by the Breaker program it is passed to.
    pub venue: UncheckedAccount<'info>,
    /// CHECK: validated by the Breaker program it is passed to.
    #[account(mut)]
    pub symbol: UncheckedAccount<'info>,
    /// CHECK: validated by the Breaker program it is passed to.
    pub halt_state: UncheckedAccount<'info>,
    /// CHECK: validated by the Breaker program it is passed to.
    pub quote_asset: UncheckedAccount<'info>,
    pub breaker_program: Program<'info, breaker::program::Breaker>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum PoolError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Pool has no reserves")]
    EmptyReserves,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
