export const config = { runtime: "edge" };

const HERMES = "https://hermes.pyth.network";

type Feed = { id: string; attributes?: { symbol?: string } };
type ParsedFeed = {
  id: string;
  price?: { price?: string; expo?: number; publish_time?: number };
};

function readFeeds(payload: unknown): Feed[] {
  if (Array.isArray(payload)) return payload as Feed[];
  if (!payload || typeof payload !== "object") return [];
  const value = payload as { feeds?: unknown; price_feeds?: unknown; data?: unknown };
  for (const candidate of [value.feeds, value.price_feeds, value.data]) {
    if (Array.isArray(candidate)) return candidate as Feed[];
  }
  return [];
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  const search = new URL(request.url).searchParams;
  const symbol = search.get("symbol")?.toUpperCase() ?? "";
  if (!/^[A-Z0-9.]{1,12}$/.test(symbol)) return json({ status: "UNAVAILABLE", reason: "Invalid equity symbol" }, 400);
  const apiKey = process.env.PYTH_API_KEY;
  if (!apiKey) return json({ status: "UNAVAILABLE", reason: "PYTH_API_KEY is not configured" }, 503);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  const headers = { accept: "application/json", authorization: `Bearer ${apiKey}` };
  try {
    const underlying = search.get("underlying")?.toUpperCase() ?? symbol;
    if (!/^[A-Z0-9.]{1,12}$/.test(underlying)) return json({ status: "UNAVAILABLE", reason: "Invalid underlying symbol" }, 400);
    const token = `${symbol}X`;
    const [equityResponse, tokenResponse] = await Promise.all([
      fetch(`${HERMES}/v2/price_feeds?query=${encodeURIComponent(`Equity.US.${underlying}`)}`, { headers, signal: controller.signal }),
      fetch(`${HERMES}/v2/price_feeds?query=${encodeURIComponent(`Crypto.${token}`)}`, { headers, signal: controller.signal }),
    ]);
    if (!equityResponse.ok || !tokenResponse.ok) return json({ status: "UNAVAILABLE", reason: "Pyth feed directory unavailable" }, 502);
    const equityFeeds = readFeeds(await equityResponse.json());
    const tokenFeeds = readFeeds(await tokenResponse.json());
    const equity = equityFeeds.find((feed) => feed.attributes?.symbol === `Equity.US.${underlying}/USD`);
    const tokenFeed = tokenFeeds.find((feed) => {
      const feedSymbol = feed.attributes?.symbol;
      return feedSymbol === `Crypto.${token}/USD` || feedSymbol === `Crypto.${token}/${underlying}`;
    });
    if (!equity || !tokenFeed) return json({ status: "UNAVAILABLE", reason: "Matching Pyth feeds were not found" }, 404);

    const latestUrl = `${HERMES}/v2/updates/price/latest?parsed=true&ids[]=${equity.id}&ids[]=${tokenFeed.id}`;
    const latestResponse = await fetch(latestUrl, { headers, signal: controller.signal });
    if (!latestResponse.ok) return json({ status: "UNAVAILABLE", reason: "Pyth latest prices unavailable" }, 502);
    const latest = (await latestResponse.json()) as { parsed?: ParsedFeed[] };
    const prices = new Map((latest.parsed ?? []).map((feed) => [feed.id, feed.price]));
    const equityPrice = prices.get(equity.id);
    const tokenPrice = prices.get(tokenFeed.id);
    if (!equityPrice?.price || equityPrice.expo === undefined || !tokenPrice?.price || tokenPrice.expo === undefined) {
      return json({ status: "UNAVAILABLE", reason: "Pyth response did not contain parsed prices" }, 502);
    }
    const underlyingPrice = Number(equityPrice.price) * 10 ** equityPrice.expo;
    const tokenObserved = Number(tokenPrice.price) * 10 ** tokenPrice.expo;
    const feedKind = tokenFeed.attributes?.symbol?.endsWith(`/${underlying}`) ? "REDEMPTION_RATE" : "USD";
    const tokenized = feedKind === "REDEMPTION_RATE" ? tokenObserved * underlyingPrice : tokenObserved;
    const parityBps = feedKind === "REDEMPTION_RATE" ? (tokenObserved - 1) * 10_000 : ((tokenized / underlyingPrice) - 1) * 10_000;
    const publishTime = Math.min(equityPrice.publish_time ?? 0, tokenPrice.publish_time ?? 0);
    const stale = publishTime > 0 && Math.floor(Date.now() / 1000) - publishTime > 120;
    return json({
      status: stale ? "STALE" : Math.abs(parityBps) > 100 ? "DRIFT" : "MATCH",
      underlyingPrice,
      tokenizedPrice: tokenized,
      parityBps,
      publishTime,
      feedKind,
      feedSymbols: [equity.attributes?.symbol, tokenFeed.attributes?.symbol],
    });
  } catch {
    return json({ status: "UNAVAILABLE", reason: "Pyth request timed out" }, 504);
  } finally {
    clearTimeout(timeout);
  }
}
