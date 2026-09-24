// The public trade record.
//
// The order requires a venue to publish dollar denominated transaction data
// within ten minutes of every fill, with symbol, price, size, timestamp and
// direction.
//
// Rebuilt from the chain rather than from a database, so anyone can check it.
// The difficulty is that public devnet RPC rate limits a burst of reads, and a
// trade record that flickers between "here are two trades" and "could not
// read" is worse than useless. So decoded trades are cached by signature and
// never re-fetched: after the first pass only new signatures cost anything.

import { tapeEntriesFromLogs, type TapeEntry } from "../src/lib/tape";

// Edge, not Node: the decoder is deliberately free of Buffer and node:crypto,
// and the edge runtime bundles imports rather than transpiling each file alone,
// which is what broke the cross-directory import in the demo function.
export const config = { runtime: "edge" };

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const BREAKER_PROGRAM =
  process.env.BREAKER_PROGRAM_ID ?? "EdTGUwJPq5RNy4RjLRzKYbajtkDzaim3MYiPi8yB9obe";
/** Signatures are listed from the pool, not the guard. Every halt and
 *  heartbeat touches the guard too, so listing there meant reading nineteen
 *  transactions to find two trades and getting rate limited for it. Trades
 *  only ever go through the pool. */
const POOL_PROGRAM = process.env.POOL_PROGRAM_ID ?? "4EWRfxyMmze3F3e9Lff84PK1W9L7EFGdKa147icdJLxU";

const MAX_SIGNATURES = 60;
const RPC_TIMEOUT_MS = 9_000;
const BATCH_SIZE = 8;
/** Signatures we have already resolved, so a reload costs nothing. Empty array
 *  means "read it, no trade in it" which is most of them: halts and heartbeats
 *  hit the same program. */
const decoded = new Map<string, TapeEntry[]>();

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

    if (!Array.isArray(json)) throw new Error(json.error?.message ?? "RPC rejected the batch");

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
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, MAX_SIGNATURES);

  let scanned = 0;
  let error: string | null = null;
  let landedSignatures: string[] = [];

  try {
    const [signatures] = await rpcBatch<SignatureInfo[]>([
      { method: "getSignaturesForAddress", params: [POOL_PROGRAM, { limit }] },
    ]);
    if (!signatures) throw new Error("Could not list the program's transactions");

    // A reverted transaction produced no fill, so it has no place here.
    const landed = signatures.filter((s) => !s.err);
    scanned = landed.length;
    landedSignatures = landed.map((s) => s.signature);

    // Only signatures we have never resolved cost an RPC call.
    const pending = landed.filter((s) => !decoded.has(s.signature));

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      if (i > 0) await new Promise((r) => setTimeout(r, 250));
      const slice = pending.slice(i, i + BATCH_SIZE);
      const results = await rpcBatch<{ meta?: { logMessages?: string[] } }>(
        slice.map((info) => ({
          method: "getTransaction",
          params: [info.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
        })),
      );

      const missing: { signature: string; slot: number }[] = [];
      results.forEach((tx, j) => {
        if (!tx) {
          missing.push(slice[j]);
          return;
        }
        decoded.set(
          slice[j].signature,
          tapeEntriesFromLogs(tx.meta?.logMessages ?? [], {
            signature: slice[j].signature,
            slot: slice[j].slot,
          }),
        );
      });

      // Edge instances are short lived, so the cache rarely survives between
      // requests. One retry after a pause recovers most rate limited reads
      // within the request that needs them.
      if (missing.length > 0) {
        await new Promise((r) => setTimeout(r, 600));
        const retried = await rpcBatch<{ meta?: { logMessages?: string[] } }>(
          missing.map((info) => ({
            method: "getTransaction",
            params: [info.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
          })),
        );
        retried.forEach((tx, k) => {
          if (!tx) return;
          decoded.set(
            missing[k].signature,
            tapeEntriesFromLogs(tx.meta?.logMessages ?? [], {
              signature: missing[k].signature,
              slot: missing[k].slot,
            }),
          );
        });
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Unable to read the chain";
  }

  // Honest accounting: unread is every landed transaction we do not have a
  // decoded result for, including ones a rate limit stopped us from ever
  // attempting. Counting only the retries that failed made a partial read
  // look complete.
  const resolved = landedSignatures.filter((sig) => decoded.has(sig));
  const unread = landedSignatures.length - resolved.length;

  // Everything resolved so far, newest first. Survives a failed refresh.
  const entries = [...decoded.values()].flat().sort((a, b) => b.slot - a.slot);
  const symbolFilter = url.searchParams.get("symbol")?.toUpperCase() ?? null;
  const rows = symbolFilter
    ? entries.filter((e) => e.symbol.toUpperCase() === symbolFilter)
    : entries;

  const body = {
    venue_program: BREAKER_PROGRAM,
    cluster: RPC.includes("devnet") ? "devnet" : "mainnet-beta",
    generated_at: new Date().toISOString(),
    freshness: "rebuilt from chain; resolved trades are cached by signature",
    schema: [
      "symbol", "timestamp", "price_usd", "size_shares", "notional_usd", "direction",
      "pool", "venue", "mint", "quote_mint", "base_raw_amount", "quote_raw_amount",
      "multiplier", "cap_breach", "signature", "slot",
    ],
    scanned,
    // Transactions this request could not read. Zero once the cache warms.
    unread,
    complete: unread === 0,
    count: rows.length,
    transactions: rows,
    ...(error ? { error } : {}),
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: rows.length === 0 && error ? 502 : 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=20, stale-while-revalidate=120",
      "access-control-allow-origin": "*",
    },
  });
}
