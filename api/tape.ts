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

/** The order asks for every transaction of the past 30 days to be available. */
const WINDOW_DAYS = 30;
/** getSignaturesForAddress returns at most 1,000 per page. */
const PAGE = 1000;
const MAX_PAGES = 20;
/** Uncached transactions decoded per request; the rest are reported unread
 *  and picked up by the next request. */
const MAX_DECODE = 160;
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

/** Some providers reject batched JSON-RPC on their free tier (Helius returns
 *  403 with "Batch requests are only available for paid plans"). Detected once
 *  per instance, then every later call goes straight to singles. */
let batchSupported: boolean | null = null;

async function rpcOne<T>(call: RpcCall): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...call }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { result?: T; error?: unknown };
    return json.error ? null : ((json.result ?? null) as T | null);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function rpcBatch<T>(calls: RpcCall[]): Promise<(T | null)[]> {
  if (calls.length === 0) return [];

  if (batchSupported === false) {
    return Promise.all(calls.map((call) => rpcOne<T>(call)));
  }

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
    const json = (await response.json().catch(() => null)) as
      | { id: number; result?: T; error?: { message?: string } }[]
      | { error?: { message?: string; code?: number } }
      | null;

    // A provider that will not batch says so once; fall back and remember.
    if (!Array.isArray(json)) {
      batchSupported = false;
      clearTimeout(timeout);
      return Promise.all(calls.map((call) => rpcOne<T>(call)));
    }
    if (!response.ok) throw new Error(`RPC returned ${response.status}`);
    batchSupported = true;

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
  blockTime?: number | null;
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get("limit") ?? 0);
  const limit = limitParam > 0 ? Math.floor(limitParam) : null;
  const cutoff = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86_400;

  let scanned = 0;
  let reachedWindowStart = false;
  let error: string | null = null;
  let landedSignatures: string[] = [];

  try {
    // Page back through the pool program's history until the window starts.
    const signatures: SignatureInfo[] = [];
    let before: string | undefined;
    for (let page = 0; page < MAX_PAGES && !reachedWindowStart; page += 1) {
      const [batch] = await rpcBatch<SignatureInfo[]>([
        { method: "getSignaturesForAddress", params: [POOL_PROGRAM, { limit: PAGE, ...(before ? { before } : {}) }] },
      ]);
      if (!batch) throw new Error("Could not list the program's transactions");
      for (const info of batch) {
        if (info.blockTime && info.blockTime < cutoff) {
          reachedWindowStart = true;
          break;
        }
        signatures.push(info);
      }
      if (batch.length < PAGE) reachedWindowStart = true;
      before = batch[batch.length - 1]?.signature;
    }

    // A reverted transaction produced no fill, so it has no place here.
    const landed = signatures.filter((s) => !s.err);
    scanned = landed.length;
    landedSignatures = landed.map((s) => s.signature);

    // Only signatures we have never resolved cost an RPC call.
    const pending = landed.filter((s) => !decoded.has(s.signature)).slice(0, MAX_DECODE);

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
  const inWindow = new Set(landedSignatures);
  const entries = [...decoded.entries()]
    .filter(([signature]) => inWindow.has(signature))
    .flatMap(([, rows]) => rows)
    .sort((a, b) => b.slot - a.slot);
  const symbolFilter = url.searchParams.get("symbol")?.toUpperCase() ?? null;
  const matched = symbolFilter
    ? entries.filter((e) => e.symbol.toUpperCase() === symbolFilter)
    : entries;
  const rows = limit ? matched.slice(0, limit) : matched;

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
    // The window this record covers. It is complete only when paging reached
    // the start of the window and every transaction in it was read.
    window: {
      days: WINDOW_DAYS,
      from: new Date(cutoff * 1000).toISOString(),
      to: new Date().toISOString(),
      reached_start: reachedWindowStart,
    },
    scanned,
    // Transactions this request could not read. Zero once the cache warms.
    unread,
    complete: error === null && unread === 0 && reachedWindowStart,
    total_in_window: matched.length,
    count: rows.length,
    transactions: rows,
    ...(error ? { error } : {}),
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: rows.length === 0 && error ? 502 : 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=20, s-maxage=30, stale-while-revalidate=120",
      "access-control-allow-origin": "*",
    },
  });
}
