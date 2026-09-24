// The demo exchange's halt publisher.
//
// A real venue mirrors its listing exchanges continuously; the program treats a
// feed that has gone quiet as untrustworthy and stops trading rather than guess.
// That is correct, and it means this demo needs a heartbeat or the board reads
// as broken an hour after seeding.
//
// The page calls this on load, so the feed is fresh whenever anyone is looking.
// Each call is four devnet transactions costing a few thousand lamports.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

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

// sha256("global:set_halt")[..8]
const SET_HALT = Buffer.from([212, 192, 179, 66, 23, 73, 197, 15]);

/** Refuse to re-publish more often than this; the tolerance is an hour. */
const MIN_INTERVAL_MS = 4 * 60 * 1000;
let lastRun = 0;

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({
  pubkey,
  isWritable,
  isSigner,
});

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const now = Date.now();
  if (now - lastRun < MIN_INTERVAL_MS) {
    return response.status(200).json({ skipped: true, reason: "published recently" });
  }

  const raw = process.env.DEMO_KEYPAIR;
  if (!raw) return response.status(503).json({ error: "No publisher key configured." });

  let publisher: Keypair;
  try {
    publisher = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    return response.status(503).json({ error: "Publisher key could not be read." });
  }

  lastRun = now;
  const connection = new Connection(RPC, "confirmed");
  const venue = new PublicKey(venueConfig.venue);

  try {
    const tx = new Transaction();
    for (const listing of venueConfig.listings) {
      // Republishes the state the exchange is actually in, which keeps NVIDIA
      // halted rather than quietly reopening it.
      const halted = listing.state === "halted";
      tx.add(
        new TransactionInstruction({
          programId: new PublicKey(venueConfig.breaker),
          keys: [
            meta(venue),
            meta(new PublicKey(listing.halt_state), true),
            meta(publisher.publicKey, false, true),
          ],
          data: Buffer.concat([SET_HALT, Buffer.from([halted ? 1 : 0])]),
        }),
      );
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = publisher.publicKey;
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.sign(publisher);

    const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    return response.status(200).json({
      published: venueConfig.listings.length,
      signature,
    });
  } catch (error) {
    lastRun = 0; // let the next visitor retry
    return response.status(502).json({
      error: error instanceof Error ? error.message : "Could not publish.",
    });
  }
}
