// Sets how long the demo venue's halt flags stay trustworthy.
//
// With the publisher on a five minute schedule, a fifteen minute tolerance
// leaves room for a late or skipped run without letting a dead publisher go
// unnoticed: once a flag is older than this, Breaker refuses trades in that
// stock rather than trust it.
//
// usage: node scripts/set-halt-tolerance.mjs [seconds] [payer.json]

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const seconds = Number(process.argv[2] ?? 900);
const payerPath = process.argv[3] ?? ".demo/payer.json";
if (!(seconds >= 1 && seconds <= 3600)) throw new Error("tolerance must be 1 to 3600 seconds");

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const venueConfig = JSON.parse(readFileSync("docs/demo-venue.json", "utf8"));
const breaker = new PublicKey(venueConfig.breaker);
const venue = new PublicKey(venueConfig.venue);
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf8"))));
const connection = new Connection(RPC, "confirmed");

const disc = createHash("sha256").update("global:set_halt_max_age").digest().subarray(0, 8);
const age = Buffer.alloc(8);
age.writeBigInt64LE(BigInt(seconds));
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

const tx = new Transaction().add(
  ...venueConfig.listings.map(
    (listing) =>
      new TransactionInstruction({
        programId: breaker,
        keys: [meta(venue), meta(new PublicKey(listing.halt_state), true), meta(payer.publicKey, false, true)],
        data: Buffer.concat([disc, age]),
      }),
  ),
);
const signature = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
console.log(`tolerance ${seconds}s on ${venueConfig.listings.length} stocks`);
console.log(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
