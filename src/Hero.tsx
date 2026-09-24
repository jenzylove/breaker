import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";

interface Counts {
  total: number;
  halted: number;
  paused: number | null;
}

interface Stock {
  mint: string | null;
  halted: boolean;
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
async function countPaused(stocks: Stock[]): Promise<number | null> {
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

// Bold and still. The headline carries the idea; the strip underneath carries
// the evidence, read live from the issuer on every visit.
export default function Hero({ onEnter }: { onEnter: () => void }) {
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    fetch("/api/stocks")
      .then((r) => r.json())
      .then(async (d) => {
        if (typeof d.total !== "number") return;
        setCounts({ total: d.total, halted: d.halted, paused: null });
        const paused = await countPaused(d.stocks as Stock[]).catch(() => null);
        setCounts({ total: d.total, halted: d.halted, paused });
      })
      .catch(() => undefined);
  }, []);

  return (
    <section className="hero">
      <div className="hero-body">
        <div className="hero-center">
          <a className="hero-note" href="#why">
            <span>New</span>
            The SEC let real US stocks trade on chain from 17 September
          </a>
          <h1>
            Stock tokens don't know
            <br />
            when trading <span className="hero-mark">halts</span>
          </h1>
          <p className="hero-sub">
            When Nasdaq halts a stock, pools trading its token keep filling orders. Breaker is one call
            a venue adds so they stop too.
          </p>
          <div className="hero-actions">
            <button className="pill pill--solid" onClick={onEnter}>
              Try it on devnet <ArrowRight size={15} />
            </button>
            <a className="pill" href="#why">
              Why this matters
            </a>
          </div>
        </div>

        <div className="hero-strip">
          <div>
            <strong>{counts ? counts.total.toLocaleString() : "…"}</strong>
            <span>stock tokens covered</span>
          </div>
          <div>
            <strong className="is-halt">{counts ? counts.halted : "…"}</strong>
            <span>halted by their issuer right now</span>
          </div>
          <div>
            <strong>{counts && counts.paused !== null ? counts.paused : "…"}</strong>
            <span>of those paused on Solana</span>
          </div>
          <div>
            <strong>1</strong>
            <span>call for a venue to add</span>
          </div>
        </div>
      </div>
    </section>
  );
}
