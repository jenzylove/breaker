// Seeds the public demo venue on devnet.
//
// The page lets anyone watch the guard refuse a trade without connecting a
// wallet, so the venue behind it has to already exist and already be in a
// state worth looking at: several stocks, each in a different condition.
//
// Real xStock mints only exist on mainnet, so this creates devnet mints that
// mirror them: Token-2022 with the Scaled UI Amount extension, and a scheduled
// multiplier change that has already activated, which is the live state of the
// real ones.
//
// Usage: node scripts/seed-demo.mjs [path/to/payer.json]

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
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const DECIMALS = 8;
const QUOTE_DECIMALS = 6;
const UNIT = 10n ** BigInt(DECIMALS);
const QUOTE_UNIT = 10n ** BigInt(QUOTE_DECIMALS);
const SHARE_SCALE = 1_000_000_000n;

const programId = (path) =>
  new PublicKey(readFileSync(path, "utf8").match(/declare_id!\("(\w+)"\)/)[1]);
const BREAKER = programId("programs/breaker/src/lib.rs");
const POOL_PROGRAM = programId("programs/reference-pool/src/lib.rs");

// Four stocks in four different conditions, so the board reads as a venue
// rather than a single ticker.
const SYMBOLS = [
  { ticker: "TSLAx", name: "Tesla", adv: 90_000, state: "trading", multiplier: 1.0412, pool: true },
  { ticker: "NVDAx", name: "NVIDIA", adv: 180_000, state: "halted", multiplier: 1.0017, pool: true },
  { ticker: "AAPLx", name: "Apple", adv: 60_000, state: "capped", multiplier: 1.0033, pool: false },
  { ticker: "SPYx", name: "S&P 500", adv: 45_000, state: "trading", multiplier: 1.0057, pool: false },
];

const payerPath = process.argv[2] ?? `${homedir()}/.config/solana/id.json`;
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf8"))),
);
const connection = new Connection(RPC, "confirmed");

const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(ixs, signers = []) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendAndConfirmTransaction(
        connection,
        new Transaction().add(...ixs),
        [payer, ...signers],
        { commitment: "confirmed" },
      );
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (attempt >= 3 || !/Blockhash not found|block height exceeded|429/.test(msg)) throw err;
      await sleep(1500);
    }
  }
}

const ata = (mint, owner, offCurve = false) =>
  getAssociatedTokenAddressSync(mint, owner, offCurve, TOKEN_2022_PROGRAM_ID);

async function createMint(decimals, scaled) {
  const mint = Keypair.generate();
  const space = getMintLen(scaled ? [ExtensionType.ScaledUiAmountConfig] : []);
  const rent = await connection.getMinimumBalanceForRentExemption(space);
  const ixs = [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space,
      lamports: rent,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
  ];
  if (scaled) {
    ixs.push(
      createInitializeScaledUiAmountConfigInstruction(
        mint.publicKey,
        payer.publicKey,
        1.0,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  ixs.push(
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      payer.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  await send(ixs, [mint]);
  return mint.publicKey;
}

async function main() {
  console.log(`payer  ${payer.publicKey.toBase58()}`);
  console.log(`balance ${(await connection.getBalance(payer.publicKey)) / 1e9} SOL\n`);

  const [venue] = PublicKey.findProgramAddressSync(
    [Buffer.from("venue"), payer.publicKey.toBuffer()],
    BREAKER,
  );

  // The venue may already exist from an earlier run.
  if (!(await connection.getAccountInfo(venue))) {
    await send([
      new TransactionInstruction({
        programId: BREAKER,
        keys: [meta(venue, true), meta(payer.publicKey, true, true), meta(SystemProgram.programId)],
        data: Buffer.concat([
          disc("initialize_venue"),
          payer.publicKey.toBuffer(),
          payer.publicKey.toBuffer(),
        ]),
      }),
    ]);
    console.log(`venue created ${venue.toBase58()}`);
  } else {
    console.log(`venue exists  ${venue.toBase58()}`);
  }

  const quoteMint = await createMint(QUOTE_DECIMALS, false);
  console.log(`dollar mint   ${quoteMint.toBase58()}`);

  const [quoteAsset] = PublicKey.findProgramAddressSync(
    [Buffer.from("quote"), venue.toBuffer(), quoteMint.toBuffer()],
    BREAKER,
  );
  await send([
    new TransactionInstruction({
      programId: BREAKER,
      keys: [
        meta(venue),
        meta(quoteAsset, true),
        meta(quoteMint),
        meta(payer.publicKey, true, true),
        meta(SystemProgram.programId),
      ],
      data: Buffer.concat([
        disc("register_quote_asset"),
        Buffer.from([QUOTE_DECIMALS]),
        Buffer.from([0]),
        Buffer.alloc(32),
      ]),
    }),
  ]);

  const userQuote = ata(quoteMint, payer.publicKey);
  await send([
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, userQuote, payer.publicKey, quoteMint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(
      quoteMint, userQuote, payer.publicKey, 50_000_000n * QUOTE_UNIT, [], TOKEN_2022_PROGRAM_ID),
  ]);

  const listings = [];

  for (const cfg of SYMBOLS) {
    console.log(`\n--- ${cfg.ticker} (${cfg.state}) ---`);
    const mint = await createMint(DECIMALS, true);

    const [symbol] = PublicKey.findProgramAddressSync(
      [Buffer.from("symbol"), venue.toBuffer(), mint.toBuffer()], BREAKER);
    const [haltState] = PublicKey.findProgramAddressSync(
      [Buffer.from("halt"), symbol.toBuffer()], BREAKER);

    const ticker = Buffer.alloc(8);
    ticker.write(cfg.ticker);
    await send([
      new TransactionInstruction({
        programId: BREAKER,
        keys: [
          meta(venue, true),
          meta(symbol, true),
          meta(haltState, true),
          meta(mint),
          meta(payer.publicKey, true, true),
          meta(SystemProgram.programId),
        ],
        data: Buffer.concat([disc("list_symbol"), ticker, Buffer.from([1])]),
      }),
      new TransactionInstruction({
        programId: BREAKER,
        keys: [meta(venue), meta(symbol, true), meta(payer.publicKey, false, true)],
        data: Buffer.concat([disc("update_adv"), u64(BigInt(cfg.adv) * SHARE_SCALE)]),
      }),
      // An hour of tolerance, so the board does not read as stale between
      // publisher heartbeats. The program caps this at an hour and the
      // staleness check itself cannot be disabled.
      new TransactionInstruction({
        programId: BREAKER,
        keys: [meta(venue), meta(haltState, true), meta(payer.publicKey, false, true)],
        data: Buffer.concat([disc("set_halt_max_age"), (() => {
          const b = Buffer.alloc(8);
          b.writeBigInt64LE(3600n);
          return b;
        })()]),
      }),
    ]);
    console.log(`  listed, ADV ${cfg.adv.toLocaleString()} shares`);

    // Mirror the real mints: a scheduled multiplier that has already activated,
    // so the stored field is not the one in force.
    const effectiveAt = Math.floor(Date.now() / 1000) - 60;
    await send([
      createUpdateMultiplierDataInstruction(
        mint, payer.publicKey, cfg.multiplier, BigInt(effectiveAt), [], TOKEN_2022_PROGRAM_ID),
    ]);
    console.log(`  multiplier ${cfg.multiplier} already in force`);

    // Open it unless this one is meant to show as halted.
    await send([
      new TransactionInstruction({
        programId: BREAKER,
        keys: [meta(venue), meta(haltState, true), meta(payer.publicKey, false, true)],
        data: Buffer.concat([disc("set_halt"), Buffer.from([cfg.state === "halted" ? 1 : 0])]),
      }),
    ]);

    let pool = null;
    if (cfg.pool) {
      const [poolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), mint.toBuffer(), quoteMint.toBuffer()], POOL_PROGRAM);
      const baseVault = ata(mint, poolPda, true);
      const quoteVault = ata(quoteMint, poolPda, true);
      const userBase = ata(mint, payer.publicKey);

      await send([
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey, userBase, payer.publicKey, mint, TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(
          mint, userBase, payer.publicKey, 500_000n * UNIT, [], TOKEN_2022_PROGRAM_ID),
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey, baseVault, poolPda, mint, TOKEN_2022_PROGRAM_ID),
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey, quoteVault, poolPda, quoteMint, TOKEN_2022_PROGRAM_ID),
      ]);

      await send([
        new TransactionInstruction({
          programId: POOL_PROGRAM,
          keys: [
            meta(poolPda, true), meta(mint), meta(quoteMint), meta(baseVault), meta(quoteVault),
            meta(payer.publicKey, true, true), meta(SystemProgram.programId),
          ],
          data: disc("initialize_pool"),
        }),
        new TransactionInstruction({
          programId: POOL_PROGRAM,
          keys: [
            meta(poolPda), meta(mint), meta(quoteMint), meta(baseVault, true), meta(quoteVault, true),
            meta(userBase, true), meta(userQuote, true), meta(payer.publicKey, false, true),
            meta(TOKEN_2022_PROGRAM_ID),
          ],
          data: Buffer.concat([disc("add_liquidity"), u64(20_000n * UNIT), u64(6_000_000n * QUOTE_UNIT)]),
        }),
      ]);
      pool = poolPda.toBase58();
      console.log(`  pool seeded ${pool}`);
    }

    // Push this one over its cap so the board shows a symbol that has used up
    // its allowance, which is one of the three conditions in action.
    if (cfg.state === "capped" ) {
      await send([
        new TransactionInstruction({
          programId: BREAKER,
          keys: [meta(venue), meta(symbol, true), meta(payer.publicKey, false, true)],
          data: Buffer.concat([disc("report_breach")]),
        }),
      ]);
      console.log("  breach recorded, symbol paused");
    }

    listings.push({
      ticker: cfg.ticker,
      name: cfg.name,
      state: cfg.state,
      mint: mint.toBase58(),
      symbol: symbol.toBase58(),
      halt_state: haltState.toBase58(),
      pool,
      adv_shares: cfg.adv,
    });
  }

  const config = {
    cluster: RPC,
    breaker: BREAKER.toBase58(),
    reference_pool: POOL_PROGRAM.toBase58(),
    venue: venue.toBase58(),
    authority: payer.publicKey.toBase58(),
    quote_mint: quoteMint.toBase58(),
    quote_asset: quoteAsset.toBase58(),
    listings,
    seeded_at: new Date().toISOString(),
  };

  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/demo-venue.json", JSON.stringify(config, null, 2));
  console.log("\nsaved docs/demo-venue.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
