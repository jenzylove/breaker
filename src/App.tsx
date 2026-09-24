import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Moon, Sun } from "lucide-react";
import Hero from "./Hero";
import Demo from "./Demo";
import venueConfig from "./lib/demo-venue";
import type { TapeEntry } from "./lib/tape";

const EXPLORER = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

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
        t
          ? t === "dark"
            ? "light"
            : "dark"
          : window.matchMedia?.("(prefers-color-scheme: dark)").matches
            ? "light"
            : "dark",
      ),
  };
}

const RULES = [
  {
    n: "01",
    title: "Stop when the exchange stops",
    plain:
      "If Nasdaq halts Tesla, every venue trading the token has to halt it too, at the same moment.",
    gap: "A liquidity pool never closes. It has no way of knowing Nasdaq did anything.",
  },
  {
    n: "02",
    title: "Stay under a daily limit",
    plain:
      "A venue may only trade a small slice of what the stock normally trades in a day. Go over twice and that stock is frozen for three months.",
    gap: "A pool does not count its own volume, and has no idea what the limit is.",
  },
  {
    n: "03",
    title: "Publish every trade",
    plain:
      "Every fill has to be public within ten minutes, in dollars, with the time, size and direction.",
    gap: "A pool emits raw token amounts, which is none of those things.",
  },
];

export default function App() {
  const { theme, toggle } = useTheme();
  const [tape, setTape] = useState<TapeEntry[] | null>(null);
  const [tapeIncomplete, setTapeIncomplete] = useState(false);
  const [tapeUnread, setTapeUnread] = useState(0);
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
          const rows = (d.transactions ?? []) as TapeEntry[];
          // Never replace rows we already have with fewer. A refresh that hits
          // a rate limit should not make the record appear to shrink.
          setTape((previous) => (previous && rows.length < previous.length ? previous : rows));
          setTapeIncomplete(d.complete === false && rows.length === 0);
          setTapeUnread(typeof d.unread === "number" ? d.unread : 0);
        })
        .catch(() => !cancelled && setTape((previous) => previous ?? []));
    load();
    // Slow. Hammering a public node is what caused the flicker in the first
    // place, and a trade record does not need second-by-second refresh.
    const id = setInterval(load, 90_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const toDemo = () =>
    document.getElementById("demo")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <>
      <header className={`masthead ${scrolled ? "masthead--solid" : ""}`}>
        <div className="masthead-inner">
          <span className="wordmark">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
              <circle cx="3.5" cy="10" r="2.2" fill="currentColor" />
              <circle cx="16.5" cy="10" r="2.2" fill="currentColor" />
              <path
                d="M3.5 10 L12.5 3.5"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
            Breaker
          </span>
          <nav className="masthead-nav">
            <a href="#demo">Try it</a>
            <a href="#rules">Why</a>
          </nav>
          <div className="masthead-meta">
            <button className="theme-toggle" onClick={toggle} aria-label="Toggle colour theme">
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </div>
      </header>

      <Hero onEnter={toDemo} />

      <Demo />

      <section className="section" id="rules">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <h2>Why a stock token needs a brake</h2>
              <p>
                On 17 September the SEC granted conditional relief letting real US stocks trade on
                public blockchains for five years. The order sets a long list of conditions.
                Breaker implements the three below, which are the ones a liquidity pool cannot do
                on its own.
              </p>
            </div>
            <ol className="rules">
              {RULES.map((rule) => (
                <li className="rule" key={rule.n}>
                  <span className="rule-dot" aria-hidden />
                  <div className="rule-body">
                    <h3>{rule.title}</h3>
                    <p>{rule.plain}</p>
                    <p className="rule-gap">
                      <span>A pool cannot do this</span>
                      {rule.gap}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="rules-foot">
              Breaker is the check that sits in front of the pool. Before a trade settles, the pool
              asks it. If the stock is halted or the limit is gone, the whole trade is cancelled and
              nothing moves.
            </p>
            <div className="scope-note">
              <strong>What this does not do.</strong> The order also requires permissioned access,
              issuer objection rights, published venue contracts, participant notices, OFAC
              compliance and recordkeeping. Breaker implements none of those. Running it does not
              make anyone a Tokenized Securities Venue, and this is a testnet demo of selected
              controls, not a compliance product.{" "}
              <a
                href="https://www.federalregister.gov/documents/2026/09/22/2026-19388/order-granting-temporary-conditional-exemptive-relief-pursuant-to-section-36a1-of-the-securities"
                target="_blank"
                rel="noreferrer"
              >
                Read the order
              </a>
              .
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section" id="record">
        <div className="wrap">
          <Reveal>
            <div className="section-head">
              <h2>Every trade, published in dollars</h2>
              <p>
                That is the third condition. This list is rebuilt from the blockchain each time you
                load the page, so anyone can check it against the chain rather than trusting us.
              </p>
            </div>
            <div className="card">
              <div className="card-head">
                <span>Trades on the demo exchange</span>
                {tape && tape.length > 0 ? (
                  <span className="tape-count">
                    {tapeUnread > 0
                      ? `showing ${tape.length} of ${tape.length + tapeUnread}, the public node would not serve the rest`
                      : `all ${tape.length} recorded`}
                  </span>
                ) : null}
                <a className="count" href="/api/tape" target="_blank" rel="noreferrer">
                  raw data
                </a>
              </div>
              {tape && tape.length > 0 ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Time (UTC)</th>
                        <th>Stock</th>
                        <th className="num">Shares</th>
                        <th className="num">Price</th>
                        <th className="num">Value</th>
                        <th>Proof</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tape.slice(0, 6).map((t) => (
                        <tr key={t.signature + t.slot}>
                          <td className="sub">
                            {t.timestamp.replace("T", " ").replace(".000Z", "")}
                          </td>
                          <td className="ticker">
                            {t.symbol}
                            {t.cap_breach ? (
                              <div className="status-detail" style={{ color: "var(--warning)" }}>
                                went over the limit
                              </div>
                            ) : null}
                          </td>
                          <td className="num">{t.size_shares.toFixed(4)}</td>
                          <td className="num">${t.price_usd.toFixed(2)}</td>
                          <td className="num">
                            ${t.notional_usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </td>
                          <td>
                            <a
                              className="link"
                              href={EXPLORER("tx", t.signature)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              open <ArrowUpRight size={12} />
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
                    ? "Reading the blockchain…"
                    : tapeIncomplete
                      ? "The public blockchain node is rate limiting us. Trades will appear shortly."
                      : "No trades yet. Run one above and it will appear here."}
                </div>
              )}
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="footer">
        <div className="wrap footer-row">
          <p>
            Breaker is a safety check that tokenized stock exchanges call before they settle a
            trade. Running on Solana test network. Not audited, not for real money.
          </p>
          <div className="footer-links">
            <a href={EXPLORER("address", venueConfig.breaker)} target="_blank" rel="noreferrer">
              The program <ArrowUpRight size={12} />
            </a>
            <a href="/api/tape" target="_blank" rel="noreferrer">
              Trade data <ArrowUpRight size={12} />
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
