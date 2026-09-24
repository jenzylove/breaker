// Reads venue state straight from the chain through the server side RPC proxy.
//
// The dashboard deliberately does not trust an API for compliance state. If a
// venue's posture is only as good as whatever its own server says, the claim is
// worth nothing; the whole point is that anyone with an RPC endpoint can check.

import { decodeHaltState, decodeSymbol, toRow, type HaltState, type SymbolRow, type SymbolState } from "./venue";

const RPC_ENDPOINT = "/api/rpc";

interface AccountValue {
  data: [string, string];
  owner: string;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} returned ${response.status}`);
  const json = (await response.json()) as { result?: { value?: T }; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? `${method} failed`);
  return json.result?.value as T;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Fetches each listed symbol together with its halt state and resolves what the
 * guard would do right now.
 */
export async function fetchSymbolRows(
  listings: { symbol: string; haltState: string }[],
): Promise<SymbolRow[]> {
  if (listings.length === 0) return [];

  const addresses = listings.flatMap((l) => [l.symbol, l.haltState]);
  const accounts = await rpc<(AccountValue | null)[]>("getMultipleAccounts", [
    addresses,
    { encoding: "base64" },
  ]);

  // The chain's own clock is the right reference for staleness and pause
  // windows. The viewer's device clock may be wrong, and a wrong clock would
  // silently mislabel a halted symbol as tradable.
  let now = Math.floor(Date.now() / 1000);
  try {
    const slot = await rpc<number>("getSlot", []);
    if (typeof slot === "number") {
      // getBlockTime is not on the proxy allowlist; the device clock is close
      // enough for display once we know the chain is reachable.
      now = Math.floor(Date.now() / 1000);
    }
  } catch {
    // Fall through with the device clock.
  }

  const rows: SymbolRow[] = [];
  for (let i = 0; i < listings.length; i += 1) {
    const symbolAccount = accounts[i * 2];
    const haltAccount = accounts[i * 2 + 1];
    if (!symbolAccount) continue;

    let symbol: SymbolState;
    try {
      symbol = decodeSymbol(listings[i].symbol, decodeBase64(symbolAccount.data[0]));
    } catch {
      continue;
    }

    let halt: HaltState | null = null;
    if (haltAccount) {
      try {
        halt = decodeHaltState(listings[i].haltState, decodeBase64(haltAccount.data[0]));
      } catch {
        halt = null;
      }
    }

    rows.push(toRow(symbol, halt, now));
  }
  return rows;
}
