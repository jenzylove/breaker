// Transaction builders for the venue console.
//
// Discriminators are pinned rather than hashed at runtime, so no hasher ships
// to the browser. A test re-derives every one of them, which means a renamed
// instruction fails the build instead of producing transactions the program
// silently rejects.

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const BREAKER_PROGRAM = new PublicKey("EdTGUwJPq5RNy4RjLRzKYbajtkDzaim3MYiPi8yB9obe");
export const POOL_PROGRAM = new PublicKey("4EWRfxyMmze3F3e9Lff84PK1W9L7EFGdKa147icdJLxU");
export const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export const IX = {
  initialize_venue: Uint8Array.from([213, 205, 214, 10, 231, 115, 171, 35]),
  list_symbol: Uint8Array.from([108, 43, 150, 238, 88, 220, 59, 162]),
  register_quote_asset: Uint8Array.from([27, 103, 89, 7, 31, 101, 103, 28]),
  update_adv: Uint8Array.from([86, 83, 141, 166, 139, 33, 221, 56]),
  set_halt: Uint8Array.from([212, 192, 179, 66, 23, 73, 197, 15]),
  set_halt_max_age: Uint8Array.from([11, 181, 208, 221, 57, 216, 4, 35]),
  check_and_record: Uint8Array.from([168, 15, 146, 119, 165, 8, 22, 68]),
  report_breach: Uint8Array.from([239, 238, 23, 139, 14, 7, 253, 178]),
  set_venue_paused: Uint8Array.from([217, 53, 58, 136, 21, 1, 187, 123]),
} as const;

export const POOL_IX = {
  swap_unguarded: Uint8Array.from([92, 5, 207, 14, 181, 254, 13, 59]),
  swap_guarded: Uint8Array.from([238, 241, 44, 95, 219, 31, 2, 212]),
} as const;

/** Share quantities are nano-shares throughout, matching the program. */
export const SHARE_SCALE = 1_000_000_000n;

/* ------------------------------------------------------------ encoding */

function concat(...parts: Uint8Array[]): Buffer {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return Buffer.from(out);
}

function u64(value: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, value, true);
  return b;
}

function i64(value: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, value, true);
  return b;
}

/** Tickers are a fixed eight bytes on chain, zero padded. */
export function encodeTicker(ticker: string): Uint8Array {
  const out = new Uint8Array(8);
  out.set(new TextEncoder().encode(ticker).subarray(0, 8));
  return out;
}

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});

/* ---------------------------------------------------------------- PDAs */

export const venuePda = (authority: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("venue"), authority.toBuffer()], BREAKER_PROGRAM)[0];

export const symbolPda = (venue: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("symbol"), venue.toBuffer(), mint.toBuffer()],
    BREAKER_PROGRAM,
  )[0];

export const haltPda = (symbol: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("halt"), symbol.toBuffer()], BREAKER_PROGRAM)[0];

export const quotePda = (venue: PublicKey, quoteMint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("quote"), venue.toBuffer(), quoteMint.toBuffer()],
    BREAKER_PROGRAM,
  )[0];

export const poolPda = (baseMint: PublicKey, quoteMint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), baseMint.toBuffer(), quoteMint.toBuffer()],
    POOL_PROGRAM,
  )[0];

/* -------------------------------------------------------- instructions */

/**
 * Opens a venue. The operator nominates the two attested publishers the order's
 * conditions depend on; passing their own key makes them both, which is the
 * sensible default for a single operator.
 */
export function initializeVenue(
  authority: PublicKey,
  haltPublisher: PublicKey = authority,
  advPublisher: PublicKey = authority,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: BREAKER_PROGRAM,
    keys: [
      meta(venuePda(authority), true),
      meta(authority, true, true),
      meta(SystemProgram.programId),
    ],
    data: concat(
      IX.initialize_venue,
      haltPublisher.toBytes(),
      advPublisher.toBytes(),
    ),
  });
}

/** Lists a symbol. The program reads the mint first and refuses anything that
 *  is not a Token-2022 equity token with a readable multiplier. */
export function listSymbol(
  authority: PublicKey,
  mint: PublicKey,
  ticker: string,
  tier: 1 | 2,
): TransactionInstruction {
  const venue = venuePda(authority);
  const symbol = symbolPda(venue, mint);
  return new TransactionInstruction({
    programId: BREAKER_PROGRAM,
    keys: [
      meta(venue, true),
      meta(symbol, true),
      meta(haltPda(symbol), true),
      meta(mint),
      meta(authority, true, true),
      meta(SystemProgram.programId),
    ],
    data: concat(IX.list_symbol, encodeTicker(ticker), Uint8Array.from([tier])),
  });
}

export function registerQuoteAsset(
  authority: PublicKey,
  quoteMint: PublicKey,
  decimals: number,
): TransactionInstruction {
  const venue = venuePda(authority);
  return new TransactionInstruction({
    programId: BREAKER_PROGRAM,
    keys: [
      meta(venue),
      meta(quotePda(venue, quoteMint), true),
      meta(quoteMint),
      meta(authority, true, true),
      meta(SystemProgram.programId),
    ],
    // QuoteKind::UsdStable, and no Pyth feed: a dollar stablecoin needs no
    // oracle because the fill is already denominated in dollars.
    data: concat(IX.register_quote_asset, Uint8Array.from([decimals, 0]), new Uint8Array(32)),
  });
}

/** Publishes prior month average daily volume, in whole shares. */
export function updateAdv(
  venue: PublicKey,
  symbol: PublicKey,
  advPublisher: PublicKey,
  advShares: number,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: BREAKER_PROGRAM,
    keys: [meta(venue), meta(symbol, true), meta(advPublisher, false, true)],
    data: concat(IX.update_adv, u64(BigInt(Math.floor(advShares)) * SHARE_SCALE)),
  });
}

export function setHalt(
  venue: PublicKey,
  symbol: PublicKey,
  haltPublisher: PublicKey,
  halted: boolean,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: BREAKER_PROGRAM,
    keys: [meta(venue), meta(haltPda(symbol), true), meta(haltPublisher, false, true)],
    data: concat(IX.set_halt, Uint8Array.from([halted ? 1 : 0])),
  });
}

export function setHaltMaxAge(
  authority: PublicKey,
  symbol: PublicKey,
  seconds: number,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: BREAKER_PROGRAM,
    keys: [meta(venuePda(authority)), meta(haltPda(symbol), true), meta(authority, false, true)],
    data: concat(IX.set_halt_max_age, i64(BigInt(Math.floor(seconds)))),
  });
}

export function reportBreach(authority: PublicKey, symbol: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: BREAKER_PROGRAM,
    keys: [meta(venuePda(authority)), meta(symbol, true), meta(authority, false, true)],
    data: concat(IX.report_breach),
  });
}

/* ------------------------------------------------------- pool (demo) */

export interface SwapAccounts {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  userBase: PublicKey;
  userQuote: PublicKey;
  user: PublicKey;
  venue: PublicKey;
  symbol: PublicKey;
  quoteAsset: PublicKey;
}

/**
 * Builds a swap against the reference pool, with or without the guard. The two
 * run identical curve maths, which is the entire point: the only difference a
 * user can observe is whether Breaker was asked first.
 */
export function swap(
  accounts: SwapAccounts,
  baseAmount: bigint,
  guarded: boolean,
): TransactionInstruction {
  const pool = poolPda(accounts.baseMint, accounts.quoteMint);
  const keys = [
    meta(pool),
    meta(accounts.baseMint),
    meta(accounts.quoteMint),
    meta(accounts.baseVault, true),
    meta(accounts.quoteVault, true),
    meta(accounts.userBase, true),
    meta(accounts.userQuote, true),
    meta(accounts.user, false, true),
  ];
  if (guarded) {
    keys.push(
      meta(accounts.venue),
      meta(accounts.symbol, true),
      meta(haltPda(accounts.symbol)),
      meta(accounts.quoteAsset),
      meta(BREAKER_PROGRAM),
    );
  }
  keys.push(meta(TOKEN_2022));

  return new TransactionInstruction({
    programId: POOL_PROGRAM,
    keys,
    data: concat(guarded ? POOL_IX.swap_guarded : POOL_IX.swap_unguarded, u64(baseAmount)),
  });
}

/* ------------------------------------------------------------- errors */

/** Maps the program's error codes to something an operator can act on. */
export const ERROR_MEANING: Record<number, string> = {
  6000: "Trading is halted on the primary listing exchange",
  6001: "The halt feed is stale, so the venue cannot prove it mirrors the exchange",
  6002: "The symbol is inside a three month pause from an earlier breach",
  6003: "The fill would exceed the venue's share volume cap",
  6004: "No prior month average daily volume has been published",
  6009: "The issuer has paused this mint",
  6011: "The venue is paused",
};

export function explainError(logs: string[] | undefined): { code: string; meaning: string } | null {
  if (!logs) return null;
  const line = logs.find((l) => l.includes("Error Code"));
  if (!line) return null;
  const code = /Error Code: (\w+)/.exec(line)?.[1] ?? "Unknown";
  const number = Number(/Error Number: (\d+)/.exec(line)?.[1] ?? NaN);
  return { code, meaning: ERROR_MEANING[number] ?? "The guard refused this fill" };
}
