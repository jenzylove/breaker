// How a venue adopts Breaker, and the proof that it works.
//
// The code panel is the demo. A visitor switches the Breaker call on or off,
// chooses whether NVIDIA is halted, and runs the swap. It lands on devnet and
// the program's own logs stream back underneath the code, so what they read is
// what executed, not a description of it.

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Loader2, Play } from "lucide-react";
import venueConfig from "./lib/demo-venue";
import { EVENT_DISCRIMINATORS, decodeTradeRecorded, eventPayloads, type TapeEntry } from "./lib/tape";

const SOURCE = "https://github.com/jenzylove/breaker/blob/main/programs/reference-pool/src/lib.rs";

const DOES = [
  {
    title: "Checks for a halt",
    body: "Reads the halt flag for this stock, which a publisher mirrors from the issuer. If the stock is halted, or the flag has not been refreshed recently enough to trust, the trade is refused.",
  },
  {
    title: "Counts the trade against the daily limit",
    body: "Adds it to today's total for the stock. The first trade that crosses the limit goes through and is flagged, as the SEC order allows. After that, any trade that would cross it is refused.",
  },
  {
    title: "Publishes the trade in dollars",
    body: "Writes the time, size, price and direction to the chain inside the same transaction. There is no separate reporting job that can fall behind or be switched off.",
  },
];

interface Run {
  guarded: boolean;
  halted: boolean;
  refused: boolean;
  code: string | null;
  reason: string | null;
  signature: string;
  slot: number;
  explorer: string;
  logs: string[];
}

type Tone = "plain" | "muted" | "bad" | "good" | "event" | "note";
interface Line {
  text: string;
  tone: Tone;
}

const NAMES: Record<string, string> = {
  [venueConfig.breaker]: "breaker",
  [venueConfig.reference_pool]: "your_pool",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "token_2022",
  "11111111111111111111111111111111": "system",
};

function eventName(base64: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).slice(0, 8);
    for (const [name, disc] of Object.entries(EVENT_DISCRIMINATORS)) {
      if (disc.every((b, i) => bytes[i] === b)) return name;
    }
  } catch {
    // Not an event we know.
  }
  return null;
}

/** The chain's logs, with program ids named and the noise dropped. */
function toLines(logs: string[]): Line[] {
  const out: Line[] = [];
  for (const raw of logs) {
    if (/consumed \d+ of|^Program return:/.test(raw)) continue;
    const depth = Number(/invoke \[(\d+)\]/.exec(raw)?.[1] ?? 0);
    let text = raw;
    for (const [id, name] of Object.entries(NAMES)) text = text.split(id).join(name);
    const data = /^Program data: (.+)$/.exec(raw);
    if (data) {
      const name = eventName(data[1]);
      out.push({ text: `  emit ${name ?? "event"}`, tone: "event" });
      continue;
    }
    const indent = depth > 1 ? "  ".repeat(depth - 1) : "";
    const tone: Tone = /failed|Error/.test(text) ? "bad" : /success$/.test(text) ? "muted" : "plain";
    out.push({ text: indent + text.replace(/^Program log: /, "  log: "), tone });
  }
  return out;
}

function outcome(run: Run, trade: TapeEntry | null): Line[] {
  if (run.refused) {
    return [
      { text: `✕ reverted · ${run.code ?? "error"} · no tokens moved`, tone: "bad" },
      { text: `  ${run.reason ?? "Breaker refused the trade."}`, tone: "muted" },
    ];
  }
  if (trade) {
    return [
      {
        text: `✓ settled · ${trade.size_shares.toFixed(4)} NVDAx at $${trade.price_usd.toFixed(2)} = $${trade.notional_usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        tone: "good",
      },
      { text: "  counted against today's limit and added to the public record below", tone: "muted" },
    ];
  }
  if (run.halted) {
    return [
      { text: "✓ settled during a halt", tone: "bad" },
      { text: "  nothing stopped it. The pool never saw the halt.", tone: "muted" },
    ];
  }
  return [
    { text: "✓ settled · nothing counted, nothing published", tone: "muted" },
    { text: "  without the call, the trade leaves no record the order would accept", tone: "muted" },
  ];
}

export default function Adopt({ onRecorded }: { onRecorded: (signature: string) => void }) {
  const [withBreaker, setWithBreaker] = useState(true);
  const [halted, setHalted] = useState(true);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [shown, setShown] = useState(0);
  const [run, setRun] = useState<Run | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  // Reveal the logs a line at a time, so the order of execution is readable.
  useEffect(() => {
    if (shown >= lines.length) return;
    const id = setTimeout(() => setShown((n) => n + 1), 55);
    return () => clearTimeout(id);
  }, [shown, lines]);

  useEffect(() => {
    const node = consoleRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [shown]);

  const execute = async () => {
    setRunning(true);
    setRun(null);
    const intro: Line[] = [
      { text: `$ run your_pool::swap  ·  NVDAx  ·  ${withBreaker ? "with" : "without"} Breaker  ·  ${halted ? "Nasdaq halted" : "Nasdaq open"}`, tone: "plain" },
      {
        text: halted
          ? "// the publisher raises NVDA's halt, your swap runs, the halt is lowered. One transaction."
          : "// the publisher writes the issuer's current flag for NVDA, then your swap runs.",
        tone: "note",
      },
    ];
    setLines(intro);
    setShown(intro.length);
    try {
      const response = await fetch("/api/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker: "NVDAx", guarded: withBreaker, halted }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "The swap could not be sent.");
      const result = data as Run;
      const trade =
        eventPayloads(result.logs)
          .map((p) => decodeTradeRecorded(p, { signature: result.signature, slot: result.slot }))
          .find((t): t is TapeEntry => t !== null) ?? null;
      setRun(result);
      setLines([...intro, ...toLines(result.logs), { text: "", tone: "plain" }, ...outcome(result, trade)]);
      if (trade) onRecorded(result.signature);
    } catch (error) {
      setLines([
        ...intro,
        { text: `✕ ${error instanceof Error ? error.message : "The swap could not be sent."}`, tone: "bad" },
      ]);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="section adopt-section" id="adopt">
      <div className="wrap">
        <div className="section-head section-head--center">
          <span className="beat">For venues</span>
          <h2>How an exchange plugs it in</h2>
          <p>
            Breaker is not a site anyone trades on. It is a program on Solana that other trading
            programs call. A pool adds one call to its swap, and from then on every trade has to pass
            three checks before any token moves. Run it below: it is a real pool on Solana's test
            network.
          </p>
        </div>

        <div className="adopt-grid">
          <div className="adopt-copy">
            <h3 className="adopt-label">What that one call does</h3>
            <ol className="adopt-steps">
              {DOES.map((item, i) => (
                <li key={item.title}>
                  <span className="adopt-n">{i + 1}</span>
                  <div>
                    <h4>{item.title}</h4>
                    <p>{item.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="adopt-revert">
              If any check fails, the whole trade is cancelled. No token moves and nobody is filled at
              a price the market has not set.
            </p>
            <div className="adopt-proof-links">
              <a className="link" href={`${SOURCE}#L69`} target="_blank" rel="noreferrer">
                Ordinary swap source <ArrowUpRight size={13} />
              </a>
              <a className="link" href={`${SOURCE}#L99`} target="_blank" rel="noreferrer">
                Swap with Breaker source <ArrowUpRight size={13} />
              </a>
            </div>
          </div>

          <div className="ide">
            <div className="ide-head">
              <span className="ide-file">your_pool.rs</span>
              <div className="seg" role="group" aria-label="Breaker call">
                <button className={!withBreaker ? "is-on" : ""} onClick={() => setWithBreaker(false)}>
                  Without Breaker
                </button>
                <button className={withBreaker ? "is-on" : ""} onClick={() => setWithBreaker(true)}>
                  With Breaker
                </button>
              </div>
            </div>

            <pre className="ide-code">
              <code>
                <span className="ln">{"pub fn swap(ctx, base_amount) -> Result<()> {\n"}</span>
                <span className="ln">{"    let quote_out = quote_for_base(..)?;\n"}</span>
                <span className={`ide-added ${withBreaker ? "is-on" : ""}`}>
                  <span className="ln ln--add">{"+   breaker::cpi::check_and_record(\n"}</span>
                  <span className="ln ln--add">{"+       CpiContext::new_with_signer(breaker_program,\n"}</span>
                  <span className="ln ln--add">{"+           CheckAndRecord { venue, symbol, halt_state,\n"}</span>
                  <span className="ln ln--add">{"+                            quote_asset, mint, pool },\n"}</span>
                  <span className="ln ln--add">{"+           &[pool_seeds]),\n"}</span>
                  <span className="ln ln--add">{"+       base_amount, quote_out, side,\n"}</span>
                  <span className="ln ln--add">{"+   )?;\n"}</span>
                </span>
                <span className="ln">
                  {"    settle(..)  "}
                  <span className="c">{"// tokens move\n"}</span>
                </span>
                <span className="ln">{"}"}</span>
              </code>
            </pre>

            <div className="ide-bar">
              <div className="ide-bar-group">
                <span className="ide-bar-label">NVDA on Nasdaq</span>
                <div className="seg seg--small" role="group" aria-label="Exchange state">
                  <button className={!halted ? "is-on" : ""} onClick={() => setHalted(false)}>
                    Open
                  </button>
                  <button className={halted ? "is-on is-halt" : ""} onClick={() => setHalted(true)}>
                    Halted
                  </button>
                </div>
              </div>
              <button className="ide-run" onClick={execute} disabled={running}>
                {running ? <Loader2 size={14} className="spin" /> : <Play size={13} />}
                {running ? "Running on devnet…" : "Run this swap"}
              </button>
            </div>

            <div className="ide-console" ref={consoleRef} aria-live="polite">
              {lines.length === 0 ? (
                <span className="ide-idle">
                  Output from the chain appears here. Try it halted with Breaker, then without.
                </span>
              ) : (
                lines.slice(0, shown).map((line, i) => (
                  <div key={i} className={`cl cl--${line.tone}`}>
                    {line.text || " "}
                  </div>
                ))
              )}
              {run && shown >= lines.length ? (
                <a className="link ide-tx" href={run.explorer} target="_blank" rel="noreferrer">
                  Open this transaction on Solana Explorer <ArrowUpRight size={12} />
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
