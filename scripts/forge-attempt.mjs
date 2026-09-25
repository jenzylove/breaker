// Tries to write a fake trade into the record from an unapproved signer, the
// attack an audit found before pools needed the venue's approval. Both
// attempts should fail on chain: with no approval at all, and while borrowing
// a real pool's approval.
//
// usage: node scripts/forge-attempt.mjs [payer.json]

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const cfg = JSON.parse(readFileSync("docs/demo-venue.json", "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.argv[2] ?? ".demo/payer.json", "utf8"))));
const connection = new Connection(RPC, "confirmed");
const breaker = new PublicKey(cfg.breaker);
const venue = new PublicKey(cfg.venue);
const listing = cfg.listings.find((l) => l.ticker === "NVDAx");
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const approvalFor = (pool) =>
  PublicKey.findProgramAddressSync([Buffer.from("approved"), venue.toBuffer(), pool.toBuffer()], breaker)[0];

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const data = Buffer.concat([
  createHash("sha256").update("global:check_and_record").digest().subarray(0, 8),
  u64(400_000_000n), u64(1_000_000_000n), Buffer.from([1]),
]);

const forger = Keypair.generate();
const attempts = [
  ["no approval", approvalFor(forger.publicKey)],
  ["a real pool's approval", approvalFor(new PublicKey(listing.pool))],
];

for (const [label, approval] of attempts) {
  const ix = new TransactionInstruction({
    programId: breaker,
    keys: [
      meta(venue), meta(new PublicKey(listing.symbol), true), meta(new PublicKey(listing.halt_state)),
      meta(new PublicKey(cfg.quote_asset)), meta(new PublicKey(listing.mint)),
      meta(forger.publicKey, false, true), meta(approval),
    ],
    data,
  });
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(ix);
  tx.sign(payer, forger);
  // Preflight is skipped so the refusal lands on chain where it can be opened.
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction(sig, "confirmed");
  const landed = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const line = (landed?.meta?.logMessages ?? []).find((l) => l.includes("Error Code")) ?? "";
  console.log(`${label}: ${landed?.meta?.err ? "REFUSED" : "ACCEPTED"}  ${/Error Code: (\w+)/.exec(line)?.[1] ?? ""}`);
  console.log(`  https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}
