import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Ban, Check, Loader2, Lock, PauseCircle, TriangleAlert } from "lucide-react";
import venueConfig, { type DemoListing } from "./lib/demo-venue";
import { decodeHaltState, decodeSymbol, toRow, type SymbolRow } from "./lib/venue";

const LISTINGS: DemoListing[] = venueConfig.listings;

/** The stock the story is told through: halted on its home exchange. */
const SUBJECT = "NVDAx";

interface Outcome {
  ticker: string;
  guarded: boolean;
  refused: boolean;
  reason: string | null;
  signature: string;
  explorer: string;
}

/** What a trade would do right now, said the way a person would say it. */
function verdict(
  row: SymbolRow | undefined,
  readFailed: boolean,
): { label: string; tone: string; Icon: typeof Check } {
  if (!row) {
    return readFailed
      ? { label: "Could not read the chain", tone: "warn", Icon: TriangleAlert }
      : { label: "Loading", tone: "muted", Icon: Loader2 };
  }
  switch (row.status) {
    case "halted":
      return { label: "Halted on its exchange", tone: "stop", Icon: Ban };
    case "stale":
      return { label: "Price feed went quiet", tone: "warn", Icon: TriangleAlert };
    case "paused":
      return { label: "Frozen after going over", tone: "warn", Icon: PauseCircle };
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

async function sendTrade(ticker: string, guarded: boolean): Promise<Outcome> {
  const response = await fetch("/api/demo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticker, guarded }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The trade could not be sent.");
  return data as Outcome;
}

export default function Demo() {
  const [rows, setRows] = useState<Record<string, SymbolRow>>({});
  const [readFailed, setReadFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const [pair, setPair] = useState<{ without?: Outcome; with?: Outcome } | null>(null);
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
      setReadFailed(false);
    } catch {
      // Say so rather than leaving every card on "Loading" forever. The board
      // keeps whatever it last read successfully.
      setReadFailed(true);
    }
  }, []);

  useEffect(() => {
    // Nudge the halt publisher first. Without a heartbeat the program treats
    // the feed as stale and every stock reads as untrustworthy, which is the
    // rule working correctly but looks like a broken board.
    fetch("/api/heartbeat", { method: "POST" })
      .catch(() => undefined)
      .finally(load);
    const id = setInterval(load, 25_000);
    return () => clearInterval(id);
  }, [load]);

  /**
   * Fires the same trade at both exchanges. Run one at a time rather than in
   * parallel: they share a signer, so concurrent sends collide on the same
   * blockhash and one silently drops.
   */
  const runBoth = async () => {
    setRunning(true);
    setPair(null);
    setFailure(null);
    try {
      const without = await sendTrade(SUBJECT, false);
      setPair({ without });
      const withGuard = await sendTrade(SUBJECT, true);
      setPair({ without, with: withGuard });
      load();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setRunning(false);
    }
  };

  const subject = rows[SUBJECT];

  return (
    <section className="demo" id="demo">
      <div className="wrap">
        {/* ---------------------------------------------------- beat one */}
        <div className="section-head">
          <span className="beat">Step one</span>
          <h2>NVIDIA is halted on this exchange</h2>
          <p>
            A live exchange on Solana's test network with four stocks listed. Every figure below is
            read from the blockchain.
          </p>
          <p className="provenance">
            To be clear about where the halt comes from: a real venue would run a publisher that
            mirrors Nasdaq's halt feed. This demo has no Nasdaq connection. We publish the halt
            ourselves so you can watch the guard act on it. What is real is the enforcement, which
            happens on chain and refuses the trade whatever the source.
          </p>
        </div>

        <div className="board">
          {LISTINGS.map((listing) => {
            const row = rows[listing.ticker];
            const v = verdict(row, readFailed);
            const used = row ? Math.min(row.capUsed, 1) : 0;
            const over = row ? Math.max(Math.min(row.capUsed - 1, 1), 0) : 0;

            return (
              <article
                className={`stock stock--${v.tone} ${listing.ticker === SUBJECT ? "stock--subject" : ""}`}
                key={listing.ticker}
              >
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
                {row && row.status === "paused" ? (
                  <p className="stock-frozen">
                    Went over its daily limit twice, so it cannot trade for three months. That is
                    the penalty the order sets.
                  </p>
                ) : (
                  <div className="stock-limit">
                    <span className="stock-limit-label">How much it may still trade today</span>
                    <div className="meter-track">
                      <div className="meter-fill" style={{ width: `${used * 100}%` }} />
                      {over > 0 ? (
                        <div className="meter-over" style={{ width: `${over * 100}%` }} />
                      ) : null}
                    </div>
                    <div className="meter-label">
                      <span>
                        {row
                          ? `${Math.round(row.headroomShares).toLocaleString()} of ${Math.round(row.capShares).toLocaleString()} shares left`
                          : readFailed
                            ? "unavailable"
                            : "reading…"}
                      </span>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>

        {/* ---------------------------------------------------- beat two */}
        <div className="section-head section-head--step">
          <span className="beat">Step two</span>
          <h2>Buy it on two exchanges at once</h2>
          <p>
            The same order for NVIDIA, sent at the same moment to two exchanges. One runs Breaker
            before it settles. The other is an ordinary liquidity pool, which is what every
            tokenized stock trades through today. No wallet needed, and both transactions land on
            the blockchain where you can open them.
          </p>
        </div>

        <div className="run">
          <button className="pill pill--solid" onClick={runBoth} disabled={running}>
            {running ? <Loader2 size={15} className="spin" /> : null}
            {running ? "Sending both orders…" : "Send the order to both"}
          </button>
          {subject && subject.status !== "halted" ? (
            <span className="run-note">
              NVIDIA is currently open on this exchange, so both orders will settle. Wait for the
              publisher to halt it again to see the difference.
            </span>
          ) : null}
        </div>

        {failure ? <div className="notice notice--bad">{failure}</div> : null}

        {pair ? (
          <div className="versus">
            <article className="side side--bad">
              <div className="side-head">
                <Check size={16} aria-hidden />
                Ordinary exchange
              </div>
              {pair.without ? (
                <>
                  <strong>Order filled</strong>
                  <p>
                    You now own NVIDIA bought at a price the pool set before the halt. It had no way
                    to know the price was dead.
                  </p>
                  <a className="link" href={pair.without.explorer} target="_blank" rel="noreferrer">
                    Open the transaction <ArrowUpRight size={13} />
                  </a>
                </>
              ) : (
                <p className="side-waiting">Sending…</p>
              )}
            </article>

            <article className="side side--good">
              <div className="side-head">
                <Ban size={16} aria-hidden />
                Exchange running Breaker
              </div>
              {pair.with ? (
                <>
                  <strong>{pair.with.refused ? "Order refused" : "Order filled"}</strong>
                  <p>
                    {pair.with.refused
                      ? (pair.with.reason ?? "The exchange refused this order.")
                      : "NVIDIA was open again by the time this ran, so it settled."}
                  </p>
                  <a className="link" href={pair.with.explorer} target="_blank" rel="noreferrer">
                    Open the transaction <ArrowUpRight size={13} />
                  </a>
                </>
              ) : (
                <p className="side-waiting">Sending…</p>
              )}
            </article>
          </div>
        ) : null}

        {/* -------------------------------------------------- beat three */}
        {pair?.with ? (
          <div className="consequence">
            <span className="beat">Step three</span>
            <h3>What the first order actually bought</h3>
            <div className="consequence-grid">
              <div>
                <strong>13 hours 10 minutes</strong>
                <span>
                  The median length of a news-pending halt. Tokenized stocks trade around the
                  clock, so an exchange with no check quotes a dead price for all of it.
                </span>
              </div>
              <div>
                <strong>40 to 70%</strong>
                <span>
                  How far the reopening price can land from the last one before the halt. A stock
                  is halted precisely because something is about to move it.
                </span>
              </div>
              <div>
                <strong>Every US exchange</strong>
                <span>
                  Already has to honour a halt from the listing exchange. That is Reg NMS. As of 17
                  September, tokenized venues do too.
                </span>
              </div>
            </div>
            <p className="consequence-close">
              The buyer on the ordinary exchange paid yesterday's number for something the market
              has already repriced. Whoever sold it to them knew. And on the real tokenized stocks
              trading on Solana today, the issuer can freeze or take back those tokens afterwards
              anyway, which no wallet tells you.
            </p>
          </div>
        ) : null}

        {/* ------------------------------------------------- the adoption */}
        <div className="adopt">
          <div>
            <h3>An exchange adds this with one call</h3>
            <p>
              Before the pool moves a token, it asks Breaker. Halted, stale, frozen or over the
              limit, and the entire trade is cancelled before anything settles. Nothing else in the
              pool changes.
            </p>
          </div>
          <div className="adopt-flow" aria-hidden>
            <span className="adopt-step">Order arrives</span>
            <span className="adopt-arrow">→</span>
            <span className="adopt-step adopt-step--check">Breaker</span>
            <span className="adopt-arrow">→</span>
            <span className="adopt-split">
              <span className="adopt-step adopt-step--go">Settles</span>
              <span className="adopt-step adopt-step--stop">Cancelled</span>
            </span>
          </div>
        </div>

        <p className="stakes">
          The reason an exchange will do this: go over a stock's daily limit twice and that stock is
          frozen for three months. Miss a halt and the exemption that makes any of this legal is
          gone.
        </p>
      </div>
    </section>
  );
}
