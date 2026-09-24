import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVENT_DISCRIMINATORS,
  base58,
  decodeTradeRecorded,
  tapeEntriesFromLogs,
} from "./tape";

/** Anchor's rule: sha256("event:<Name>")[..8]. */
function derive(name: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(`event:${name}`).digest().subarray(0, 8));
}

/** Builds a TradeRecorded payload matching the program's field order. */
function encodeTradeRecorded(overrides: Partial<{
  ticker: string;
  side: number;
  sharesNano: bigint;
  baseRaw: bigint;
  quoteRaw: bigint;
  usdMicros: bigint;
  priceMicros: bigint;
  multiplierE9: bigint;
  capShares: bigint;
  windowShares: bigint;
  firstBreach: boolean;
  timestamp: bigint;
}> = {}): Uint8Array {
  const o = {
    ticker: "TSLAx",
    side: 0,
    sharesNano: 148_613_470_000n,
    baseRaw: 10_000_000_000n,
    quoteRaw: 29_702_970_297n,
    usdMicros: 29_702_970_297n,
    priceMicros: 199_866_000n,
    multiplierE9: 1_486_134_700n,
    capShares: 200_000_000_000n,
    windowShares: 148_613_470_000n,
    firstBreach: false,
    timestamp: 1_790_000_000n,
    ...overrides,
  };

  const parts: number[] = [...EVENT_DISCRIMINATORS.TradeRecorded];
  const pushKey = (fill: number) => {
    for (let i = 0; i < 32; i += 1) parts.push(fill);
  };
  const pushU64 = (v: bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    parts.push(...b);
  };
  const pushI64 = (v: bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, v, true);
    parts.push(...b);
  };

  pushKey(1); // venue
  pushKey(2); // symbol account
  const t = new Uint8Array(8);
  t.set(new TextEncoder().encode(o.ticker).subarray(0, 8));
  parts.push(...t);
  pushKey(3); // mint
  pushKey(4); // pool
  pushKey(5); // quote mint
  parts.push(o.side);
  pushU64(o.sharesNano);
  pushU64(o.baseRaw);
  pushU64(o.quoteRaw);
  pushU64(o.usdMicros);
  pushU64(o.priceMicros);
  pushU64(o.multiplierE9);
  pushU64(o.capShares);
  pushU64(o.windowShares);
  parts.push(o.firstBreach ? 1 : 0);
  pushI64(o.timestamp);

  return Uint8Array.from(parts);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

describe("event discriminators", () => {
  it("match what Anchor derives, so a renamed event fails here", () => {
    for (const [name, pinned] of Object.entries(EVENT_DISCRIMINATORS)) {
      expect(Array.from(pinned), name).toEqual(Array.from(derive(name)));
    }
  });
});

describe("decodeTradeRecorded", () => {
  const context = { signature: "sig", slot: 42 };

  it("reads every field the order requires on the tape", () => {
    const entry = decodeTradeRecorded(encodeTradeRecorded(), context)!;
    expect(entry).not.toBeNull();
    expect(entry.symbol).toBe("TSLAx");
    expect(entry.direction).toBe("buy");
    expect(entry.size_shares).toBeCloseTo(148.61347, 5);
    expect(entry.notional_usd).toBeCloseTo(29702.970297, 6);
    expect(entry.price_usd).toBeCloseTo(199.866, 3);
    expect(entry.timestamp).toBe(new Date(1_790_000_000_000).toISOString());
    expect(entry.signature).toBe("sig");
    expect(entry.slot).toBe(42);
  });

  it("reports the multiplier actually in force, not a normalised 1.0", () => {
    const entry = decodeTradeRecorded(encodeTradeRecorded(), context)!;
    expect(entry.multiplier).toBeCloseTo(1.4861347, 7);
    // The share count is the raw amount scaled by that multiplier, which is
    // what stops a venue understating its own volume by 48.61%.
    expect(entry.size_shares / (Number(entry.base_raw_amount) / 1e8)).toBeCloseTo(1.4861347, 6);
  });

  it("flags a fill that crossed the cap", () => {
    const entry = decodeTradeRecorded(encodeTradeRecorded({ firstBreach: true }), context)!;
    expect(entry.cap_breach).toBe(true);
  });

  it("reads the sell direction", () => {
    const entry = decodeTradeRecorded(encodeTradeRecorded({ side: 1 }), context)!;
    expect(entry.direction).toBe("sell");
  });

  it("ignores payloads belonging to other events", () => {
    const other = Uint8Array.from([...EVENT_DISCRIMINATORS.HaltChanged, 0, 0, 0, 0]);
    expect(decodeTradeRecorded(other, context)).toBeNull();
  });

  it("ignores a truncated payload rather than inventing a row", () => {
    expect(decodeTradeRecorded(Uint8Array.from([1, 2, 3]), context)).toBeNull();
  });
});

describe("tapeEntriesFromLogs", () => {
  it("extracts only the trade events from a mixed log", () => {
    const logs = [
      "Program EdTGUwJPq5RNy4RjLRzKYbajtkDzaim3MYiPi8yB9obe invoke [2]",
      `Program data: ${toBase64(encodeTradeRecorded({ ticker: "NVDAx" }))}`,
      `Program data: ${toBase64(Uint8Array.from([...EVENT_DISCRIMINATORS.CapBreached, 9]))}`,
      "Program log: not an event",
      `Program data: ${toBase64(encodeTradeRecorded({ ticker: "AAPLx", side: 1 }))}`,
    ];
    const entries = tapeEntriesFromLogs(logs, { signature: "s", slot: 1 });
    expect(entries.map((e) => e.symbol)).toEqual(["NVDAx", "AAPLx"]);
    expect(entries[1].direction).toBe("sell");
  });

  it("survives a log line that is not valid base64", () => {
    const entries = tapeEntriesFromLogs(["Program data: !!!not-base64!!!"], {
      signature: "s",
      slot: 1,
    });
    expect(entries).toEqual([]);
  });
});

describe("base58", () => {
  it("preserves leading zero bytes as ones", () => {
    expect(base58(Uint8Array.from([0, 0, 1]))).toBe("112");
  });
});
