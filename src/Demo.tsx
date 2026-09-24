import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Ban, Check, Loader2, Lock, PauseCircle, TriangleAlert } from "lucide-react";
import venueConfig, { type DemoListing } from "./lib/demo-venue";
import { decodeHaltState, decodeSymbol, toRow, type SymbolRow } from "./lib/venue";

const EXPLORER = (id: string) => `https://explorer.solana.com/tx/${id}?cluster=devnet`;

const LISTINGS: DemoListing[] = venueConfig.listings;

interface Outcome {
  ticker: string;
  guarded: boolean;
  refused: boolean;
  reason: string | null;
  signature: string;
  explorer: string;
}

/** What a trade would do right now, said the way a person would say it. */
function verdict(row: SymbolRow | undefined): { label: string; tone: string; Icon: typeof Check } {
  if (!row) return { label: "Loading", tone: "muted", Icon: Loader2 };
  switch (row.status) {
    case "halted":
      return { label: "Halted on its exchange", tone: "stop", Icon: Ban };
    case "stale":
      return { label: "Price feed went quiet", tone: "warn", Icon: TriangleAlert };
    case "paused":
      return { label: "Paused after going over", tone: "warn", Icon: PauseCircle };
    case "capped":
      return { label: "Daily limit reached", tone: "warn", Icon: Lock };
    case "unconfigured":
      return { label: "Not set up", tone: "muted", Icon: TriangleAlert };
    default:
      return { label: "Open for trading", tone: "go", Icon: Check };
  }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch("/api/rpc?cluster=devnet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await response.json()) as { result?: { value?: T }; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result?.value as T;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export default function Demo() {
  const [rows, setRows] = useState<Record<string, SymbolRow>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const addresses = LISTINGS.flatMap((l) => [l.symbol, l.halt_state]);
      const accounts = await rpc<({ data: [string, string] } | null)[]>("getMultipleAccounts", [
        addresses,
        { encoding: "base64" },
      ]);
      const now = Math.floor(Date.now() / 1000);
      const next: Record<string, SymbolRow> = {};

      LISTINGS.forEach((listing, i) => {
        const symbolAccount = accounts?.[i * 2];
        const haltAccount = accounts?.[i * 2 + 1];
        if (!symbolAccount) return;
        try {
          const symbol = decodeSymbol(listing.symbol, decodeBase64(symbolAccount.data[0]));
          const halt = haltAccount
            ? decodeHaltState(listing.halt_state, decodeBase64(haltAccount.data[0]))
            : null;
          next[listing.ticker] = toRow(symbol, halt, now);
        } catch {
          // A row that will not decode is left out rather than guessed at.
        }
      });
      setRows(next);
    } catch {
      // The board falls back to the seeded description if the chain is
      // unreachable, rather than showing nothing.
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 25_000);
    return () => clearInterval(id);
  }, [load]);

  const attempt = async (ticker: string, guarded: boolean) => {
    setBusy(`${ticker}:${guarded}`);
    setOutcome(null);
    setFailure(null);
    try {
      const response = await fetch("/api/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker, guarded }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "The trade could not be sent.");
      setOutcome(data as Outcome);
      load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  const tradable = LISTINGS.filter((l) => l.pool);

  return (
    <section className="demo" id="demo">
      <div className="wrap">
        <div className="section-head">
          <h2>Try it on a stock that is halted</h2>
          <p>
            This is a live exchange on Solana test network with four stocks listed. NVIDIA is
            halted on its home exchange right now. Press the button and a real trade is sent. You
            do not need a wallet, and you can open every result on a block explorer.
          </p>
        </div>

        <div className="board">
          {LISTINGS.map((listing) => {
            const row = rows[listing.ticker];
            const v = verdict(row);
            const used = row ? Math.min(row.capUsed, 1) : 0;
            const over = row ? Math.max(Math.min(row.capUsed - 1, 1), 0) : 0;

            return (
              <article className={`stock stock--${v.tone}`} key={listing.ticker}>
                <header>
                  <div>
                    <div className="stock-ticker">{listing.ticker}</div>
                    <div className="stock-name">{listing.name}</div>
                  </div>
                  <span className={`verdict verdict--${v.tone}`}>
                    <v.Icon size={14} strokeWidth={2.3} aria-hidden />
                    {v.label}
                  </span>
                </header>

                <div className="stock-limit">
                  <div className="meter-track">
                    <div className="meter-fill" style={{ width: `${used * 100}%` }} />
                    {over > 0 ? <div className="meter-over" style={{ width: `${over * 100}%` }} /> : null}
                  </div>
                  <div className="meter-label">
                    <span>
                      {row ? `${(row.capUsed * 100).toFixed(0)}% of today's limit used` : "reading…"}
                    </span>
                  </div>
                </div>

                {listing.pool ? (
                  <button
                    className="btn btn--small"
                    onClick={() => attempt(listing.ticker, true)}
                    disabled={busy !== null}
                  >
                    {busy === `${listing.ticker}:true` ? (
                      <Loader2 size={13} className="spin" />
                    ) : null}
                    Try to trade {listing.ticker}
                  </button>
                ) : (
                  <span className="stock-note">No demo pool for this one</span>
                )}
              </article>
            );
          })}
        </div>

        {failure ? <div className="notice notice--bad">{failure}</div> : null}

        {outcome ? (
          <div className={`result ${outcome.refused ? "result--stopped" : "result--through"}`}>
            <div className="result-mark">
              {outcome.refused ? <Ban size={22} /> : <Check size={22} />}
            </div>
            <div>
              <h3>
                {outcome.refused
                  ? `The trade on ${outcome.ticker} was stopped`
                  : `The trade on ${outcome.ticker} went through`}
              </h3>
              <p>
                {outcome.refused
                  ? outcome.reason ?? "The exchange refused this trade."
                  : "Nothing checked it, so it settled. This is how a liquidity pool behaves today."}
              </p>
              <a className="link" href={outcome.explorer} target="_blank" rel="noreferrer">
                See it on the block explorer <ArrowUpRight size={13} />
              </a>
            </div>
          </div>
        ) : null}

        {tradable.length > 0 ? (
          <div className="compare-run">
            <div>
              <h3>Now run the same trade with the check turned off</h3>
              <p>
                Same pool, same maths, same stock. The only difference is whether anything asked
                permission first. This is what every liquidity pool on Solana does today.
              </p>
            </div>
            <button
              className="btn"
              onClick={() => attempt("NVDAx", false)}
              disabled={busy !== null}
            >
              {busy === "NVDAx:false" ? <Loader2 size={14} className="spin" /> : null}
              Trade NVDAx with no check
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
