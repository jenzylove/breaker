// Proves, on a live validator, that Breaker enforces the three conditions the
// SEC's Innovation Exemption puts on a tokenized securities venue.
//
// The run builds a real Token-2022 equity mint with the Scaled UI Amount
// extension, a real constant product pool, and a real venue, then:
//
//   1. settles a compliant fill and emits the dollar tape entry
//   2. halts the symbol and shows the guarded swap revert while the unguarded
//      one, which is how every AMM behaves today, happily settles
//   3. walks the volume cap: the first crossing settles and is recorded, per
//      the order's first-exceedance allowance, and the next one is refused
//
// The mint carries a scheduled multiplier change that activates mid run, so the
// share accounting is exercised against a stale stored multiplier rather than a
// convenient 1.0.
//
// Usage: node scripts/proof-run.mjs [path/to/payer.json]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createMintToInstruction,
  createUpdateMultiplierDataInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
  getScaledUiAmountConfig,
} from "@solana/spl-token";

const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const IS_DEVNET = RPC.includes("devnet");

const BASE_DECIMALS = 8; // xStocks use 8
const QUOTE_DECIMALS = 6; // USDC
const BASE_UNIT = 10n ** BigInt(BASE_DECIMALS);
const QUOTE_UNIT = 10n ** BigInt(QUOTE_DECIMALS);
const SHARE_SCALE = 1_000_000_000n;

// Mirrors the live OpenAI PreStock mint: the stored field stays at 1.0 while the
// value actually in force is 1.4861347. Reading the wrong one understates every
// trade by 48.61%.
const NEW_MULTIPLIER = 1.4861347;

// Sized so the cap is crossed in a legible number of trades.
const TRADE_TOKENS = 100n * BASE_UNIT;
const ADV_SHARES = 80_000n * SHARE_SCALE; // cap at 0.25% = 200 shares

const programId = (path) =>
  new PublicKey(readFileSync(path, "utf8").match(/declare_id!\("(\w+)"\)/)[1]);
const BREAKER = programId("programs/breaker/src/lib.rs");
const POOL_PROGRAM = programId("programs/reference-pool/src/lib.rs");

const payerPath = process.argv[2] ?? `${homedir()}/.config/solana/id.json`;
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf8"))),
);
const connection = new Connection(RPC, "confirmed");

const disc = (name) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const meta = (pubkey, isWritable = false, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const explorer = (sig) =>
  IS_DEVNET ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : `localnet:${sig}`;

async function retry(fn, attempts = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (i + 1 >= attempts || !/Blockhash not found|block height exceeded|429/.test(msg)) throw err;
      await sleep(1500);
    }
  }
}

const send = (ixs, signers = []) =>
  retry(() =>
    sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [payer, ...signers], {
      commitment: "confirmed",
    }),
  );

/// Sends a transaction that is expected to fail, and reports why.
async function expectRevert(ixs, signers = []) {
  try {
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(...ixs),
      [payer, ...signers],
      { commitment: "confirmed" },
    );
    return { reverted: false, signature: sig, reason: "transaction unexpectedly succeeded" };
  } catch (err) {
    const logs = err?.logs ?? err?.transactionLogs ?? [];
    const line = logs.find((l) => l.includes("Error Code")) ?? "";
    const code = line.match(/Error Code: (\w+)/)?.[1] ?? null;
    const number = line.match(/Error Number: (\d+)/)?.[1] ?? null;
    return {
      reverted: true,
      error: code,
      errorNumber: number ? Number(number) : null,
      reason: line || String(err?.message ?? err).slice(0, 200),
    };
  }
}

const log = {
  cluster: RPC,
  order: "SEC Innovation Exemption, effective 2026-09-17",
  breaker: BREAKER.toBase58(),
  reference_pool: POOL_PROGRAM.toBase58(),
  steps: [],
};
const step = (name, data) => {
  log.steps.push({ name, ...data });
  console.log(`\n# ${name}`);
  for (const [k, v] of Object.entries(data)) console.log(`  ${k}: ${v}`);
};

async function main() {
  // ---------------------------------------------------------------- mints
  const baseMint = Keypair.generate();
  const space = getMintLen([ExtensionType.ScaledUiAmountConfig]);
  const rent = await connection.getMinimumBalanceForRentExemption(space);
  let sig = await send(
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: baseMint.publicKey,
        space,
        lamports: rent,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeScaledUiAmountConfigInstruction(
        baseMint.publicKey,
        payer.publicKey,
        1.0,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMintInstruction(
        baseMint.publicKey,
        BASE_DECIMALS,
        payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [baseMint],
  );
  step("create equity mint (Token-2022, Scaled UI Amount)", {
    mint: baseMint.publicKey.toBase58(),
    tx: explorer(sig),
  });

  const quoteMint = Keypair.generate();
  const qSpace = getMintLen([]);
  const qRent = await connection.getMinimumBalanceForRentExemption(qSpace);
  sig = await send(
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: quoteMint.publicKey,
        space: qSpace,
        lamports: qRent,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        quoteMint.publicKey,
        QUOTE_DECIMALS,
        payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [quoteMint],
  );
  step("create dollar quote mint", { mint: quoteMint.publicKey.toBase58(), tx: explorer(sig) });

  const ata = (mint, owner, allowOwnerOffCurve = false) =>
    getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, TOKEN_2022_PROGRAM_ID);

  const userBase = ata(baseMint.publicKey, payer.publicKey);
  const userQuote = ata(quoteMint.publicKey, payer.publicKey);
  sig = await send([
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, userBase, payer.publicKey, baseMint.publicKey, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, userQuote, payer.publicKey, quoteMint.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(
      baseMint.publicKey, userBase, payer.publicKey, 100_000n * BASE_UNIT, [], TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(
      quoteMint.publicKey, userQuote, payer.publicKey, 10_000_000n * QUOTE_UNIT, [], TOKEN_2022_PROGRAM_ID),
  ]);
  step("fund the taker", { tx: explorer(sig) });

  // ---------------------------------------------------------------- venue
  const [venue] = PublicKey.findProgramAddressSync(
    [Buffer.from("venue"), payer.publicKey.toBuffer()], BREAKER);
  const [symbol] = PublicKey.findProgramAddressSync(
    [Buffer.from("symbol"), venue.toBuffer(), baseMint.publicKey.toBuffer()], BREAKER);
  const [haltState] = PublicKey.findProgramAddressSync(
    [Buffer.from("halt"), symbol.toBuffer()], BREAKER);
  const [quoteAsset] = PublicKey.findProgramAddressSync(
    [Buffer.from("quote"), venue.toBuffer(), quoteMint.publicKey.toBuffer()], BREAKER);

  sig = await send([
    new TransactionInstruction({
      programId: BREAKER,
      keys: [meta(venue, true), meta(payer.publicKey, true, true), meta(SystemProgram.programId)],
      data: Buffer.concat([
        disc("initialize_venue"),
        payer.publicKey.toBuffer(), // halt publisher
        payer.publicKey.toBuffer(), // adv publisher
      ]),
    }),
  ]);
  step("initialize venue", { venue: venue.toBase58(), tx: explorer(sig) });

  const ticker = Buffer.alloc(8);
  ticker.write("TSLAx");
  sig = await send([
    new TransactionInstruction({
      programId: BREAKER,
      keys: [
        meta(venue, true),
        meta(symbol, true),
        meta(haltState, true),
        meta(baseMint.publicKey),
        meta(payer.publicKey, true, true),
        meta(SystemProgram.programId),
      ],
      data: Buffer.concat([disc("list_symbol"), ticker, Buffer.from([1])]), // Tier 1
    }),
    new TransactionInstruction({
      programId: BREAKER,
      keys: [
        meta(venue),
        meta(quoteAsset, true),
        meta(quoteMint.publicKey),
        meta(payer.publicKey, true, true),
        meta(SystemProgram.programId),
      ],
      data: Buffer.concat([
        disc("register_quote_asset"),
        Buffer.from([QUOTE_DECIMALS]),
        Buffer.from([0]), // QuoteKind::UsdStable
        Buffer.alloc(32),
      ]),
    }),
  ]);
  step("list TSLAx as Tier 1 and register the dollar quote asset", {
    symbol: symbol.toBase58(),
    note: "a newly listed symbol starts halted until the publisher opens it",
    tx: explorer(sig),
  });

  const capShares = (ADV_SHARES * 25n) / 10_000n;
  sig = await send([
    new TransactionInstruction({
      programId: BREAKER,
      keys: [meta(venue), meta(symbol, true), meta(payer.publicKey, false, true)],
      data: Buffer.concat([disc("update_adv"), u64(ADV_SHARES)]),
    }),
  ]);
  step("publish prior month average daily volume", {
    adv_shares: `${ADV_SHARES / SHARE_SCALE}`,
    cap_shares: `${capShares / SHARE_SCALE} (0.25% of ADV, Tier 1)`,
    tx: explorer(sig),
  });

  const setHalt = (halted) =>
    new TransactionInstruction({
      programId: BREAKER,
      keys: [meta(venue), meta(haltState, true), meta(payer.publicKey, false, true)],
      data: Buffer.concat([disc("set_halt"), Buffer.from([halted ? 1 : 0])]),
    });

  sig = await send([setHalt(false)]);
  step("halt publisher opens the symbol", { halted: false, tx: explorer(sig) });

  // ----------------------------------------------------------------- pool
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), baseMint.publicKey.toBuffer(), quoteMint.publicKey.toBuffer()],
    POOL_PROGRAM,
  );
  const baseVault = ata(baseMint.publicKey, pool, true);
  const quoteVault = ata(quoteMint.publicKey, pool, true);

  sig = await send([
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, baseVault, pool, baseMint.publicKey, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, quoteVault, pool, quoteMint.publicKey, TOKEN_2022_PROGRAM_ID),
    new TransactionInstruction({
      programId: POOL_PROGRAM,
      keys: [
        meta(pool, true),
        meta(baseMint.publicKey),
        meta(quoteMint.publicKey),
        meta(baseVault),
        meta(quoteVault),
        meta(payer.publicKey, true, true),
        meta(SystemProgram.programId),
      ],
      data: disc("initialize_pool"),
    }),
    new TransactionInstruction({
      programId: POOL_PROGRAM,
      keys: [
        meta(pool),
        meta(baseMint.publicKey),
        meta(quoteMint.publicKey),
        meta(baseVault, true),
        meta(quoteVault, true),
        meta(userBase, true),
        meta(userQuote, true),
        meta(payer.publicKey, false, true),
        meta(TOKEN_2022_PROGRAM_ID),
      ],
      data: Buffer.concat([
        disc("add_liquidity"),
        u64(10_000n * BASE_UNIT),
        u64(3_000_000n * QUOTE_UNIT),
      ]),
    }),
  ]);
  step("create the pool and seed it", {
    pool: pool.toBase58(),
    reserves: "10,000 TSLAx / 3,000,000 dollars",
    tx: explorer(sig),
  });

  // ------------------------------------------- activate a corporate action
  const effectiveAt = Math.floor(Date.now() / 1000) + 12;
  sig = await send([
    createUpdateMultiplierDataInstruction(
      baseMint.publicKey, payer.publicKey, NEW_MULTIPLIER, BigInt(effectiveAt), [], TOKEN_2022_PROGRAM_ID),
  ]);
  while ((await connection.getBlockTime(await connection.getSlot())) <= effectiveAt + 1) {
    await sleep(1500);
  }
  const mintState = await getMint(connection, baseMint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  const cfg = getScaledUiAmountConfig(mintState);
  step("a scheduled multiplier change activates", {
    stored_multiplier: cfg.multiplier,
    effective_multiplier: cfg.newMultiplier,
    understatement_if_stored_field_is_read: `${(((cfg.newMultiplier / cfg.multiplier) - 1) * 100).toFixed(2)}%`,
    tx: explorer(sig),
  });

  // --------------------------------------------------------------- swaps
  const swapIx = (name, amount) =>
    new TransactionInstruction({
      programId: POOL_PROGRAM,
      keys: [
        meta(pool),
        meta(baseMint.publicKey),
        meta(quoteMint.publicKey),
        meta(baseVault, true),
        meta(quoteVault, true),
        meta(userBase, true),
        meta(userQuote, true),
        meta(payer.publicKey, false, true),
        ...(name === "swap_guarded"
          ? [meta(venue), meta(symbol, true), meta(haltState), meta(quoteAsset), meta(BREAKER)]
          : []),
        meta(TOKEN_2022_PROGRAM_ID),
      ],
      data: Buffer.concat([disc(name), u64(amount)]),
    });

  const quoteBalance = async () =>
    (await getAccount(connection, userQuote, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

  // 1. A compliant fill.
  let before = await quoteBalance();
  sig = await send([swapIx("swap_guarded", TRADE_TOKENS)]);
  let received = (await quoteBalance()) - before;
  const sharesPerTrade = (TRADE_TOKENS * BigInt(Math.round(NEW_MULTIPLIER * 1e9))) / BASE_UNIT;
  step("1. compliant fill settles through the guard", {
    sold: `${TRADE_TOKENS / BASE_UNIT} TSLAx`,
    received: `${Number(received) / Number(QUOTE_UNIT)} dollars`,
    shares_consumed: `${Number(sharesPerTrade) / Number(SHARE_SCALE)} of ${capShares / SHARE_SCALE}`,
    note: "the share count follows the effective multiplier, not the stored one",
    tx: explorer(sig),
  });

  // 2. The listing exchange halts the stock.
  sig = await send([setHalt(true)]);
  step("2a. listing exchange halts TSLAx", { halted: true, tx: explorer(sig) });

  const halted = await expectRevert([swapIx("swap_guarded", TRADE_TOKENS)]);
  step("2b. guarded swap during the halt", {
    result: halted.reverted ? "REVERTED on chain" : "UNEXPECTEDLY SETTLED",
    error: halted.error,
    error_number: halted.errorNumber,
    reason: halted.reason,
  });

  before = await quoteBalance();
  sig = await send([swapIx("swap_unguarded", TRADE_TOKENS)]);
  received = (await quoteBalance()) - before;
  step("2c. the same swap without the guard, which is every AMM today", {
    result: "SETTLED while the stock was halted",
    received: `${Number(received) / Number(QUOTE_UNIT)} dollars`,
    tx: explorer(sig),
  });

  sig = await send([setHalt(false)]);
  step("2d. halt lifted", { halted: false, tx: explorer(sig) });

  // 3. The volume cap.
  const capResults = [];
  for (let i = 0; i < 4; i++) {
    const attempt = await expectRevert([swapIx("swap_guarded", TRADE_TOKENS)]);
    capResults.push(
      attempt.reverted
        ? { trade: i + 1, result: "REVERTED", error: attempt.error, error_number: attempt.errorNumber }
        : { trade: i + 1, result: "settled", signature: attempt.signature },
    );
    if (attempt.reverted) break;
  }
  step("3. walking the volume cap", {
    cap_shares: `${capShares / SHARE_SCALE}`,
    shares_per_trade: `${Number(sharesPerTrade) / Number(SHARE_SCALE)}`,
    sequence: JSON.stringify(capResults),
    note: "the order allows the first exceedance; the next crossing is refused",
  });

  mkdirSync("docs", { recursive: true });
  const out = `docs/${IS_DEVNET ? "devnet" : "localnet"}-proof.json`;
  writeFileSync(out, JSON.stringify(log, null, 2));
  console.log(`\nsaved ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
