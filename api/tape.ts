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
/** Public RPC rate limits a burst of single calls, so transactions are read in
 *  batches. One request for many signatures instead of one each. */
const BATCH_SIZE = 20;

interface RpcCall {
  method: string;
  params: unknown[];
}

async function rpcBatch<T>(calls: RpcCall[]): Promise<(T | null)[]> {
  if (calls.length === 0) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        calls.map((call, i) => ({ jsonrpc: "2.0", id: i, method: call.method, params: call.params })),
      ),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`RPC returned ${response.status}`);
    const json = (await response.json()) as
      | { id: number; result?: T; error?: { message?: string } }[]
      | { error?: { message?: string } };

    if (!Array.isArray(json)) {
      throw new Error(json.error?.message ?? "RPC rejected the batch");
    }

    // A batch response may arrive out of order, so results are placed by id.
    const out: (T | null)[] = new Array(calls.length).fill(null);
    for (const item of json) {
      if (item && typeof item.id === "number" && !item.error) {
        out[item.id] = (item.result ?? null) as T | null;
      }
    }
    return out;
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
  let unread = 0;
  let scanned = 0;

  try {
    const [signatures] = await rpcBatch<SignatureInfo[]>([
      { method: "getSignaturesForAddress", params: [BREAKER_PROGRAM, { limit }] },
    ]);
    if (!signatures) throw new Error("Could not read the program's signatures");

    // A reverted transaction produced no fill, so it has no place on the tape.
    const landed = signatures.filter((s) => !s.err);
    scanned = landed.length;

    for (let i = 0; i < landed.length; i += BATCH_SIZE) {
      const slice = landed.slice(i, i + BATCH_SIZE);
      const results = await rpcBatch<{ meta?: { logMessages?: string[] } }>(
        slice.map((info) => ({
          method: "getTransaction",
          params: [info.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
        })),
      );

      results.forEach((tx, j) => {
        if (!tx) {
          // Count it rather than swallowing it. A tape that quietly reports
          // nothing when it could not read the chain is worse than an error.
          unread += 1;
          return;
        }
        entries.push(
          ...tapeEntriesFromLogs(tx.meta?.logMessages ?? [], {
            signature: slice[j].signature,
            slot: slice[j].slot,
          }),
        );
      });
    }

    entries.sort((a, b) => b.slot - a.slot);
    if (symbolFilter) entries = entries.filter((e) => e.symbol.toUpperCase() === symbolFilter);
  } catch (e) {
    error = e instanceof Error ? e.message : "Unable to read the chain";
  }

  const body = {
    venue_program: BREAKER_PROGRAM,
    cluster: RPC.includes("devnet") ? "devnet" : RPC.includes("mainnet") ? "mainnet-beta" : "custom",
    generated_at: new Date().toISOString(),
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
    /** Transactions examined, and how many could not be read. A reader can tell
     *  an empty tape from an unavailable one. */
    scanned,
    unread,
    complete: error === null && unread === 0,
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
