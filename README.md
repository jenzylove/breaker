# Breaker

**A trade time compliance guard for tokenized equity venues on Solana.**

On 17 September 2026 the SEC issued an order granting temporary conditional exemptive relief under
Section 36(a)(1) of the Exchange Act. For the first time, tokenized NMS stocks may trade through AMM
liquidity pools on public permissionless blockchains, under a five year exemption from the definition
of "exchange".

It comes with conditions. Three of them are things no AMM does.

A pool does not know that Nasdaq halted a stock, because the entire premise of an automated market
maker is that it never closes. A pool does not know what 0.25% of last month's average daily volume
is, or how much of it today's trading has already consumed. And a pool emits raw token amounts, not
the dollar denominated tape the order requires to be public within ten minutes of every fill.

Breaker is the call a venue makes before it settles.

| | |
|---|---|
| Live site | https://breaker-one.vercel.app |
| Breaker program (devnet) | [`EdTGUwJPq5RNy4RjLRzKYbajtkDzaim3MYiPi8yB9obe`](https://explorer.solana.com/address/EdTGUwJPq5RNy4RjLRzKYbajtkDzaim3MYiPi8yB9obe?cluster=devnet) |
| Reference pool (devnet) | [`4EWRfxyMmze3F3e9Lff84PK1W9L7EFGdKa147icdJLxU`](https://explorer.solana.com/address/4EWRfxyMmze3F3e9Lff84PK1W9L7EFGdKa147icdJLxU?cluster=devnet) |
| Public tape | `/api/tape` |

---

## What the order requires, and what Breaker does about it

**1. Stop when the exchange stops.** A venue must halt a tokenized stock concurrently with any halt
or suspension of the underlying on its primary listing exchange.

`check_and_record` reads a halt account published by the venue's nominated halt publisher and reverts
the parent transaction if the symbol is halted. It also reverts if that feed has gone stale, because
a venue that cannot prove it is mirroring the listing exchange does not get to keep trading on the
assumption that it is. The program defaults to a 120 second tolerance and caps any venue's tolerance
at one hour, so the check cannot be configured away.

The issuer's own Token-2022 pause is treated as a halt too. It is a stoppage the listing exchange
never sees, and a venue that only mirrors Nasdaq would keep trading a token the issuer had frozen.

**2. Stay under the volume cap.** Tier 1 symbols are capped at 0.25% of the prior month's average
daily share volume, Tier 2 at 2.5%. A venue may list at most 75 Tier 1 and 250 Tier 2 symbols. The
first exceedance requires no action; any later one forces an immediate three month pause in that
symbol.

The program tracks a rolling 24 hour share volume window per symbol against a published ADV figure.
The first crossing settles and is recorded, exactly as the order allows. **Every crossing after that
is refused rather than allowed and then punished** — a venue that can prevent a second breach should
never incur one. `report_breach` still applies the three month pause for breaches that happened at an
affiliated venue this program cannot observe.

**3. Publish the dollar tape.** Transaction data must be freely and publicly available in machine
readable form within ten minutes of every fill, carrying symbol, price, size, UTC timestamp,
direction and pool details.

Every settled fill emits a `TradeRecorded` event. `/api/tape` rebuilds those rows from chain logs on
every request, so the tape is current to the last confirmed slot rather than to whenever an indexer
last ran. Nothing in it is privileged: the same rows can be reconstructed by anyone reading the
program's logs, which is what makes the tape verifiable rather than merely published.

The order's fourth condition, permissioned access, is already solved at the token level by Solana's
token extensions. Breaker checks it rather than claiming it.

---

## The share count problem

The cap is denominated in **shares**. The tape is denominated in **dollars**. Neither is the raw
token amount a pool moves.

Tokenized equities use the Token-2022 Scaled UI Amount extension, which carries *two* multipliers and
an activation timestamp. Once that timestamp passes, the live multiplier is the one that is **not**
in the obvious field. This is not hypothetical — it is the live state of real mints today.

The devnet run activates exactly that condition mid flight:

```
stored multiplier     1.0
effective multiplier  1.4861347
understatement if the stored field is read   48.61%
```

A venue reading the obvious field would have understated every fill by 48.61%, breaching its own
regulatory volume cap without knowing and filing a dollar tape that was wrong by the same margin.

---

## Proof on devnet

Every transaction below is openable. The reverts landed on chain rather than being rejected at
preflight, because a revert that only ever existed in a simulation proves nothing.

### Same pool, same curve, one call apart

While TSLAx was halted on its listing exchange, the same swap ran twice against the same reference
pool.

| | Result | |
|---|---|---|
| `swap_unguarded` | **Settled $29,120.56** against a halted stock | [tx](https://explorer.solana.com/tx/3QhzEjBNTz55YebUragBMYrchQWkRoZuf6ZvqZe5BCoQrPshU1TCPUFA5WAeDgaRUvBnTPAT5fQbmJgRosxydBf1?cluster=devnet) |
| `swap_guarded` | **Reverted**, `SymbolHalted` (6000), 0 funds moved | [tx](https://explorer.solana.com/tx/2ZFXgvtEWJkaEaXKtizGJLkLTdXg8YstqRykLcC5a9eL7gsfh8QgN2VoiRZFSwyA2zJMqZTxSsSYm6LZt7cBfwTX?cluster=devnet) |

The unguarded path is not a strawman. It is how every AMM on Solana behaves today, because a pool
cannot see a listing exchange.

### Walking the volume cap

Cap 200 shares, 148.61 shares per fill.

| Fill | Result | |
|---|---|---|
| 1 | Settled — first exceedance, allowed by the order and recorded | [tx](https://explorer.solana.com/tx/4M8yUTxUSkBBrdxB4eQUBTF7LtDnivCi6Nv1vaFVHy5xPwZAt46B8UgpDpMb9ZppbtwHBBhndvb76siXEw7t1DVB?cluster=devnet) |
| 2 | **Reverted**, `VolumeCapExceeded` (6003) | [tx](https://explorer.solana.com/tx/2Z2BhF97pU4gBG4G9mEe8ajUy8XKtr5kenjPFMeqGPva1HTrBJ8i2xRtTX1qDSVXzY1kaVNQoWNTBv3529X6948o?cluster=devnet) |

Full artifact with all 15 steps: [`docs/devnet-proof.json`](docs/devnet-proof.json).

---

## Architecture

```
programs/breaker/          the guard a venue calls before it settles
programs/reference-pool/   a constant product pool, with and without the guard
crates/breaker-core/       the compliance arithmetic, no Solana dependencies
src/                       dashboard and tape viewer
api/tape.ts                the public dollar tape
```

**`breaker-core`** holds the cap and halt rules as pure functions with no Solana dependencies, so the
arithmetic is testable directly. 18 tests cover the tier percentages, window rollover, the exact cap
boundary, the first exceedance allowance, fail-closed staleness, and the multiplier resolution pinned
to real mint values.

**The reference pool** exposes `swap_unguarded` and `swap_guarded` running identical curve maths. One
settles whenever the curve allows; the other calls Breaker first. They exist side by side so the
difference is demonstrable on chain rather than asserted here.

**Accounts.** A `Venue` nominates a halt publisher and an ADV publisher. Each listed `Symbol` carries
its tier, ADV, volume window, breach count and pause. A separate `HaltState` per symbol is written by
the halt publisher alone, keeping write authority split from the venue operator.

**The pool signs.** `check_and_record` takes the pool as a `Signer`, so a tape entry cannot be forged
on another pool's behalf.

---

## Reproduce it

```bash
# Rust workspace: the compliance arithmetic
cargo test --workspace

# Frontend: tape decoding and dashboard state
npm install && npm test

# Build both programs to SBF, then run a local validator
bash scripts/wsl-build.sh
bash scripts/wsl-localnet.sh

# Walk all three conditions end to end
node scripts/proof-run.mjs

# Or against the live devnet deployment
SOLANA_RPC_URL=https://api.devnet.solana.com node scripts/proof-run.mjs

# Rebuild the tape from chain and reconcile every dollar figure
npx tsx scripts/verify-tape.mjs
```

`verify-tape.mjs` checks the decoder against real chain data rather than fixtures, and asserts that
every dollar figure on the tape recomputes from the raw amounts. Field order bugs survive hand
written fixtures; they do not survive that.

---

## Scope and limits

Stated plainly, because a compliance tool that overstates itself is worse than none.

- **Breaker is not a venue.** It is the check a venue calls. Running it does not make anyone a
  Tokenized Securities Venue, and nothing here constitutes legal advice.
- **Halt state and ADV are attested inputs.** Both originate off chain, so both are published by
  roles the venue nominates. The program enforces freshness and authority on them, not truth.
- **The order aggregates volume caps across affiliated venues.** This implementation enforces one
  venue's own volume.
- **Devnet only.** Not audited, and not deployed to mainnet.
- **The demo venue's halt tolerance is set to one hour**, the program's ceiling, so the dashboard
  does not read stale between proof runs. Production venues would heartbeat in seconds; the program's
  own default is 120 seconds and the check cannot be disabled.

---

## The order

Order Granting Temporary Conditional Exemptive Relief, Pursuant to Section 36(a)(1) of the Securities
Exchange Act of 1934, From the Definition of "Exchange" in Section 3(a)(1) for the Use of Certain
Distributed Ledger Trading Venues for Tokenized NMS Stocks. Effective 17 September 2026, expiring 17
September 2031.
[Federal Register, 22 September 2026](https://www.federalregister.gov/documents/2026/09/22/2026-19388/order-granting-temporary-conditional-exemptive-relief-pursuant-to-section-36a1-of-the-securities).
