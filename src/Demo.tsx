import { useState } from "react";
import { ArrowUpRight, Ban, Check, Loader2 } from "lucide-react";

interface Outcome {
  ticker: string;
  guarded: boolean;
  refused: boolean;
  reason: string | null;
  signature: string;
  explorer: string;
}

async function sendOrder(guarded: boolean): Promise<Outcome> {
  const response = await fetch("/api/demo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticker: "NVDAx", guarded }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The order could not be sent.");
  return data as Outcome;
}

export default function Demo() {
  const [running, setRunning] = useState(false);
  const [pair, setPair] = useState<{ ordinary?: Outcome; breaker?: Outcome } | null>(null);
  const [failure, setFailure] = useState<{ side: "ordinary" | "breaker"; message: string } | null>(
    null,
  );

  // One at a time: both orders share a signer and a pool, so sending them
  // together makes them collide and one silently drops.
  const run = async () => {
    setRunning(true);
    setPair(null);
    setFailure(null);
    let side: "ordinary" | "breaker" = "ordinary";
    try {
      setPair({});
      const ordinary = await sendOrder(false);
      setPair({ ordinary });
      side = "breaker";
      const breaker = await sendOrder(true);
      setPair({ ordinary, breaker });
    } catch (error) {
      setFailure({
        side,
        message: error instanceof Error ? error.message : "The order could not be sent.",
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="demo" id="demo">
      <div className="wrap">
        <div className="section-head section-head--center">
          <span className="beat">See it work</span>
          <h2>Send the same order through a halt, twice</h2>
          <p>
            We run a small reference venue on Solana's test network so you can watch the check act.
            Press the button and one NVIDIA order goes to two versions of it: an ordinary pool, and
            one that asks Breaker first. For the length of each transaction we raise a halt on
            NVIDIA, the way a publisher would when its exchange stops trading.
          </p>
        </div>

        <div className="run run--center">
          <button className="pill pill--solid" onClick={run} disabled={running}>
            {running ? <Loader2 size={15} className="spin" /> : null}
            {running ? "Sending both orders…" : "Send the order to both"}
          </button>
          <span className="run-note">No wallet needed. Both land on chain where you can open them.</span>
        </div>

        {pair ? (
          <div className="versus">
            <article className="side side--bad">
              <div className="side-head">
                <Check size={16} aria-hidden />
                Ordinary pool
              </div>
              {pair.ordinary ? (
                <>
                  <strong>{pair.ordinary.refused ? "Refused" : "Filled"}</strong>
                  <p>
                    {pair.ordinary.refused
                      ? "It refused, which means the halt reached it some other way."
                      : "It settled with the halt raised. A pool has no idea a halt exists, so it prices the order as if nothing happened."}
                  </p>
                  <a className="link" href={pair.ordinary.explorer} target="_blank" rel="noreferrer">
                    Open the transaction <ArrowUpRight size={13} />
                  </a>
                </>
              ) : failure?.side === "ordinary" ? (
                <p className="side-failed">{failure.message}</p>
              ) : (
                <p className="side-waiting">Sending…</p>
              )}
            </article>

            <article className="side side--good">
              <div className="side-head">
                <Ban size={16} aria-hidden />
                Pool running Breaker
              </div>
              {pair.breaker ? (
                <>
                  <strong>{pair.breaker.refused ? "Refused" : "Filled"}</strong>
                  <p>
                    {pair.breaker.refused
                      ? (pair.breaker.reason ?? "Breaker refused the order.")
                      : "It settled, which means the halt did not reach the check."}
                  </p>
                  <a className="link" href={pair.breaker.explorer} target="_blank" rel="noreferrer">
                    Open the transaction <ArrowUpRight size={13} />
                  </a>
                </>
              ) : failure?.side === "breaker" ? (
                <p className="side-failed">{failure.message}</p>
              ) : failure ? (
                <p className="side-waiting">Not sent.</p>
              ) : (
                <p className="side-waiting">Waiting for the first order to settle…</p>
              )}
            </article>
          </div>
        ) : null}

        {pair?.breaker ? (
          <div className="consequence">
            <h3>What the first order actually bought</h3>
            <div className="consequence-grid">
              <div>
                <strong>13h 10m</strong>
                <span>
                  The median length of a news-pending halt. Tokenized stocks trade around the
                  clock, so an ordinary pool quotes a dead price for all of it.
                </span>
              </div>
              <div>
                <strong>40 to 70%</strong>
                <span>
                  How far a reopening auction can clear from the last price before the halt. A stock
                  is halted because something is about to move it.
                </span>
              </div>
              <div>
                <strong>$0</strong>
                <span>
                  The issuer's own maximum order when a stock is closed. It will not trade. The pool
                  above just did.
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
