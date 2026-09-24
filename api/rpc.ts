export const config = { runtime: "edge" };

const upstream = process.env.SOLANA_RPC_URL ?? "https://solana-rpc.publicnode.com";
const ALLOWED_METHODS = new Set(["getAccountInfo", "getMultipleAccounts", "getSlot"]);
const MAX_BODY_BYTES = 64 * 1024;

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }

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
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return new Response("A single JSON-RPC request is required", { status: 400 });
  }
  const method = (payload as { method?: unknown }).method;
  if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
    return new Response("JSON-RPC method is not allowed", { status: 403 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
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
