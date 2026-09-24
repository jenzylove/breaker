import { useEffect, useState } from "react";
import { ArrowUpRight, Moon, Sun } from "lucide-react";
import Hero from "./Hero";
import Coverage from "./Coverage";
import Adopt from "./Adopt";
import venueConfig from "./lib/demo-venue";
import type { TapeEntry } from "./lib/tape";

const EXPLORER = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

const REPO = "https://github.com/jenzylove/breaker";
const ORDER_URL =
  "https://www.federalregister.gov/documents/2026/09/22/2026-19388/order-granting-temporary-conditional-exemptive-relief-pursuant-to-section-36a1-of-the-securities";

/** Dark unless the visitor switches. index.html stamps the same default so the
 *  first paint is already dark. */
function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

/**
 * Scroll motion. Where the browser supports scroll driven animation, CSS ties
 * each [data-reveal] element's entrance to its position in the viewport, so it
 * opens as you scroll rather than playing once. Elsewhere, this falls back to
 * adding `is-in` when the element arrives.
 */
function useReveal() {
  useEffect(() => {
    if (typeof CSS !== "undefined" && CSS.supports?.("animation-timeline: view()")) return;
    if (typeof IntersectionObserver === "undefined") {
      document.querySelectorAll("[data-reveal]").forEach((el) => el.classList.add("is-in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        }),
      { rootMargin: "0px 0px -10% 0px" },
    );
    const watch = () =>
      document.querySelectorAll("[data-reveal]:not(.is-in)").forEach((el) => io.observe(el));
    watch();
    // Sections that render after their data arrives still get observed.
    const mo = new MutationObserver(watch);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, []);
}

const RULES = [
  {
    title: "Stop when the exchange stops",
    plain:
      "When Nasdaq halts a stock, every venue must halt its token too. The issuer's halt never reaches the chain: none of the seven stocks xStocks had halted on 24 September was paused on Solana.",
    breaker: "Breaker refuses the trade while the stock is halted, or if the halt feed goes quiet.",
  },
  {
    title: "Stay under a daily limit",
    plain:
      "A venue may only trade a small share of a stock's normal daily volume. A pool does not count its volume at all.",
    breaker: "Breaker counts every trade and refuses the one that would cross the limit twice.",
  },
  {
    title: "Publish every trade",
    plain: "Every trade must be public in dollars within ten minutes. A pool only emits token amounts.",
    breaker: "Breaker writes the record inside the trade, so it cannot be skipped.",
  },
];

export default function App() {
  const { theme, toggle } = useTheme();
  const [tape, setTape] = useState<TapeEntry[] | null>(null);
  const [tapeUnread, setTapeUnread] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  useReveal();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // `fresh` skips the browser's short cache, for the reload right after a swap.
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

  // Keep the test venue's halt feed fresh while someone is looking.
  useEffect(() => {
    fetch("/api/heartbeat", { method: "POST" }).catch(() => undefined);
  }, []);

  // A cleared swap takes a few seconds to be readable. Retry until it is in
  // the record.
  const onRecorded = async (signature: string) => {
    for (const wait of [1500, 4000, 8000, 14000]) {
      await new Promise((r) => setTimeout(r, wait));
      const rows = await loadTape(true);
      if (rows.some((row) => row.signature === signature)) return;
    }
  };

  const toDemo = () =>
    document.getElementById("adopt")?.scrollIntoView({ behavior: "smooth", block: "start" });

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
            <a href="#adopt">For venues</a>
            <a href="#record">Record</a>
          </nav>
          <div className="masthead-meta">
            <button className="theme-toggle" onClick={toggle} aria-label="Toggle colour theme">
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <a className="nav-cta" href="#adopt">
              Try it
            </a>
          </div>
        </div>
      </header>

      <Hero onEnter={toDemo} />

      <section className="section" id="why">
        <div className="wrap wrap--narrow">
          <div className="section-head section-head--center" data-reveal>
            <span className="beat">Why</span>
            <h2>Why a stock token needs a brake</h2>
            <p>
              The SEC now lets US stocks trade on chain, under conditions. Three of them a
              liquidity pool cannot meet alone.
            </p>
          </div>

          <ol className="rules">
            {RULES.map((rule) => (
              <li className="rule" key={rule.title} data-reveal>
                <span className="rule-dot" aria-hidden />
                <div className="rule-body">
                  <h3>{rule.title}</h3>
                  <p>{rule.plain}</p>
                  <p className="rule-answer">{rule.breaker}</p>
                </div>
              </li>
            ))}
          </ol>

          <p className="scope-note" data-reveal>
            Breaker covers these three conditions, not the rest of the order: access controls,
            issuer objections, OFAC and recordkeeping stay with the venue. Testnet, not audited.{" "}
            <a href={ORDER_URL} target="_blank" rel="noreferrer">
              Read the order
            </a>
          </p>
        </div>
      </section>

      <Coverage />

      <Adopt onRecorded={onRecorded} />

      <section className="section" id="record">
        <div className="wrap">
          <div className="section-head section-head--center" data-reveal>
            <span className="beat">Record</span>
            <h2>Every trade it lets through, published</h2>
            <p>In dollars, read straight from the chain, not from our server.</p>
          </div>
          <div className="ledger" data-reveal>
            <div className="ledger-head">
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
                      <tr key={t.signature + t.slot}>
                        <td className="sub">{t.timestamp.replace("T", " ").replace(".000Z", "")}</td>
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
                {tape ? "No trades recorded yet." : "Reading the blockchain…"}
              </div>
            )}
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="wrap">
          <div className="site-footer-top">
            <div className="site-footer-brand">
              <span className="site-footer-mark">Breaker</span>
              <p>
                Halt protection for tokenized stocks on Solana. One call a trading venue adds, so
                halted stocks stop trading, daily limits hold, and every trade is published.
              </p>
            </div>
            <nav className="site-footer-links" aria-label="Project">
              <a href={REPO} target="_blank" rel="noreferrer">
                Source code
              </a>
              <a href={`${REPO}#add-breaker-to-a-venue`} target="_blank" rel="noreferrer">
                Integration guide
              </a>
              <a href={EXPLORER("address", venueConfig.breaker)} target="_blank" rel="noreferrer">
                The program on Solana
              </a>
              <a href={ORDER_URL} target="_blank" rel="noreferrer">
                The SEC order
              </a>
            </nav>
          </div>
          <div className="site-footer-bar">
            <span>© 2026 Breaker</span>
            <span>Solana devnet · not audited</span>
          </div>
        </div>
      </footer>
    </>
  );
}
