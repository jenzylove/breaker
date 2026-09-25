// Approves the demo venue's pools to call check_and_record.
//
// Breaker only records trades from pools the venue has approved; this names
// each demo pool's program derived address, which only the reference pool
// program can sign with.
//
// usage: node scripts/approve-pools.mjs [payer.json]

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const venueConfig = JSON.parse(readFileSync("docs/demo-venue.json", "utf8"));
const breaker = new PublicKey(venueConfig.breaker);
const venue = new PublicKey(venueConfig.venue);
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.argv[2] ?? ".demo/payer.json", "utf8"))),
);
const connection = new Connection(RPC, "confirmed");
const disc = createHash("sha256").update("global:approve_pool").digest().subarray(0, 8);
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

for (const listing of venueConfig.listings.filter((l) => l.pool)) {
  const pool = new PublicKey(listing.pool);
  const [approved] = PublicKey.findProgramAddressSync(
    [Buffer.from("approved"), venue.toBuffer(), pool.toBuffer()],
    breaker,
  );
  if (await connection.getAccountInfo(approved)) {
    console.log(`${listing.ticker}: already approved ${approved.toBase58()}`);
    continue;
  }
  const ix = new TransactionInstruction({
    programId: breaker,
    keys: [meta(venue), meta(approved, true), meta(payer.publicKey, true, true), meta(SystemProgram.programId)],
    data: Buffer.concat([disc, pool.toBuffer()]),
  });
  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], {
    commitment: "confirmed",
  });
  console.log(`${listing.ticker}: approved ${pool.toBase58()}  https://explorer.solana.com/tx/${signature}?cluster=devnet`);
}
