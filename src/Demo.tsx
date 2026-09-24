import { useState } from "react";
import { ArrowUpRight, Ban, Check, Loader2, Radio } from "lucide-react";

interface Outcome {
  ticker: string;
  guarded: boolean;
  halted: boolean;
  issuer_halted: boolean | null;
  refused: boolean;
  reason: string | null;
  signature: string;
  explorer: string;
}

type Step = "ordinary" | "breaker" | "clear";

async function sendOrder(guarded: boolean, halted: boolean): Promise<Outcome> {
  const response = await fetch("/api/demo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticker: "NVDAx", guarded, halted }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The order could not be sent.");
  return data as Outcome;
}

const PLAN: {
  step: Step;
  when: string;
  pool: string;
  expect: string;
  guarded: boolean;
  halted: boolean;
}[] = [
  {
    step: "ordinary",
    when: "During the halt",
    pool: "Ordinary pool",
    expect: "Should fill. It has no way to see the halt.",
    guarded: false,
    halted: true,
  },
  {
    step: "breaker",
    when: "During the halt",
    pool: "Pool running Breaker",
    expect: "Should be refused, with the reason.",
    guarded: true,
    halted: true,
  },
  {
    step: "clear",
    when: "After it lifts",
    pool: "Pool running Breaker",
    expect: "Should fill and appear in the public record below.",
    guarded: true,
    halted: false,
  },
];

/** What each card says once its order has landed. */
function explain(step: Step, o: Outcome): { verdict: string; tone: "bad" | "good"; body: string } {
  if (step === "ordinary") {
    return o.refused
      ? { verdict: "Refused", tone: "good", body: "It refused, which means the halt reached it some other way." }
      : {
          verdict: "Filled",
          tone: "bad",
          body: "It traded straight through the halt. An ordinary pool has no way of knowing one exists.",
        };
  }
  if (step === "breaker") {
    return o.refused
      ? { verdict: "Refused", tone: "good", body: o.reason ?? "Breaker refused the order." }
      : { verdict: "Filled", tone: "bad", body: "It settled, which means the halt did not reach the check." };
  }
  if (o.refused) {
    return {
      verdict: "Refused",
      tone: "good",
      body:
        o.issuer_halted === true
          ? "The issuer still shows NVIDIA as halted, so Breaker refused it again. That is the check working."
          : (o.reason ?? "Breaker refused the order."),
    };
  }
  return {
    verdict: "Filled and published",
    tone: "good",
    body: "Nothing was wrong, so Breaker let it through and wrote it to the public record below, in dollars.",
  };
}

export default function Demo({ onRecorded }: { onRecorded: (signature: string) => void }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Partial<Record<Step, Outcome>>>({});
  const [failure, setFailure] = useState<{ step: Step; message: string } | null>(null);

  // One at a time: the orders share a signer and a pool, so sending them
  // together makes them collide and one silently drops.
  const run = async () => {
    setRunning(true);
    setResults({});
    setFailure(null);
    const done: Partial<Record<Step, Outcome>> = {};
    for (const item of PLAN) {
      try {
        const outcome = await sendOrder(item.guarded, item.halted);
        done[item.step] = outcome;
        setResults({ ...done });
        if (item.step === "clear" && !outcome.refused) onRecorded(outcome.signature);
      } catch (error) {
        setFailure({
          step: item.step,
          message: error instanceof Error ? error.message : "The order could not be sent.",
        });
        break;
      }
    }
    setRunning(false);
  };

  const started = running || Object.keys(results).length > 0 || failure !== null;

  return (
    <section className="demo" id="demo">
      <div className="wrap">
        <div className="section-head section-head--center">
          <span className="beat">See it work</span>
          <h2>One order, sent three times</h2>
          <p>
            We run a small test venue on Solana so you can watch the check act. The same NVIDIA order
            goes to an ordinary pool while NVIDIA is halted, then to a pool running Breaker while it
            is halted, then to that same pool once the halt lifts. The Breaker pool is the code in
            the section below, unchanged.
          </p>
        </div>

        <div className="run run--center">
          <button className="pill pill--solid" onClick={run} disabled={running}>
            {running ? <Loader2 size={15} className="spin" /> : null}
            {running ? "Sending…" : started ? "Run it again" : "Send the three orders"}
          </button>
          <span className="run-note">No wallet needed. Each order is a real transaction you can open.</span>
        </div>

        <ol className="steps3">
          {PLAN.map((item, i) => {
            const outcome = results[item.step];
            const failed = failure?.step === item.step;
            const told = outcome ? explain(item.step, outcome) : null;
            const current =
              running && !outcome && !failed && PLAN.slice(0, i).every((p) => results[p.step]);
            return (
              <li
                key={item.step}
                className={`step3 ${told ? `step3--${told.tone}` : ""} ${current ? "is-current" : ""}`}
              >
                <div className="step3-when">
                  {item.halted ? <Radio size={13} aria-hidden /> : <Check size={13} aria-hidden />}
                  {item.when}
                </div>
                <div className="step3-pool">{item.pool}</div>
                {told && outcome ? (
                  <>
                    <strong className="step3-verdict">
                      {outcome.refused ? <Ban size={19} aria-hidden /> : <Check size={19} aria-hidden />}
                      {told.verdict}
                    </strong>
                    <p>{told.body}</p>
                    <a className="link" href={outcome.explorer} target="_blank" rel="noreferrer">
                      Open the transaction <ArrowUpRight size={13} />
                    </a>
                  </>
                ) : failed ? (
                  <p className="side-failed">{failure!.message}</p>
                ) : (
                  <>
                    <p className="step3-expect">{item.expect}</p>
                    <p className="side-waiting">
                      {current ? "Sending…" : failure ? "Not sent." : started ? "Waiting its turn…" : ""}
                    </p>
                  </>
                )}
              </li>
            );
          })}
        </ol>

        {results.breaker ? (
          <div className="consequence">
            <h3>What the first order actually bought</h3>
            <div className="consequence-grid">
              <div>
                <strong>13h 10m</strong>
                <span>
                  How long a halt for pending news usually lasts. Stock tokens trade around the
                  clock, so an ordinary pool keeps quoting a stale price for all of it.
                </span>
              </div>
              <div>
                <strong>40 to 70%</strong>
                <span>
                  How far the reopening price can land from the last price before the halt. A stock
                  is halted because something is about to move it.
                </span>
              </div>
              <div>
                <strong>$0</strong>
                <span>
                  The largest order the issuer itself accepts while a stock cannot trade. The
                  ordinary pool above just took one anyway.
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
