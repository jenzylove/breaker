import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CircleSlash, Moon, ShieldCheck, Sun } from "lucide-react";
import Hero from "./Hero";
import Console from "./Console";
import proof from "../docs/devnet-proof.json";
import type { TapeEntry } from "./lib/tape";

const EXPLORER = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

/** The proof artifact records amounts as "29120.559114 dollars". */
function asMoney(raw: unknown, fallback: string): string {
  const value = Number(String(raw ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(value) || value === 0) return fallback;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const steps = proof.steps as Record<string, unknown>[];
const stepNamed = (prefix: string) => steps.find((s) => String(s.name).startsWith(prefix)) ?? {};
const guardedHalt = stepNamed("2b.");
const unguardedHalt = stepNamed("2c.");

function Reveal({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => entry.isIntersecting && (setShown(true), observer.disconnect()),
      { rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className={`reveal ${shown ? "is-in" : ""}`}>
      {children}
    </div>
  );
}

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return {
    theme,
    toggle: () =>
      setTheme((t) =>
        t ? (t === "dark" ? "light" : "dark") : window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "light" : "dark",
      ),
  };
}

export default function App() {
  const { theme, toggle } = useTheme();
  const [tape, setTape] = useState<TapeEntry[] | null>(null);
  const [tapeIncomplete, setTapeIncomplete] = useState(false);
  // The bar floats clear over the hero and only takes a surface once the
  // scene is behind it.
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > window.innerHeight * 0.72);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/tape?limit=25")
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          setTape(d.transactions ?? []);
          setTapeIncomplete(d.complete === false);
        })
        .catch(() => !cancelled && setTape([]));
    load();
    const id = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const toConsole = () =>
    document.getElementById("console")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <>
      <header className={`masthead ${scrolled ? "masthead--solid" : ""}`}>
        <div className="masthead-inner">
          <span className="wordmark">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
              <circle cx="3.5" cy="10" r="2.2" fill="currentColor" />
              <circle cx="16.5" cy="10" r="2.2" fill="currentColor" />
              <path d="M3.5 10 L12.5 3.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            Breaker
          </span>
          <nav className="masthead-nav">
            <a href="#console">Console</a>
            <a href="#proof">Proof</a>
            <a href="#tape">Tape</a>
          </nav>
          <div className="masthead-meta">
            <a className="chip" href={EXPLORER("address", proof.breaker)} target="_blank" rel="noreferrer">
              devnet · {proof.breaker.slice(0, 4)}…{proof.breaker.slice(-4)}
            </a>
            <button className="theme-toggle" onClick={toggle} aria-label="Toggle colour theme">
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </div>
      </header>

      <Hero onEnter={toConsole} />

      <section className="section" id="order">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <h2>Three conditions, none of which an AMM can meet</h2>
              <p>
                The order grants a five year exemption from the definition of "exchange". These are
                the parts a pool has to satisfy at the moment it settles, rather than in a filing
                afterwards.
              </p>
            </div>
            <div className="conditions">
              {[
                {
                  n: "01",
                  title: "Stop when the exchange stops",
                  body: "Trading halts concurrently with any halt or suspension of the underlying on its primary listing exchange. A pool has no idea that happened, because the premise of an AMM is that it never closes.",
                  breaker: "Reverts on a halt, and on a halt feed too stale to prove the venue is still mirroring the exchange.",
                },
                {
                  n: "02",
                  title: "Stay under the volume cap",
                  body: "0.25% of the prior month's average daily share volume for Tier 1, 2.5% for Tier 2. The first exceedance is excused; any later one forces a three month pause in that symbol.",
                  breaker: "Tracks a rolling share window per symbol and refuses the fill that would cross it once a breach is on record.",
                },
                {
                  n: "03",
                  title: "Publish a dollar tape",
                  body: "Transaction data, public and machine readable, within ten minutes of every fill: symbol, price, size, UTC timestamp, direction and pool. Pools emit raw token amounts, which are none of those things.",
                  breaker: "Emits every settled fill priced in dollars, rebuilt from chain logs on request at /api/tape.",
                },
              ].map((c) => (
                <article className="condition" key={c.n}>
                  <span className="condition-n">{c.n}</span>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                  <p className="condition-do">{c.breaker}</p>
                </article>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section" id="proof">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <h2>Same pool. Same curve. One call apart.</h2>
              <p>
                Both transactions ran in one devnet session against the same reference pool while
                the symbol was halted. The only difference is whether the pool asked Breaker first.
              </p>
            </div>
            <div className="compare">
              <article className="outcome outcome--leaked">
                <div className="outcome-top">
                  <CircleSlash size={15} color="var(--critical)" aria-hidden />
                  <code>swap_unguarded</code>
                </div>
                <strong className="outcome-figure">{asMoney(unguardedHalt.received, "$29,120.56")}</strong>
                <p>
                  settled against a halted stock. This is not a strawman: it is how every AMM on
                  Solana behaves today, because a pool cannot see a listing exchange.
                </p>
                {unguardedHalt.tx ? (
                  <a className="link" href={String(unguardedHalt.tx)} target="_blank" rel="noreferrer">
                    View transaction <ArrowUpRight size={13} />
                  </a>
                ) : null}
              </article>

              <article className="outcome outcome--blocked">
                <div className="outcome-top">
                  <ShieldCheck size={15} color="var(--good)" aria-hidden />
                  <code>swap_guarded</code>
                </div>
                <strong className="outcome-figure">Reverted</strong>
                <p>
                  with <b>{String(guardedHalt.error ?? "SymbolHalted")}</b> (error{" "}
                  {String(guardedHalt.error_number ?? 6000)}). The whole transaction rolled back and
                  no funds moved.
                </p>
                {guardedHalt.tx ? (
                  <a className="link" href={String(guardedHalt.tx)} target="_blank" rel="noreferrer">
                    View reverted transaction <ArrowUpRight size={13} />
                  </a>
                ) : null}
              </article>
            </div>
          </Reveal>
        </div>
      </section>

      <Console />

      <section className="section" id="tape">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <h2>The public tape</h2>
              <p>
                Rebuilt from chain logs on every request, so it is current to the last confirmed
                slot. Served as machine readable JSON at <code>/api/tape</code>. Nothing here is
                privileged: anyone reading the program's logs can reconstruct the same rows.
              </p>
            </div>
            <div className="card">
              <div className="card-head">
                <span>Recent fills</span>
                <a className="count" href="/api/tape" target="_blank" rel="noreferrer">
                  /api/tape
                </a>
              </div>
              {tape && tape.length > 0 ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Time (UTC)</th>
                        <th>Symbol</th>
                        <th>Side</th>
                        <th className="num">Size</th>
                        <th className="num">Price</th>
                        <th className="num">Notional</th>
                        <th className="num">Multiplier</th>
                        <th>Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tape.slice(0, 6).map((t) => (
                        <tr key={t.signature + t.slot}>
                          <td className="sub">{t.timestamp.replace("T", " ").replace(".000Z", "")}</td>
                          <td className="ticker">
                            {t.symbol}
                            {t.cap_breach ? (
                              <div className="status-detail" style={{ color: "var(--warning)" }}>
                                cap breach
                              </div>
                            ) : null}
                          </td>
                          <td>{t.direction}</td>
                          <td className="num">{t.size_shares.toFixed(5)}</td>
                          <td className="num">${t.price_usd.toFixed(2)}</td>
                          <td className="num">
                            ${t.notional_usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </td>
                          <td className="num">{t.multiplier}</td>
                          <td>
                            <a className="link" href={EXPLORER("tx", t.signature)} target="_blank" rel="noreferrer">
                              {t.signature.slice(0, 6)}… <ArrowUpRight size={12} />
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty">
                  {!tape
                    ? "Rebuilding the tape…"
                    : tapeIncomplete
                      ? "The chain could not be read in full just now. Retrying."
                      : "No fills recorded yet."}
                </div>
              )}
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="footer">
        <div className="wrap">
          <div className="footer-cols">
            <div>
              <h3>What this is</h3>
              <p>
                A trade time compliance guard for venues listing tokenized equities on Solana. It
                enforces the halt and volume cap conditions before a pool settles, and records
                every fill to a public dollar tape.
              </p>
              <p>
                Built against the SEC's order granting temporary conditional exemptive relief under
                Section 36(a)(1), effective 17 September 2026 and expiring 17 September 2031.
              </p>
            </div>

            <div>
              <h3>On chain</h3>
              <ul className="footer-list">
                {[
                  ["Breaker program", proof.breaker],
                  ["Reference pool", proof.reference_pool],
                  ["Reference venue", String(proof.venue ?? "")],
                ].map(([label, id]) => (
                  <li key={label}>
                    <a href={EXPLORER("address", id)} target="_blank" rel="noreferrer">
                      <span>
                        <span className="key">{label}</span>
                        {id.slice(0, 10)}…{id.slice(-4)}
                      </span>
                      <ArrowUpRight size={12} />
                    </a>
                  </li>
                ))}
                <li>
                  <a href="/api/tape" target="_blank" rel="noreferrer">
                    <span>
                      <span className="key">Public tape</span>
                      /api/tape
                    </span>
                    <ArrowUpRight size={12} />
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <h3>Scope and limits</h3>
              <ul className="footer-list">
                <li>
                  <span>
                    <span className="key">Not a venue</span>
                    Breaker is the check a venue calls. It does not make anyone a TSV.
                  </span>
                </li>
                <li>
                  <span>
                    <span className="key">Guard runs on devnet</span>
                    Deliberately. An unaudited program that can block trades does not belong on
                    mainnet. Mint data is read live from mainnet.
                  </span>
                </li>
                <li>
                  <span>
                    <span className="key">Attested inputs</span>
                    Halt state and volume are published by roles the venue nominates. The program
                    enforces their freshness and authority, not their truth.
                  </span>
                </li>
              </ul>
            </div>
          </div>

          <div className="footer-base">
            <span>Devnet deployment · not audited · not for production use</span>
            <span>Tier 1 cap · 0.25% of prior month average daily volume</span>
          </div>
        </div>
      </footer>
    </>
  );
}
