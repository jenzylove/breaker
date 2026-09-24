import { useEffect, useMemo, useState } from "react";
import { Ban, Check, Moon, Search } from "lucide-react";

interface StockRow {
  symbol: string;
  name: string;
  underlying: string;
  mint: string;
  exchange: string | null;
  period: string;
  halted: boolean;
  canTrade: boolean;
}

interface Registry {
  total: number;
  halted: number;
  closed: number;
  trading: number;
  incomplete: boolean;
  generated_at: string;
  stocks: StockRow[];
}

type Filter = "all" | "halted" | "closed" | "trading";

const PAGE = 40;

function status(row: StockRow): { label: string; tone: string; Icon: typeof Check } {
  if (row.halted) return { label: "Halted", tone: "stop", Icon: Ban };
  if (!row.canTrade) return { label: "Market closed", tone: "idle", Icon: Moon };
  const label = row.period === "market" ? "Trading" : `Trading, ${row.period} hours`;
  return { label, tone: "go", Icon: Check };
}

/** Token-2022 Pausable extension (type 26): 32-byte authority, then the flag. */
function isPaused(base64: string): boolean {
  const d = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const view = new DataView(d.buffer);
  for (let o = 166; o + 4 <= d.length; ) {
    const type = view.getUint16(o, true);
    const len = view.getUint16(o + 2, true);
    if (type === 26) return d[o + 4 + 32] === 1;
    o += 4 + len;
  }
  return false;
}

/** How many of the issuer's halted stocks are actually paused on Solana. */
async function countPaused(stocks: { mint: string | null; halted: boolean }[]): Promise<number | null> {
  const mints = stocks.filter((s) => s.halted && s.mint).map((s) => s.mint as string);
  if (mints.length === 0) return 0;
  const reply = await fetch("/api/rpc?cluster=mainnet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [mints, { encoding: "base64" }],
    }),
  });
  const accounts = (await reply.json())?.result?.value as ({ data: [string, string] } | null)[] | undefined;
  if (!accounts) return null;
  return accounts.filter((a) => a && isPaused(a.data[0])).length;
}

export default function Coverage() {
  const [data, setData] = useState<Registry | null>(null);
  const [failed, setFailed] = useState(false);
  const [paused, setPaused] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    fetch("/api/stocks")
      .then((r) => r.json())
      .then((d: Registry) => {
        setData(d);
        countPaused(d.stocks)
          .then(setPaused)
          .catch(() => undefined);
      })
      .catch(() => setFailed(true));
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.stocks.filter((s) => {
      if (filter === "halted" && !s.halted) return false;
      if (filter === "closed" && (s.halted || s.canTrade)) return false;
      if (filter === "trading" && !s.canTrade) return false;
      if (!q) return true;
      return (
        s.symbol.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.underlying.toLowerCase().includes(q)
      );
    });
  }, [data, filter, query]);

  useEffect(() => setShown(PAGE), [filter, query]);

  const filters: { key: Filter; label: string; count: number | undefined }[] = [
    { key: "all", label: "All", count: data?.total },
    { key: "halted", label: "Halted", count: data?.halted },
    { key: "closed", label: "Market closed", count: data?.closed },
    { key: "trading", label: "Trading", count: data?.trading },
  ];

  return (
    <section className="section coverage" id="coverage">
      <div className="wrap">
        <div className="section-head section-head--center" data-reveal>
          <span className="beat">Coverage</span>
          <h2>Every xStocks token, live</h2>
          <p>
            The issuer's own status for all of them. When one is halted or closed, the issuer stops
            trading it. Pools do not.
          </p>
        </div>

        <div className="tally" data-reveal>
          <div className="tally-cell">
            <strong>{data ? data.total.toLocaleString() : "…"}</strong>
            <span>stock tokens covered</span>
          </div>
          <div className="tally-cell tally-cell--stop">
            <strong>{data ? data.halted.toLocaleString() : "…"}</strong>
            <span>halted by their issuer right now</span>
          </div>
          <div className="tally-cell">
            <strong>{paused ?? "…"}</strong>
            <span>of those paused on Solana</span>
          </div>
        </div>

        <div className="ledger" data-reveal>
          <div className="coverage-bar">
            <div className="coverage-search">
              <Search size={15} aria-hidden />
              <input
                type="search"
                placeholder="Search Tesla, NVDAx, SPY…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search tokenized stocks"
              />
            </div>
            <div className="coverage-filters" role="tablist">
              {filters.map((f) => (
                <button
                  key={f.key}
                  role="tab"
                  aria-selected={filter === f.key}
                  className={`chip-filter ${filter === f.key ? "is-on" : ""}`}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                  {typeof f.count === "number" ? <span>{f.count.toLocaleString()}</span> : null}
                </button>
              ))}
            </div>
          </div>

          {!data ? (
            <div className="empty">
              {failed ? "The issuer's registry could not be reached." : "Reading the issuer's registry…"}
            </div>
          ) : rows.length === 0 ? (
            <div className="empty">Nothing matches that.</div>
          ) : (
            <>
              <div className="table-scroll coverage-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Stock</th>
                      <th>Company</th>
                      <th>Listed on</th>
                      <th>Status from the issuer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, shown).map((s) => {
                      const st = status(s);
                      return (
                        <tr key={s.mint}>
                          <td className="ticker">{s.symbol}</td>
                          <td className="coverage-name">{s.name.replace(/ xStock$/i, "")}</td>
                          <td className="sub">{s.exchange ?? "Unknown"}</td>
                          <td>
                            <span className={`verdict verdict--${st.tone}`}>
                              <st.Icon size={13} strokeWidth={2.3} aria-hidden />
                              {st.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {shown < rows.length ? (
                <button className="coverage-more" onClick={() => setShown((n) => n + PAGE * 2)}>
                  Show more · {(rows.length - shown).toLocaleString()} left
                </button>
              ) : null}
            </>
          )}
        </div>

        {data?.incomplete ? (
          <p className="coverage-note">
            Some pages of the registry did not load, so this list may be short.
          </p>
        ) : null}
      </div>
    </section>
  );
}
