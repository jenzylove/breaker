// Runs a real trade against the public demo exchange, on request, with no
// wallet.
//
// Anyone should be able to watch the guard refuse a trade in one click. That
// means the transaction has to be signed by someone, so it is signed here by
// the demo exchange's own devnet key. Nothing of value is at stake: devnet
// SOL, devnet mints, a fixed trade size, and the key never leaves the server.
//
// A refused trade is sent with preflight skipped so the failure actually lands
// on chain. A revert that only ever existed in a simulation is not evidence.
//
// This is a Node function, not an edge one: @solana/web3.js needs Buffer to
// serialize a transaction, and the edge runtime does not provide it.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";


// Inlined rather than imported. Vercel transpiles each API file on its own
// instead of bundling, so a cross-directory import has nothing to resolve
// against at runtime. scripts/seed-demo.mjs rewrites this block.
// VENUE-CONFIG-START
const venueConfig = {
  "cluster": "https://api.devnet.solana.com",
  "breaker": "EdTGUwJPq5RNy4RjLRzKYbajtkDzaim3MYiPi8yB9obe",
  "reference_pool": "4EWRfxyMmze3F3e9Lff84PK1W9L7EFGdKa147icdJLxU",
  "venue": "HbAjsRcNtzgGSVCAdCyyeB5Mn5yCDVU4WdZvpZaixKiS",
  "authority": "ECXUxKxBKEMz3kLN2pDYBKRhNPvfdy3E55pLhkpVBgse",
  "quote_mint": "8J5D475qKYPBkVJeARek5AcJRkVUG6W8DyctpZtjNZFb",
  "quote_asset": "Ay3g42itcsB3fe4rVwbTNxr4sQmZ5RxBbfLEjgMbpLWW",
  "listings": [
    {
      "ticker": "TSLAx",
      "name": "Tesla",
      "state": "trading",
      "mint": "6hCrY31wVyJa4Yb2EbtP3nxWwSjU3Hfk76zq5CuwiiZU",
      "symbol": "2YiGGU6ze6bMQ5AVA8zC2DN9Rj7Tz7EYEiwDVmQnb9qy",
      "halt_state": "ZfnsPSHqaEV2pvvkpj5CLtPF6U3zpmeNcndTxDQniTL",
      "pool": "46UWgU8rHherWwkUuRrygufeStpr52cgrqyQda6jm3Up",
      "adv_shares": 90000
    },
    {
      "ticker": "NVDAx",
      "name": "NVIDIA",
      "state": "halted",
      "mint": "6iNDZjtLMctPiu1urdMyVkQEMbpZuWh1QXFUVD6LyUVv",
      "symbol": "EuRqwACdf7vrwLpc15fGwdumAEtgBh59prZTHmVgRfop",
      "halt_state": "EczQ7uk55tF1fapXYNRJS441N9ETsHN4CHL6sKVofuVe",
      "pool": "FwPBmg7pTrELdHZLT17JPRtyQSEzbcJ3r7srYngKEL1n",
      "adv_shares": 180000
    },
    {
      "ticker": "AAPLx",
      "name": "Apple",
      "state": "capped",
      "mint": "9v8PHVAR3575gp5js22XGksz7Qng4xzX9vSu1JjjoEEu",
      "symbol": "rWCanahmNR4poBXvy5EcEys3T7Jksf3FuMfnVKR16ST",
      "halt_state": "5nqWyQe9sQYiM2eWEr6rmuJYCsoENqujPHjs82Vv885b",
      "pool": null,
      "adv_shares": 60000
    },
    {
      "ticker": "SPYx",
      "name": "S&P 500",
      "state": "trading",
      "mint": "JEAW6ndpP6LaPaurmNFjHWdw5bXE9RbWSjZSGTzzZSUJ",
      "symbol": "DLwdQYwCxxecPPPAUeYt3AFk1AhFBVgsQb8ciagk8Tro",
      "halt_state": "9uu3JaYGt25QF4WkHkRhdGCTK7tGh5dSVMNupqmY6mpU",
      "pool": null,
      "adv_shares": 45000
    }
  ],
  "seeded_at": "2026-09-24T16:07:07.122Z"
} as const;
// VENUE-CONFIG-END

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Fixed and small, so repeated presses cost nothing worth protecting. */
const TRADE_AMOUNT = 400_000_000n;

// Anchor derives these as sha256("global:<name>")[..8]. Pinned rather than
// hashed here so this file has no crypto dependency; the browser client has a
// test that re-derives the same table.
const SWAP_GUARDED = Buffer.from([238, 241, 44, 95, 219, 31, 2, 212]);
const SWAP_UNGUARDED = Buffer.from([92, 5, 207, 14, 181, 254, 13, 59]);

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});

function u64(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value);
  return b;
}

function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN,
  )[0];
}

/** Plain language for each way the guard can refuse. */
const REFUSAL: Record<string, string> = {
  SymbolHalted: "Trading is halted on this stock's home exchange.",
  HaltStateStale:
    "The exchange's halt feed has gone quiet, so the venue cannot prove it is still in sync. It stops trading rather than guess.",
  SymbolPausedForBreach: "This stock is frozen after going over its limit twice.",
  VolumeCapExceeded: "This trade would push the venue past its daily limit for this stock.",
  AdvUnset: "No trading volume figure has been published for this stock yet.",
  IssuerPaused: "The company that issues this token has frozen it.",
};

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "POST only" });
  }

  const raw = process.env.DEMO_KEYPAIR;
  if (!raw) {
    return response.status(503).json({
      error: "The demo signer is not configured on this deployment.",
    });
  }

  let authority: Keypair;
  try {
    authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    return response.status(503).json({ error: "The demo signer could not be read." });
  }

  const body = (typeof request.body === "string" ? JSON.parse(request.body) : request.body) ?? {};
  const listing = venueConfig.listings.find(
    (l) => l.ticker.toUpperCase() === String(body.ticker ?? "").toUpperCase() && l.pool,
  );
  if (!listing || !listing.pool) {
    return response.status(400).json({ error: "That stock has no demo pool." });
  }

  const guarded = body.guarded !== false;
  const connection = new Connection(RPC, "confirmed");

  const baseMint = new PublicKey(listing.mint);
  const quoteMint = new PublicKey(venueConfig.quote_mint);
  const pool = new PublicKey(listing.pool);

  const keys = [
    meta(pool),
    meta(baseMint),
    meta(quoteMint),
    meta(ata(baseMint, pool), true),
    meta(ata(quoteMint, pool), true),
    meta(ata(baseMint, authority.publicKey), true),
    meta(ata(quoteMint, authority.publicKey), true),
    meta(authority.publicKey, false, true),
  ];
  if (guarded) {
    keys.push(
      meta(new PublicKey(venueConfig.venue)),
      meta(new PublicKey(listing.symbol), true),
      meta(new PublicKey(listing.halt_state)),
      meta(new PublicKey(venueConfig.quote_asset)),
      meta(new PublicKey(venueConfig.breaker)),
    );
  }
  keys.push(meta(TOKEN_2022));

  const instruction = new TransactionInstruction({
    programId: new PublicKey(venueConfig.reference_pool),
    keys,
    data: Buffer.concat([guarded ? SWAP_GUARDED : SWAP_UNGUARDED, u64(TRADE_AMOUNT)]),
  });

  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      feePayer: authority.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(instruction);
    tx.sign(authority);

    // Preflight would reject a refused trade off chain and leave nothing to
    // inspect, so it is skipped and the failure is allowed to land.
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    let landed = null;
    for (let i = 0; i < 26 && !landed; i += 1) {
      await new Promise((r) => setTimeout(r, 1100));
      const [status] = (await connection.getSignatureStatuses([signature])).value;
      if (status?.confirmationStatus) {
        landed = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      }
    }

    if (!landed) {
      return response
        .status(504)
        .json({ error: "The trade did not confirm in time. Try again." });
    }

    const logs = landed.meta?.logMessages ?? [];
    const line = logs.find((l) => l.includes("Error Code")) ?? "";
    const code = /Error Code: (\w+)/.exec(line)?.[1] ?? null;

    return response.status(200).json({
      ticker: listing.ticker,
      guarded,
      refused: Boolean(landed.meta?.err),
      code,
      reason: code ? (REFUSAL[code] ?? "The exchange refused this trade.") : null,
      signature,
      explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    });
  } catch (error) {
    return response.status(502).json({
      error: error instanceof Error ? error.message : "The trade could not be sent.",
    });
  }
}
