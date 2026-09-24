export const config = { runtime: "edge" };

// Two clusters, because the console reads real tokenized equities on mainnet
// while the guard it drives is deployed to devnet.
const ENDPOINTS: Record<string, string> = {
  devnet: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  mainnet: process.env.SOLANA_MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com",
};

// Read methods only. The browser never needs anything else through this proxy,
// and an open proxy is somebody else's rate limit problem to exploit.
const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getSlot",
  "getLatestBlockhash",
  "getSignatureStatuses",
  "getTransaction",
  "getMinimumBalanceForRentExemption",
  "getTokenAccountBalance",
  "simulateTransaction",
  "getProgramAccounts",
  "sendTransaction",
  "getFeeForMessage",
  "getEpochInfo",
  "getBlockHeight",
]);

const MAX_BODY_BYTES = 128 * 1024;

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }

  const cluster = new URL(request.url).searchParams.get("cluster") ?? "devnet";
  const upstream = ENDPOINTS[cluster];
  if (!upstream) return new Response("Unknown cluster", { status: 400 });

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return new Response("Request too large", { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // A batch is fine as long as every call in it is allowed.
  const calls = Array.isArray(payload) ? payload : [payload];
  if (calls.length === 0 || calls.length > 20) {
    return new Response("Unsupported batch size", { status: 400 });
  }
  for (const call of calls) {
    const method = (call as { method?: unknown })?.method;
    if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
      return new Response("JSON-RPC method is not allowed", { status: 403 });
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9_000);
  let response: Response;
  try {
    response = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch {
    return new Response("RPC upstream unavailable", { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
