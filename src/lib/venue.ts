// Decodes the venue's on chain compliance state.
//
// The dashboard reads these accounts directly rather than trusting a server,
// because the whole argument of this project is that a venue's compliance
// posture should be verifiable by anyone holding an RPC endpoint.

import { base58 } from "./tape";

export const TIER1_CAP_BPS = 25;
export const TIER2_CAP_BPS = 250;
const SHARE_SCALE = 1_000_000_000;

export interface SymbolState {
  address: string;
  venue: string;
  mint: string;
  ticker: string;
  tier: 1 | 2;
  decimals: number;
  /** Prior month average daily volume, in shares. */
  advShares: number;
  advUpdatedAt: number;
  windowStart: number;
  /** Shares traded in the current window. */
  windowShares: number;
  breachCount: number;
  pausedUntil: number;
}

export interface HaltState {
  address: string;
  symbol: string;
  halted: boolean;
  updatedAt: number;
  maxAgeSeconds: number;
}

/** What the dashboard shows for one listed symbol. */
export interface SymbolRow extends SymbolState {
  halt: HaltState | null;
  /** Share cap for the current window. */
  capShares: number;
  /** Fraction of the cap consumed, 0 to 1 and beyond on a breach. */
  capUsed: number;
  /** Shares still tradable before the cap binds. */
  headroomShares: number;
  status: SymbolStatus;
  statusDetail: string;
}

export type SymbolStatus = "trading" | "halted" | "stale" | "paused" | "unconfigured" | "capped";

class Reader {
  private offset = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  pubkey(): string {
    const slice = this.bytes.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return base58(slice);
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
  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u64(): number {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return Number(v);
  }
  i64(): number {
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return Number(v);
  }
}

function ticker(raw: Uint8Array): string {
  let end = raw.indexOf(0);
  if (end === -1) end = raw.length;
  return new TextDecoder().decode(raw.subarray(0, end));
}

export function decodeSymbol(address: string, data: Uint8Array): SymbolState {
  const r = new Reader(data.subarray(8));
  const venue = r.pubkey();
  const mint = r.pubkey();
  const symbolTicker = ticker(r.fixed(8));
  const tier = r.u8();
  const decimals = r.u8();
  const advShares = r.u64();
  const advUpdatedAt = r.i64();
  const windowStart = r.i64();
  const windowShares = r.u64();
  const breachCount = r.u16();
  const pausedUntil = r.i64();
  return {
    address,
    venue,
    mint,
    ticker: symbolTicker,
    tier: tier === 2 ? 2 : 1,
    decimals,
    advShares: advShares / SHARE_SCALE,
    advUpdatedAt,
    windowStart,
    windowShares: windowShares / SHARE_SCALE,
    breachCount,
    pausedUntil,
  };
}

export function decodeHaltState(address: string, data: Uint8Array): HaltState {
  const r = new Reader(data.subarray(8));
  r.pubkey(); // venue
  const symbol = r.pubkey();
  const halted = r.bool();
  const updatedAt = r.i64();
  const maxAgeSeconds = r.i64();
  return { address, symbol, halted, updatedAt, maxAgeSeconds };
}

export function capShares(advShares: number, tier: 1 | 2): number {
  const bps = tier === 1 ? TIER1_CAP_BPS : TIER2_CAP_BPS;
  return (advShares * bps) / 10_000;
}

/**
 * Resolves what a venue operator actually needs to see: whether this symbol can
 * trade right now, and why not when it cannot.
 *
 * The ordering matches the program, so the dashboard never claims a symbol is
 * tradable when the guard would reject it, or names a different binding reason
 * than the one the chain would give.
 */
export function toRow(symbol: SymbolState, halt: HaltState | null, now: number): SymbolRow {
  const cap = capShares(symbol.advShares, symbol.tier);
  const windowExpired = now - symbol.windowStart >= 86_400;
  const used = windowExpired ? 0 : symbol.windowShares;
  const capUsed = cap > 0 ? used / cap : 0;
  const headroomShares = Math.max(cap - used, 0);

  let status: SymbolStatus = "trading";
  let statusDetail = "mirroring the listing exchange";

  if (!halt) {
    status = "unconfigured";
    statusDetail = "no halt state published";
  } else if (halt.halted) {
    status = "halted";
    statusDetail = "halted on the primary listing exchange";
  } else if (now - halt.updatedAt > halt.maxAgeSeconds) {
    status = "stale";
    statusDetail = `halt feed ${now - halt.updatedAt}s old, fails closed`;
  } else if (now < symbol.pausedUntil) {
    const days = Math.ceil((symbol.pausedUntil - now) / 86_400);
    status = "paused";
    statusDetail = `paused ${days} more days after a cap breach`;
  } else if (symbol.advShares === 0) {
    status = "unconfigured";
    statusDetail = "no average daily volume published";
  } else if (symbol.breachCount > 0 && headroomShares === 0) {
    status = "capped";
    statusDetail = "cap consumed and a breach is already on record";
  }

  return { ...symbol, halt, capShares: cap, capUsed, headroomShares, status, statusDetail };
}
