// Decodes the dollar denominated tape the order requires a venue to publish
// within ten minutes of every fill.
//
// Anchor emits events as `Program data: <base64>` log lines whose payload is an
// eight byte event discriminator followed by Borsh encoded fields. Reading them
// back from transaction logs means the tape is reconstructible by anyone from
// chain data alone, which is the point: a venue that publishes a tape nobody
// can verify has not really published anything.
//
// Deliberately free of Buffer and node:crypto so the same decoder runs in the
// browser, in an edge function and under Node.

// Anchor derives an event discriminator as sha256("event:<Name>")[..8]. They are
// pinned here rather than hashed at runtime. A test re-derives them, so a
// renamed event fails the build instead of silently emptying the tape.
export const EVENT_DISCRIMINATORS = {
  TradeRecorded: Uint8Array.from([153, 142, 127, 129, 64, 214, 134, 138]),
  CapBreached: Uint8Array.from([12, 194, 86, 45, 91, 50, 190, 23]),
  HaltChanged: Uint8Array.from([152, 118, 17, 65, 125, 156, 41, 128]),
  SymbolPaused: Uint8Array.from([61, 14, 239, 168, 158, 14, 110, 39]),
  AdvPublished: Uint8Array.from([253, 186, 164, 221, 223, 47, 134, 248]),
} as const;

/** One row of the public tape, in the fields the order names. */
export interface TapeEntry {
  /** Ticker as listed by the venue, e.g. "TSLAx". */
  symbol: string;
  /** ISO 8601 UTC, per the order's timestamp requirement. */
  timestamp: string;
  /** Dollar price per share. */
  price_usd: number;
  /** Trade size in shares, adjusted for the mint's effective multiplier. */
  size_shares: number;
  /** Dollar value of the fill. */
  notional_usd: number;
  /** "buy" when the taker bought the equity token from the pool. */
  direction: "buy" | "sell";
  /** Liquidity pool the fill executed against. */
  pool: string;
  venue: string;
  mint: string;
  quote_mint: string;
  /** Raw amounts, so anyone can recompute the dollar figures independently. */
  base_raw_amount: string;
  quote_raw_amount: string;
  /** The Scaled UI Amount multiplier in force when the fill settled. */
  multiplier: number;
  /** True when this fill crossed the venue's volume cap. */
  cap_breach: boolean;
  signature: string;
  slot: number;
}

const SHARE_SCALE = 1_000_000_000;
const USD_SCALE = 1_000_000;
const MULTIPLIER_SCALE = 1_000_000_000;

function startsWith(payload: Uint8Array, prefix: Uint8Array): boolean {
  if (payload.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (payload[i] !== prefix[i]) return false;
  }
  return true;
}

class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  pubkey(): string {
    return base58(this.fixed(32));
  }

  fixed(len: number): Uint8Array {
    const slice = this.bytes.subarray(this.offset, this.offset + len);
    this.offset += len;
    return slice;
  }

  u8(): number {
    return this.bytes[this.offset++];
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u64(): bigint {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

/** Trims the trailing zero padding from a fixed width ticker. */
function ticker(raw: Uint8Array): string {
  let end = raw.indexOf(0);
  if (end === -1) end = raw.length;
  return new TextDecoder().decode(raw.subarray(0, end));
}

function fromBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  // Node without atob in scope.
  const buf = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
  if (buf) return Uint8Array.from(buf.from(value, "base64"));
  throw new Error("No base64 decoder available in this runtime");
}

/**
 * Decodes a single `TradeRecorded` payload. Returns null when the payload is
 * some other event, so callers do not have to pre-filter.
 */
export function decodeTradeRecorded(
  payload: Uint8Array,
  context: { signature: string; slot: number },
): TapeEntry | null {
  if (!startsWith(payload, EVENT_DISCRIMINATORS.TradeRecorded)) return null;

  const r = new Reader(payload.subarray(8));
  const venue = r.pubkey();
  r.pubkey(); // symbol account, addressed by ticker on the tape
  const symbolTicker = ticker(r.fixed(8));
  const mint = r.pubkey();
  const pool = r.pubkey();
  const quoteMint = r.pubkey();
  const side = r.u8();
  const sharesNano = r.u64();
  const baseRaw = r.u64();
  const quoteRaw = r.u64();
  const usdMicros = r.u64();
  const priceMicros = r.u64();
  const multiplierE9 = r.u64();
  r.u64(); // cap_shares, surfaced on the dashboard rather than the tape
  r.u64(); // window_shares, likewise
  const firstBreach = r.bool();
  const timestamp = r.i64();

  return {
    symbol: symbolTicker,
    timestamp: new Date(Number(timestamp) * 1000).toISOString(),
    price_usd: Number(priceMicros) / USD_SCALE,
    size_shares: Number(sharesNano) / SHARE_SCALE,
    notional_usd: Number(usdMicros) / USD_SCALE,
    // side 0 means the pool sold the equity token, so the taker bought it.
    direction: side === 0 ? "buy" : "sell",
    pool,
    venue,
    mint,
    quote_mint: quoteMint,
    base_raw_amount: baseRaw.toString(),
    quote_raw_amount: quoteRaw.toString(),
    multiplier: Number(multiplierE9) / MULTIPLIER_SCALE,
    cap_breach: firstBreach,
    signature: context.signature,
    slot: context.slot,
  };
}

/** Pulls every `Program data:` payload out of a transaction's logs. */
export function eventPayloads(logs: string[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const line of logs) {
    const match = /^Program data: (.+)$/.exec(line);
    if (!match) continue;
    try {
      out.push(fromBase64(match[1]));
    } catch {
      // A malformed log line is not worth failing the whole tape over.
    }
  }
  return out;
}

/** Decodes every tape entry in one transaction's logs. */
export function tapeEntriesFromLogs(
  logs: string[],
  context: { signature: string; slot: number },
): TapeEntry[] {
  return eventPayloads(logs)
    .map((payload) => decodeTradeRecorded(payload, context))
    .filter((entry): entry is TapeEntry => entry !== null);
}
