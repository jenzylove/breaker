// The public tape.
//
// The order requires a Tokenized Securities Venue to make dollar denominated
// transaction data "freely and publicly available in machine-readable format"
// within ten minutes of every fill, carrying symbol, price, size, timestamp and
// direction along with pool details.
//
// This endpoint rebuilds that tape from chain data on every request, so it is
// current to the last confirmed slot rather than to whenever some indexer last
// ran. Nothing here is privileged: the same rows can be reconstructed by anyone
// reading the program's logs.

import { tapeEntriesFromLogs, type TapeEntry } from "../src/lib/tape";

export const config = { runtime: "edge" };

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const BREAKER_PROGRAM =
  process.env.BREAKER_PROGRAM_ID ?? "EdTGUwJPq5RNy4RjLRzKYbajtkDzaim3MYiPi8yB9obe";

const MAX_TRANSACTIONS = 60;
const RPC_TIMEOUT_MS = 9_000;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RPC ${method} returned ${response.status}`);
    const json = (await response.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? `RPC ${method} failed`);
    return json.result as T;
  } finally {
    clearTimeout(timeout);
  }
}

interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, MAX_TRANSACTIONS);
  const symbolFilter = url.searchParams.get("symbol")?.toUpperCase();

  let entries: TapeEntry[] = [];
  let error: string | null = null;

  try {
    const signatures = await rpc<SignatureInfo[]>("getSignaturesForAddress", [
      BREAKER_PROGRAM,
      { limit },
    ]);

    // A reverted transaction produced no fill, so it has no place on the tape.
    const landed = signatures.filter((s) => !s.err);

    const transactions = await Promise.all(
      landed.map(async (info) => {
        try {
          const tx = await rpc<{ meta?: { logMessages?: string[] } } | null>("getTransaction", [
            info.signature,
            { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
          ]);
          const logs = tx?.meta?.logMessages ?? [];
          return tapeEntriesFromLogs(logs, { signature: info.signature, slot: info.slot });
        } catch {
          // One unreadable transaction must not blank the whole tape.
          return [];
        }
      }),
    );

    entries = transactions.flat().sort((a, b) => b.slot - a.slot);
    if (symbolFilter) entries = entries.filter((e) => e.symbol.toUpperCase() === symbolFilter);
  } catch (e) {
    error = e instanceof Error ? e.message : "Unable to read the chain";
  }

  const body = {
    venue_program: BREAKER_PROGRAM,
    cluster: RPC.includes("devnet") ? "devnet" : RPC.includes("mainnet") ? "mainnet-beta" : "custom",
    generated_at: new Date().toISOString(),
    // Stated so a reader knows the guarantee rather than inferring it.
    freshness: "rebuilt from chain on request; current to the last confirmed slot",
    schema: [
      "symbol",
      "timestamp",
      "price_usd",
      "size_shares",
      "notional_usd",
      "direction",
      "pool",
      "venue",
      "mint",
      "quote_mint",
      "base_raw_amount",
      "quote_raw_amount",
      "multiplier",
      "cap_breach",
      "signature",
      "slot",
    ],
    count: entries.length,
    transactions: entries,
    ...(error ? { error } : {}),
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: error && entries.length === 0 ? 502 : 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Public by mandate, and short lived so it stays inside the ten minutes.
      "cache-control": "public, max-age=15, stale-while-revalidate=60",
      "access-control-allow-origin": "*",
    },
  });
}
