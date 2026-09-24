import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Moon, Sun } from "lucide-react";
import { fetchHaltFeed } from "./lib/chain";
import Hero from "./Hero";
import Coverage from "./Coverage";
import Demo from "./Demo";
import Adopt from "./Adopt";
import venueConfig from "./lib/demo-venue";
import type { TapeEntry } from "./lib/tape";

const EXPLORER = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

/** Adds `is-in` once the element scrolls into view, then stops watching. */
function useInView<T extends HTMLElement>(rootMargin = "0px 0px -12% 0px") {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin]);
  return { ref, inView };
}

/** Dark unless the visitor switches. index.html stamps the same default so the
 *  first paint is already dark. */
function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

const REPO = "https://github.com/jenzylove/breaker";
const ORDER_URL =
  "https://www.federalregister.gov/documents/2026/09/22/2026-19388/order-granting-temporary-conditional-exemptive-relief-pursuant-to-section-36a1-of-the-securities";

function ago(seconds: number): string {
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

// Each rule says what the order requires and why a pool fails it, then what
// Breaker does about it. The intro already says a pool cannot meet these, so
// the failure is not relabelled on every step.
const RULES = [
  {
    title: "Stop when the exchange stops",
    plain:
      "If Nasdaq halts a stock, every venue trading its token has to halt it too, at the same moment. The issuer's halt does not reach the chain on its own: on 24 September, none of the seven stocks xStocks had halted was paused on Solana, so their tokens could still be traded anywhere.",
    breaker: "Breaker refuses the trade while the stock is halted, and also if the halt feed goes quiet.",
  },
  {
    title: "Stay under a daily limit",
    plain:
      "A venue may only trade a small slice of what the stock normally trades in a day. Go over twice and that stock is frozen for three months. A pool does not count its own volume and has no idea what the limit is.",
    breaker: "Breaker counts every trade and refuses the one that would cross the limit a second time.",
  },
  {
    title: "Publish every trade",
    plain:
      "Every trade has to be public within ten minutes, in dollars, with its time, size and direction. A pool only emits raw token amounts.",
    breaker: "Breaker writes that record inside the trade itself, so it cannot be skipped.",
  },
];

function Rules() {
  const { ref, inView } = useInView<HTMLOListElement>();
  return (
    <ol ref={ref} className={`rules ${inView ? "is-in" : ""}`}>
      {RULES.map((rule, i) => (
        <li className="rule" key={rule.title} style={{ ["--i" as string]: i }}>
          <span className="rule-dot" aria-hidden />
          <div className="rule-body">
            <h3>{rule.title}</h3>
            <p>{rule.plain}</p>
            <p className="rule-answer">{rule.breaker}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function App() {
  const { theme, toggle } = useTheme();
  const [tape, setTape] = useState<TapeEntry[] | null>(null);
  const [tapeUnread, setTapeUnread] = useState(0);
  const [mine, setMine] = useState<string | null>(null);
  const [feedAt, setFeedAt] = useState<number | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > window.innerHeight * 0.72);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // `fresh` skips the browser's short cache, for the reload right after an
  // order so the visitor's own trade shows up.
  const loadTape = (fresh = false): Promise<TapeEntry[]> =>
    fetch(`/api/tape?limit=40${fresh ? `&t=${Date.now()}` : ""}`)
      .then((r) => r.json())
      .then((d) => {
        const rows = (d.transactions ?? []) as TapeEntry[];
        // A refresh that hits a rate limit must not make the record shrink.
        setTape((prev) => (prev && rows.length < prev.length ? prev : rows));
        setTapeUnread(typeof d.unread === "number" ? d.unread : 0);
        return rows;
      })
      .catch(() => {
        setTape((prev) => prev ?? []);
        return [] as TapeEntry[];
      });

  useEffect(() => {
    loadTape();
    const id = setInterval(() => loadTape(), 90_000);
    return () => clearInterval(id);
  }, []);

  // Keep the test venue's halt feed fresh while someone is looking, then read
  // back from the chain when it was last written.
  useEffect(() => {
    const read = () =>
      fetchHaltFeed(venueConfig.listings.map((l) => l.halt_state))
        .then((states) => {
          const latest = Math.max(...states.map((st) => st.updatedAt));
          if (Number.isFinite(latest) && latest > 0) setFeedAt(latest);
        })
        .catch(() => undefined);
    fetch("/api/heartbeat", { method: "POST" })
      .catch(() => undefined)
      .finally(read);
    const id = setInterval(read, 60_000);
    return () => clearInterval(id);
  }, []);

  // The visitor's cleared order takes a few seconds to be readable. Retry until
  // it is in the record, then it stays marked.
  const onRecorded = async (signature: string) => {
    setMine(signature);
    for (const wait of [1500, 4000, 8000, 14000]) {
      await new Promise((r) => setTimeout(r, wait));
      const rows = await loadTape(true);
      if (rows.some((row) => row.signature === signature)) return;
    }
  };

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
            <a href="#why">Why</a>
            <a href="#coverage">Coverage</a>
            <a href="#demo">See it work</a>
            <a href="#adopt">For venues</a>
          </nav>
          <div className="masthead-meta">
            <button className="theme-toggle" onClick={toggle} aria-label="Toggle colour theme">
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </div>
      </header>

      <Hero onEnter={toDemo} />

      <section className="section" id="why">
        <div className="wrap wrap--narrow">
          <div className="section-head section-head--center">
            <span className="beat">Why</span>
            <h2>Why a stock token needs a brake</h2>
            <p>
              On 17 September the SEC granted conditional relief letting real US stocks trade on
              public blockchains for five years. The order sets a long list of conditions. These are
              the three a liquidity pool cannot meet on its own.
            </p>
          </div>

          <Rules />

          <p className="rules-foot">
            Breaker is the check that sits in front of the pool. Before a trade settles, the pool
            asks it. If the stock is halted or the limit is gone, the whole trade is cancelled and
            nothing moves.
          </p>

          <div className="scope-note">
            <strong>What this does not do.</strong> The order also requires permissioned access,
            issuer objection rights, published venue contracts, participant notices, OFAC
            compliance and recordkeeping. Breaker implements none of those, and running it does not
            make anyone a Tokenized Securities Venue. This is a testnet build of three controls, not
            a compliance product.{" "}
            <a
              href={ORDER_URL}
              target="_blank"
              rel="noreferrer"
            >
              Read the order
            </a>
            .
          </div>
        </div>
      </section>

      <Coverage />

      <Demo onRecorded={onRecorded} />

      <Adopt />

      <section className="section" id="record">
        <div className="wrap">
          <div className="section-head section-head--center">
            <span className="beat">The public record</span>
            <h2>Every trade it lets through is published</h2>
            <p>
              The SEC order requires every trade to be made public within ten minutes, in dollars,
              with its time, size and direction. Breaker writes that record inside the trade itself,
              so a venue cannot skip it. This table is read straight from the blockchain, not from
              our server. Send the orders above and the one that clears lands here.
            </p>
          </div>
          <div className="card">
            <div className="card-head">
              <span>Trades that cleared Breaker</span>
              {tape && tape.length > 0 ? (
                <span className="tape-count">
                  {tapeUnread > 0
                    ? `showing ${tape.length}, ${tapeUnread} still loading`
                    : `${tape.length} on record`}
                </span>
              ) : null}
            </div>
            {tape && tape.length > 0 ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Time (UTC)</th>
                      <th>Stock</th>
                      <th>Side</th>
                      <th className="num">Shares</th>
                      <th className="num">Price</th>
                      <th className="num">Value</th>
                      <th>Proof</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tape.slice(0, 6).map((t) => (
                      <tr key={t.signature + t.slot} className={t.signature === mine ? "is-mine" : ""}>
                        <td className="sub">
                          {t.timestamp.replace("T", " ").replace(".000Z", "")}
                          {t.signature === mine ? <span className="mine-tag">your order</span> : null}
                        </td>
                        <td className="ticker">{t.symbol}</td>
                        <td className="sub">{t.direction === "buy" ? "Buy" : "Sell"}</td>
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
                {tape ? "No trades recorded yet. Send the orders above." : "Reading the blockchain…"}
              </div>
            )}
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="wrap">
          <div className="site-footer-grid">
            <div className="site-footer-brand">
              <span className="site-footer-mark">
                BREAKER<i>.</i>
              </span>
              <p>
                A check that tokenized stock venues on Solana call before they settle a trade. It
                refuses trades in halted stocks, holds each stock under its daily limit, and
                publishes every trade it lets through in dollars.
              </p>
              <p className="site-footer-small">
                Runs on Solana's test network. Not audited and not for real money. It covers three
                conditions of the SEC order, not all of them.
              </p>
            </div>

            <nav className="site-footer-col" aria-label="On this page">
              <h4>On this page</h4>
              <a href="#why">Why it exists</a>
              <a href="#coverage">Every stock</a>
              <a href="#demo">See it work</a>
              <a href="#adopt">For venues</a>
              <a href="#record">Public record</a>
            </nav>

            <nav className="site-footer-col" aria-label="Evidence">
              <h4>Evidence</h4>
              <a href={EXPLORER("address", venueConfig.breaker)} target="_blank" rel="noreferrer">
                The Breaker program
              </a>
              <a
                href={EXPLORER("address", venueConfig.reference_pool)}
                target="_blank"
                rel="noreferrer"
              >
                The test venue's pool
              </a>
              <a href="/api/stocks" target="_blank" rel="noreferrer">
                Live stock status
              </a>
              <a href="/api/tape" target="_blank" rel="noreferrer">
                Trade record data
              </a>
              <a href={ORDER_URL} target="_blank" rel="noreferrer">
                The SEC order
              </a>
            </nav>

            <nav className="site-footer-col" aria-label="Project">
              <h4>Project</h4>
              <a href={REPO} target="_blank" rel="noreferrer">
                Source code
              </a>
              <a href={`${REPO}#add-breaker-to-a-venue`} target="_blank" rel="noreferrer">
                Integration guide
              </a>
              <a href={`${REPO}/tree/main/crates/breaker-core`} target="_blank" rel="noreferrer">
                The rules engine and its tests
              </a>
            </nav>
          </div>

          <div className="site-footer-bar">
            <span>No wallet, no real money. Every order on this page is a transaction you can open.</span>
            <span className="site-footer-live">
              <i className={feedAt ? "is-on" : ""} />
              {feedAt
                ? `Halt feed last published ${ago(Date.now() / 1000 - feedAt)}`
                : "Reading the halt feed…"}
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}
