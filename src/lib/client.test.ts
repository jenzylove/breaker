import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  BREAKER_PROGRAM,
  IX,
  POOL_IX,
  encodeTicker,
  explainError,
  haltPda,
  initializeVenue,
  listSymbol,
  setHalt,
  symbolPda,
  updateAdv,
  venuePda,
} from "./client";

/** Anchor's rule: sha256("global:<name>")[..8]. */
const derive = (name: string) =>
  Uint8Array.from(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));

const AUTHORITY = new PublicKey("ECXUxKxBKEMz3kLN2pDYBKRhNPvfdy3E55pLhkpVBgse");
const MINT = new PublicKey("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB");

describe("instruction discriminators", () => {
  it("match what Anchor derives, so a renamed instruction fails here", () => {
    for (const [name, pinned] of Object.entries(IX)) {
      expect(Array.from(pinned), name).toEqual(Array.from(derive(name)));
    }
    for (const [name, pinned] of Object.entries(POOL_IX)) {
      expect(Array.from(pinned), name).toEqual(Array.from(derive(name)));
    }
  });
});

describe("encodeTicker", () => {
  it("pads to the fixed eight bytes the account reserves", () => {
    const encoded = encodeTicker("TSLAx");
    expect(encoded.length).toBe(8);
    expect(Array.from(encoded.subarray(5))).toEqual([0, 0, 0]);
  });

  it("truncates rather than overflowing the field", () => {
    expect(encodeTicker("VERYLONGTICKER").length).toBe(8);
  });
});

describe("PDAs", () => {
  it("derive under the Breaker program", () => {
    const venue = venuePda(AUTHORITY);
    const symbol = symbolPda(venue, MINT);
    const halt = haltPda(symbol);
    for (const key of [venue, symbol, halt]) {
      expect(key).toBeInstanceOf(PublicKey);
      expect(key.toBase58()).toHaveLength(44);
    }
    // Distinct seeds must not collide.
    expect(new Set([venue, symbol, halt].map(String)).size).toBe(3);
  });

  it("are deterministic for the same inputs", () => {
    expect(venuePda(AUTHORITY).toBase58()).toBe(venuePda(AUTHORITY).toBase58());
  });
});

describe("instruction building", () => {
  it("targets the deployed program", () => {
    expect(initializeVenue(AUTHORITY).programId.equals(BREAKER_PROGRAM)).toBe(true);
  });

  it("puts the venue, payer and system program in the order the program expects", () => {
    const ix = initializeVenue(AUTHORITY);
    expect(ix.keys[0].pubkey.toBase58()).toBe(venuePda(AUTHORITY).toBase58());
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.toBase58()).toBe(AUTHORITY.toBase58());
    expect(ix.keys[1].isSigner).toBe(true);
    // Two publisher pubkeys follow the discriminator.
    expect(ix.data.length).toBe(8 + 32 + 32);
  });

  it("defaults both publisher roles to the operator", () => {
    const ix = initializeVenue(AUTHORITY);
    const halt = ix.data.subarray(8, 40);
    const adv = ix.data.subarray(40, 72);
    expect(Array.from(halt)).toEqual(Array.from(AUTHORITY.toBytes()));
    expect(Array.from(adv)).toEqual(Array.from(AUTHORITY.toBytes()));
  });

  it("encodes a listing with its ticker and tier", () => {
    const ix = listSymbol(AUTHORITY, MINT, "TSLAx", 1);
    expect(ix.data.length).toBe(8 + 8 + 1);
    expect(ix.data[16]).toBe(1);
    expect(ix.keys.some((k) => k.pubkey.equals(MINT))).toBe(true);
  });

  it("scales ADV from whole shares into nano-shares", () => {
    const venue = venuePda(AUTHORITY);
    const symbol = symbolPda(venue, MINT);
    const ix = updateAdv(venue, symbol, AUTHORITY, 80_000);
    const value = new DataView(
      ix.data.buffer,
      ix.data.byteOffset + 8,
      8,
    ).getBigUint64(0, true);
    expect(value).toBe(80_000n * 1_000_000_000n);
  });

  it("encodes the halt flag both ways", () => {
    const venue = venuePda(AUTHORITY);
    const symbol = symbolPda(venue, MINT);
    expect(setHalt(venue, symbol, AUTHORITY, true).data[8]).toBe(1);
    expect(setHalt(venue, symbol, AUTHORITY, false).data[8]).toBe(0);
  });

  it("addresses the halt account rather than the symbol when halting", () => {
    const venue = venuePda(AUTHORITY);
    const symbol = symbolPda(venue, MINT);
    const ix = setHalt(venue, symbol, AUTHORITY, true);
    expect(ix.keys[1].pubkey.toBase58()).toBe(haltPda(symbol).toBase58());
    expect(ix.keys[1].isWritable).toBe(true);
  });
});

describe("explainError", () => {
  it("turns a program log into something an operator can act on", () => {
    const logs = [
      "Program log: AnchorError thrown in programs/breaker/src/lib.rs:369. Error Code: SymbolHalted. Error Number: 6000. Error Message: halted.",
    ];
    expect(explainError(logs)).toEqual({
      code: "SymbolHalted",
      meaning: "Trading is halted on the primary listing exchange",
    });
  });

  it("still names an unmapped code rather than swallowing it", () => {
    const logs = ["Program log: Error Code: Mystery. Error Number: 9999."];
    expect(explainError(logs)?.code).toBe("Mystery");
    expect(explainError(logs)?.meaning).toBe("The guard refused this fill");
  });

  it("returns null when there is no error to explain", () => {
    expect(explainError(undefined)).toBeNull();
    expect(explainError(["Program log: success"])).toBeNull();
  });
});
