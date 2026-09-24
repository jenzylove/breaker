// Every tokenized stock with a Solana mint, and whether it can trade right now,
// according to its issuer.
//
// The issuer (xStocks) publishes a halt flag and a trading period per stock:
// market, extended, overnight, closed. When a stock is closed its own maximum
// order value is zero; the issuer refuses to trade it. A liquidity pool on
// Solana has no such brake. This endpoint is the real source a halt publisher
// would mirror on chain.

export const config = { runtime: "edge" };

const REGISTRY = "https://api.xstocks.fi/api/v2/public/assets";
const MAX_PAGES = 20;

export interface StockRow {
  symbol: string;
  name: string;
  underlying: string;
  mint: string;
  exchange: string | null;
  /** market | extended | overnight | closed | unknown */
  period: string;
  halted: boolean;
  /** What a venue enforcing the issuer's own rules would do right now. */
  canTrade: boolean;
}

interface RegistryNode {
  symbol?: string;
  name?: string;
  underlyingSymbol?: string;
  isTradingHalted?: boolean;
  deployments?: { network?: string; address?: string }[];
  trading?: {
    isTradingHalted?: boolean;
    currentPeriod?: string;
    openNow?: boolean;
    exchange?: { abbreviation?: string; mic?: string };
    limitsPerPeriod?: Record<string, { maxOrderFiatValue?: number }>;
  };
}

async function page(n: number): Promise<RegistryNode[] | null> {
  try {
    const response = await fetch(`${REGISTRY}?page=${n}`, {
      // The registry rejects requests with no user agent.
      headers: { "user-agent": "Mozilla/5.0 (compatible; Breaker/1.0)" },
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { nodes?: RegistryNode[] };
    return json.nodes ?? [];
  } catch {
    return null;
  }
}

export default async function handler(): Promise<Response> {
  const pages = await Promise.all(Array.from({ length: MAX_PAGES }, (_, i) => page(i)));
  const failed = pages.filter((p) => p === null).length;

  const bySymbol = new Map<string, StockRow>();
  for (const nodes of pages) {
    for (const n of nodes ?? []) {
      const solana = (n.deployments ?? []).find(
        (d) => (d.network ?? "").toLowerCase() === "solana" && d.address,
      );
      if (!solana?.address || !n.symbol) continue;

      const t = n.trading ?? {};
      const period = t.currentPeriod ?? "unknown";
      const halted = Boolean(n.isTradingHalted || t.isTradingHalted);
      // The issuer's own ceiling for this period. Zero means it will not trade.
      const ceiling = t.limitsPerPeriod?.[period]?.maxOrderFiatValue;
      const canTrade = !halted && period !== "closed" && ceiling !== 0;

      bySymbol.set(n.symbol, {
        symbol: n.symbol,
        name: n.name ?? n.symbol,
        underlying: n.underlyingSymbol ?? n.symbol,
        mint: solana.address,
        exchange: t.exchange?.abbreviation ?? t.exchange?.mic ?? null,
        period,
        halted,
        canTrade,
      });
    }
  }

  const rows = [...bySymbol.values()].sort((a, b) => {
    // Halted first, then closed, then the rest; alphabetical within each.
    const rank = (r: StockRow) => (r.halted ? 0 : !r.canTrade ? 1 : 2);
    return rank(a) - rank(b) || a.symbol.localeCompare(b.symbol);
  });

  const body = {
    source: "xStocks issuer registry",
    generated_at: new Date().toISOString(),
    total: rows.length,
    halted: rows.filter((r) => r.halted).length,
    closed: rows.filter((r) => !r.halted && !r.canTrade).length,
    trading: rows.filter((r) => r.canTrade).length,
    // Pages the registry would not serve. A reader should know the list may
    // be short rather than assume it is everything.
    incomplete: failed > 0,
    stocks: rows,
  };

  return new Response(JSON.stringify(body), {
    status: rows.length === 0 ? 502 : 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=600",
      "access-control-allow-origin": "*",
    },
  });
}
