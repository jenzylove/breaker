// Checks the browser-side Token-2022 TLV decoder against real mainnet mints.
//
// The extension offsets are hand rolled so no token library ships to the
// browser, which makes them exactly the kind of thing that is silently wrong.
// This walks every extension on each mint, prints what it found, and compares
// the multiplier it decodes against @solana/spl-token's own reading.

import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, getScaledUiAmountConfig, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const RPC = process.env.SOLANA_MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC, "confirmed");

const MINTS = [
  ["TSLAx", "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"],
  ["NVDAx", "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"],
  ["AAPLx", "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"],
  ["SPYx", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"],
];

/** The decoder as written for the browser. */
function readScaledUiAmount(data, extensionType) {
  if (data.length < 166) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 166;
  const seen = [];
  while (offset + 4 <= data.length) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const body = offset + 4;
    if (body + length > data.length) break;
    seen.push({ type, length });
    if (type === extensionType) {
      return {
        seen,
        multiplier: view.getFloat64(body + 32, true),
        activation: Number(view.getBigInt64(body + 40, true)),
        newMultiplier: view.getFloat64(body + 48, true),
      };
    }
    offset = body + length;
  }
  return { seen, multiplier: null };
}

let failures = 0;

for (const [ticker, address] of MINTS) {
  const mint = new PublicKey(address);
  const info = await connection.getAccountInfo(mint, "confirmed");
  const data = Uint8Array.from(info.data);

  // Ground truth from the library.
  const parsed = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const truth = getScaledUiAmountConfig(parsed);

  // Find which extension type actually carries it, rather than assuming.
  let matchedType = null;
  let decoded = null;
  for (let candidate = 0; candidate < 40; candidate += 1) {
    const attempt = readScaledUiAmount(data, candidate);
    if (attempt?.multiplier !== null && attempt?.multiplier !== undefined) {
      if (Math.abs(attempt.multiplier - truth.multiplier) < 1e-12) {
        matchedType = candidate;
        decoded = attempt;
        break;
      }
    }
  }

  const ok =
    decoded &&
    Math.abs(decoded.multiplier - truth.multiplier) < 1e-12 &&
    Math.abs(decoded.newMultiplier - truth.newMultiplier) < 1e-12 &&
    decoded.activation === Number(truth.newMultiplierEffectiveTimestamp);

  if (!ok) failures += 1;

  console.log(
    `${ticker.padEnd(7)} ${ok ? "OK " : "BAD"}  extension type=${matchedType}  ` +
      `mult=${truth.multiplier}  new=${truth.newMultiplier}`,
  );
  if (decoded) {
    console.log(
      `${"".padEnd(7)}      decoded mult=${decoded.multiplier} new=${decoded.newMultiplier} ` +
        `activation=${decoded.activation}`,
    );
    console.log(
      `${"".padEnd(7)}      extensions present: ${decoded.seen.map((s) => s.type).join(", ")}`,
    );
  }
}

console.log(failures === 0 ? "\nall mints decode correctly" : `\n${failures} mints decoded wrong`);
process.exit(failures === 0 ? 0 : 1);
