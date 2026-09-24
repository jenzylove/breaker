// Rebuilds the tape from devnet and prints it, so the decoder is checked
// against real chain data rather than only the synthetic payloads in the unit
// tests. Field order bugs survive hand written fixtures; they do not survive
// this.
//
// Usage: node scripts/verify-tape.mjs [programId]

import { Connection, PublicKey } from "@solana/web3.js";
import { tapeEntriesFromLogs } from "../src/lib/tape.ts";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM = new PublicKey(
  process.argv[2] ?? "EdTGUwJPq5RNy4RjLRzKYbajtkDzaim3MYiPi8yB9obe",
);

const connection = new Connection(RPC, "confirmed");
const signatures = await connection.getSignaturesForAddress(PROGRAM, { limit: 40 });
console.log(`${signatures.length} signatures, ${signatures.filter((s) => s.err).length} reverted`);

const entries = [];
for (const info of signatures.filter((s) => !s.err)) {
  const tx = await connection.getTransaction(info.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = tx?.meta?.logMessages ?? [];
  entries.push(...tapeEntriesFromLogs(logs, { signature: info.signature, slot: info.slot }));
}

entries.sort((a, b) => b.slot - a.slot);
console.log(`\n${entries.length} tape entries\n`);
for (const e of entries) {
  console.log(
    `${e.timestamp}  ${e.symbol.padEnd(6)} ${e.direction.padEnd(4)} ` +
      `${e.size_shares.toFixed(5).padStart(12)} sh @ $${e.price_usd.toFixed(2).padStart(9)} ` +
      `= $${e.notional_usd.toFixed(2).padStart(12)}  x${e.multiplier}` +
      (e.cap_breach ? "  [CAP BREACH]" : ""),
  );
}

// The dollar figures on the tape must be recomputable from the raw amounts by
// anyone, which is what makes the tape verifiable rather than merely published.
let mismatches = 0;
for (const e of entries) {
  const recomputed = Number(e.quote_raw_amount) / 1e6;
  if (Math.abs(recomputed - e.notional_usd) > 1e-6) {
    console.log(`  MISMATCH ${e.signature}: tape ${e.notional_usd} vs raw ${recomputed}`);
    mismatches += 1;
  }
}
console.log(
  mismatches === 0
    ? "\nevery dollar figure recomputes from the raw amounts"
    : `\n${mismatches} entries do not reconcile`,
);
