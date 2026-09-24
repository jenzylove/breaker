// The halt publisher's heartbeat.
//
// A venue mirroring a listing exchange would refresh this every few seconds off
// the exchange's own halt feed. The program defaults to a 120 second tolerance
// and fails closed past it, which is the right production value but means a
// demo venue reads as "feed stale" minutes after a proof run.
//
// So this does two things: widens this venue's tolerance to the program's
// ceiling of one hour, and publishes a fresh heartbeat. The tolerance is venue
// configuration, not a change to the rule, and the program still refuses to let
// any venue disable the staleness check.
//
// Usage: node scripts/publisher.mjs [path/to/payer.json] [--halted]

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const HALT_MAX_AGE_SECONDS = 3600; // the program's ceiling

const proof = JSON.parse(readFileSync("docs/devnet-proof.json", "utf8"));
const BREAKER = new PublicKey(proof.breaker);
const venue = new PublicKey(proof.venue);

const args = process.argv.slice(2);
const halted = args.includes("--halted");
const payerPath = args.find((a) => !a.startsWith("--")) ?? `${homedir()}/.config/solana/id.json`;
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf8"))),
);

const connection = new Connection(RPC, "confirmed");
const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

const i64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};

for (const listing of proof.listings ?? []) {
  const haltState = new PublicKey(listing.halt_state);

  const ixs = [
    new TransactionInstruction({
      programId: BREAKER,
      keys: [meta(venue), meta(haltState, true), meta(payer.publicKey, false, true)],
      data: Buffer.concat([disc("set_halt_max_age"), i64(HALT_MAX_AGE_SECONDS)]),
    }),
    new TransactionInstruction({
      programId: BREAKER,
      keys: [meta(venue), meta(haltState, true), meta(payer.publicKey, false, true)],
      data: Buffer.concat([disc("set_halt"), Buffer.from([halted ? 1 : 0])]),
    }),
  ];

  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [payer], {
    commitment: "confirmed",
  });
  console.log(
    `${listing.ticker}: halted=${halted}, tolerance=${HALT_MAX_AGE_SECONDS}s  ` +
      `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
  );
}
