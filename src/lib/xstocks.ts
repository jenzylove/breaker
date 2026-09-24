// Real tokenized equities, read live from mainnet.
//
// The console lists these so an operator picks from assets that actually exist
// rather than a fixture, and so the multiplier trap is visible on real mints
// before anything is listed. Every figure here comes off chain.

const SCALED_UI_AMOUNT_EXTENSION = 25;

export interface XStock {
  ticker: string;
  name: string;
  mint: string;
  decimals: number;
  /** Supply in raw base units. */
  supply: bigint;
  /** The value sitting in the obvious `multiplier` field. */
  storedMultiplier: number;
  /** The value actually in force right now. */
  effectiveMultiplier: number;
  activationTimestamp: number;
  /** True when the stored field is not the one in force. */
  stale: boolean;
  /** How far a naive read would understate a position, in percent. */
  understatementPct: number;
}

/** The Solana mints for the most traded xStocks. */
export const XSTOCK_MINTS: { ticker: string; name: string; mint: string }[] = [
  { ticker: "TSLAx", name: "Tesla", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB" },
  { ticker: "NVDAx", name: "NVIDIA", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" },
  { ticker: "AAPLx", name: "Apple", mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp" },
  { ticker: "SPYx", name: "S&P 500", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W" },
  { ticker: "MSFTx", name: "Microsoft", mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX" },
  { ticker: "METAx", name: "Meta", mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu" },
  { ticker: "GOOGLx", name: "Alphabet", mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN" },
  { ticker: "AMZNx", name: "Amazon", mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg" },
];

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Walks the Token-2022 TLV extension list for the Scaled UI Amount config.
 *
 * A mint's base data is 82 bytes; extensions start at 165 after a one byte
 * account type. Each entry is a two byte type, a two byte length, then the
 * payload.
 */
function readScaledUiAmount(data: Uint8Array): {
  multiplier: number;
  newMultiplier: number;
  activation: number;
} | null {
  if (data.length < 166) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 166;
  while (offset + 4 <= data.length) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const body = offset + 4;
    if (body + length > data.length) return null;
    if (type === SCALED_UI_AMOUNT_EXTENSION) {
      // authority (32) · multiplier f64 · activation i64 · new multiplier f64
      return {
        multiplier: view.getFloat64(body + 32, true),
        activation: Number(view.getBigInt64(body + 40, true)),
        newMultiplier: view.getFloat64(body + 48, true),
      };
    }
    offset = body + length;
  }
  return null;
}

async function mainnetRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch("/api/rpc?cluster=mainnet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} returned ${response.status}`);
  const json = (await response.json()) as { result?: { value?: T }; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? `${method} failed`);
  return json.result?.value as T;
}

/** Reads every listed xStock in one call and resolves its live multiplier. */
export async function fetchXStocks(): Promise<XStock[]> {
  const accounts = await mainnetRpc<({ data: [string, string] } | null)[]>("getMultipleAccounts", [
    XSTOCK_MINTS.map((m) => m.mint),
    { encoding: "base64" },
  ]);

  const now = Math.floor(Date.now() / 1000);
  const out: XStock[] = [];

  for (let i = 0; i < XSTOCK_MINTS.length; i += 1) {
    const account = accounts?.[i];
    const entry = XSTOCK_MINTS[i];
    if (!account) continue;

    const data = decodeBase64(account.data[0]);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const supply = view.getBigUint64(36, true);
    const decimals = data[44];

    const scaled = readScaledUiAmount(data);
    if (!scaled) continue;

    // Once the activation timestamp has passed, the live value is the one that
    // is not in the obvious field.
    const effective = now >= scaled.activation ? scaled.newMultiplier : scaled.multiplier;
    const stale = effective !== scaled.multiplier;

    out.push({
      ticker: entry.ticker,
      name: entry.name,
      mint: entry.mint,
      decimals,
      supply,
      storedMultiplier: scaled.multiplier,
      effectiveMultiplier: effective,
      activationTimestamp: scaled.activation,
      stale,
      understatementPct:
        scaled.multiplier > 0 ? (effective / scaled.multiplier - 1) * 100 : 0,
    });
  }

  return out;
}
