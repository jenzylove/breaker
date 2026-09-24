import { describe, expect, it } from "vitest";
import { capShares, decodeHaltState, decodeSymbol, toRow, type SymbolState } from "./venue";

const SHARE = 1_000_000_000n;

function encodeSymbol(o: Partial<{
  ticker: string;
  tier: number;
  decimals: number;
  advShares: bigint;
  windowStart: bigint;
  windowShares: bigint;
  breachCount: number;
  pausedUntil: bigint;
}> = {}): Uint8Array {
  const v = {
    ticker: "TSLAx",
    tier: 1,
    decimals: 8,
    advShares: 80_000n * SHARE,
    windowStart: 1_000n,
    windowShares: 148_613_470_000n,
    breachCount: 0,
    pausedUntil: 0n,
    ...o,
  };
  const parts: number[] = [1, 2, 3, 4, 5, 6, 7, 8]; // account discriminator
  const key = (fill: number) => {
    for (let i = 0; i < 32; i += 1) parts.push(fill);
  };
  const u64 = (n: bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    parts.push(...b);
  };
  const i64 = (n: bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, n, true);
    parts.push(...b);
  };
  key(1); // venue
  key(2); // mint
  const t = new Uint8Array(8);
  t.set(new TextEncoder().encode(v.ticker).subarray(0, 8));
  parts.push(...t);
  parts.push(v.tier, v.decimals);
  u64(v.advShares);
  i64(0n); // adv_updated_at
  i64(v.windowStart);
  u64(v.windowShares);
  parts.push(v.breachCount & 0xff, (v.breachCount >> 8) & 0xff);
  i64(v.pausedUntil);
  parts.push(9); // bump
  return Uint8Array.from(parts);
}

function encodeHalt(halted: boolean, updatedAt: bigint, maxAge: bigint): Uint8Array {
  const parts: number[] = [1, 2, 3, 4, 5, 6, 7, 8];
  for (let i = 0; i < 64; i += 1) parts.push(1); // venue + symbol
  parts.push(halted ? 1 : 0);
  const i64 = (n: bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, n, true);
    parts.push(...b);
  };
  i64(updatedAt);
  i64(maxAge);
  parts.push(7);
  return Uint8Array.from(parts);
}

const base = (o = {}) => decodeSymbol("sym", encodeSymbol(o));
const healthy = (now: number) => decodeHaltState("halt", encodeHalt(false, BigInt(now), 120n));

describe("decodeSymbol", () => {
  it("reads the listing and its volume window", () => {
    const s = base();
    expect(s.ticker).toBe("TSLAx");
    expect(s.tier).toBe(1);
    expect(s.decimals).toBe(8);
    expect(s.advShares).toBe(80_000);
    expect(s.windowShares).toBeCloseTo(148.61347, 5);
    expect(s.breachCount).toBe(0);
  });
});

describe("capShares", () => {
  it("is a quarter percent of ADV for Tier 1", () => {
    expect(capShares(80_000, 1)).toBe(200);
  });
  it("is two and a half percent for Tier 2", () => {
    expect(capShares(80_000, 2)).toBe(2_000);
  });
});

describe("toRow status", () => {
  const now = 2_000;

  it("reports trading when the feed is fresh and there is headroom", () => {
    const row = toRow(base(), healthy(now), now);
    expect(row.status).toBe("trading");
    expect(row.headroomShares).toBeCloseTo(200 - 148.61347, 5);
    expect(row.capUsed).toBeCloseTo(0.743, 3);
  });

  it("reports halted above everything else", () => {
    const halt = decodeHaltState("h", encodeHalt(true, BigInt(now), 120n));
    const row = toRow(base({ pausedUntil: BigInt(now + 999) }), halt, now);
    expect(row.status).toBe("halted");
  });

  it("reports a stale feed rather than claiming the symbol trades", () => {
    const halt = decodeHaltState("h", encodeHalt(false, BigInt(now - 121), 120n));
    expect(toRow(base(), halt, now).status).toBe("stale");
  });

  it("reports a breach pause with the days remaining", () => {
    const row = toRow(base({ pausedUntil: BigInt(now + 86_400 * 3) }), healthy(now), now);
    expect(row.status).toBe("paused");
    expect(row.statusDetail).toContain("3 more days");
  });

  it("reports an unconfigured symbol when no ADV has been published", () => {
    const row = toRow(base({ advShares: 0n }), healthy(now), now);
    expect(row.status).toBe("unconfigured");
  });

  it("reports unconfigured when there is no halt state at all", () => {
    expect(toRow(base(), null, now).status).toBe("unconfigured");
  });

  it("treats an expired window as fresh headroom", () => {
    const later = 1_000 + 86_400;
    const row = toRow(base(), healthy(later), later);
    expect(row.windowShares).toBeCloseTo(148.61347, 5);
    expect(row.capUsed).toBe(0);
    expect(row.headroomShares).toBe(200);
  });

  it("reports capped once the cap is gone and a breach is on record", () => {
    const row = toRow(
      base({ windowShares: 300n * SHARE, breachCount: 1 }),
      healthy(now),
      now,
    );
    expect(row.status).toBe("capped");
    expect(row.headroomShares).toBe(0);
  });

  it("does not report capped while the first exceedance is still available", () => {
    const row = toRow(base({ windowShares: 300n * SHARE, breachCount: 0 }), healthy(now), now);
    expect(row.status).toBe("trading");
  });
});
