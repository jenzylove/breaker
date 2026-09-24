import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  CircleSlash,
  Clock,
  Gauge,
  Moon,
  PauseCircle,
  ShieldCheck,
  Sun,
  TriangleAlert,
} from "lucide-react";
import HeroArt from "./HeroArt";
import proof from "../docs/devnet-proof.json";
import { fetchSymbolRows } from "./lib/chain";
import type { SymbolRow, SymbolStatus } from "./lib/venue";
import type { TapeEntry } from "./lib/tape";

const EXPLORER = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

/** The proof artifact records amounts as "29120.559114 dollars". */
function asMoney(raw: unknown, fallback: string): string {
  const value = Number(String(raw ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(value) || value === 0) return fallback;
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const steps = proof.steps as Record<string, unknown>[];
const stepNamed = (prefix: string) =>
  steps.find((s) => String(s.name).startsWith(prefix)) ?? {};

const guardedHalt = stepNamed("2b.");
const unguardedHalt = stepNamed("2c.");
const capWalk = stepNamed("3.");
const multiplierStep = stepNamed("a scheduled multiplier");

/* ------------------------------------------------------------- status */

const STATUS_ICON: Record<SymbolStatus, typeof ShieldCheck> = {
  trading: ShieldCheck,
  halted: CircleSlash,
  stale: Clock,
  paused: PauseCircle,
  capped: Gauge,
  unconfigured: TriangleAlert,
};

const STATUS_LABEL: Record<SymbolStatus, string> = {
  trading: "Trading",
  halted: "Halted",
  stale: "Feed stale",
  paused: "Paused",
  capped: "Cap reached",
  unconfigured: "Not configured",
};

function Status({ status }: { status: SymbolStatus }) {
  const Icon = STATUS_ICON[status];
  // Icon plus label, never colour alone: two of these steps sit below 3:1 on
  // the light surface by design.
  return (
    <span className={`status status-${status}`}>
      <Icon size={14} strokeWidth={2.2} aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

/* -------------------------------------------------------------- meter */

function CapMeter({ row }: { row: SymbolRow }) {
  const used = Math.min(row.capUsed, 1);
  const over = Math.max(row.capUsed - 1, 0);
  const pct = (row.capUsed * 100).toFixed(1);
  return (
    <div className="meter">
      <div
        className="meter-track"
        role="meter"
        aria-valuenow={Number(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${row.ticker} cap usage`}
      >
        <div className="meter-fill" style={{ width: `${used * 100}%` }} />
        {over > 0 ? (
          <div className="meter-over" style={{ width: `${Math.min(over, 1) * 100}%` }} />
        ) : null}
      </div>
      <div className="meter-label">
        <span>{pct}% of cap</span>
        <span>{row.headroomShares.toFixed(2)} sh left</span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- page */

/** Reveals a block once as it enters the viewport. */
function Reveal({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`reveal ${shown ? "is-in" : ""} ${className}`.trim()}>
      {children}
    </div>
  );
}

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  const toggle = () =>
    setTheme((t) => {
      if (t) return t === "dark" ? "light" : "dark";
      const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
      return prefersDark ? "light" : "dark";
    });
  return { theme, toggle };
}

export default function App() {
  const { theme, toggle } = useTheme();
  const [rows, setRows] = useState<SymbolRow[] | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [tape, setTape] = useState<TapeEntry[] | null>(null);

  const listings = useMemo(
    () =>
      ((proof as { listings?: { symbol: string; halt_state: string }[] }).listings ?? []).map(
        (l) => ({ symbol: l.symbol, haltState: l.halt_state }),
      ),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    fetchSymbolRows(listings)
      .then((r) => !cancelled && setRows(r))
      .catch((e) => !cancelled && setRowsError(e instanceof Error ? e.message : "unavailable"));
    return () => {
      cancelled = true;
    };
  }, [listings]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/tape?limit=25")
        .then((r) => r.json())
        .then((d) => !cancelled && setTape(d.transactions ?? []))
        .catch(() => !cancelled && setTape([]));
    load();
    const id = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <>
      <header className="masthead">
        <div className="wrap masthead-inner">
          <span className="wordmark">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
              <circle cx="3" cy="9" r="2" fill="currentColor" />
              <circle cx="15" cy="9" r="2" fill="currentColor" />
              <path d="M3 9 L11 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Breaker
          </span>
          <div className="masthead-meta">
            <span className="chip">devnet</span>
            <a className="chip" href={EXPLORER("address", proof.breaker)} target="_blank" rel="noreferrer">
              {proof.breaker.slice(0, 4)}…{proof.breaker.slice(-4)}
            </a>
            <button className="theme-toggle" onClick={toggle} aria-label="Toggle colour theme">
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </div>
      </header>

      <section className="hero">
        <div className="wrap hero-lead">
          <div>
            <span className="eyebrow">SEC Innovation Exemption · effective 17 September 2026</span>
            <h1>Tokenized stocks can trade on chain now. On conditions no AMM meets.</h1>
            <p>
              The order lets tokenized NMS stocks trade through public liquidity pools for the next
              five years. A pool has no idea the listing exchange halted a stock, no idea how much
              of its volume cap today has consumed, and emits raw token amounts rather than a dollar
              tape. Breaker is the check a venue calls before it settles.
            </p>
          </div>
          <HeroArt />
        </div>
        <div className="wrap" style={{ marginTop: 34 }}>
          <div className="conditions">
            <h2>What the order requires at trade time</h2>
            <ol>
              <li>
                <span className="cond-num">01</span>
                <span>
                  <b>Stop with the exchange.</b> Trading halts concurrently with any halt or
                  suspension of the underlying on its primary listing exchange.
                </span>
              </li>
              <li>
                <span className="cond-num">02</span>
                <span>
                  <b>Stay under the cap.</b> 0.25% of prior month average daily volume for Tier 1,
                  2.5% for Tier 2. A second breach forces a three month pause in that symbol.
                </span>
              </li>
              <li>
                <span className="cond-num">03</span>
                <span>
                  <b>Publish the tape.</b> Dollar denominated transaction data, public and machine
                  readable, within ten minutes of every fill.
                </span>
              </li>
            </ol>
          </div>
        </div>
      </section>

      <section className="section" id="proof">
        <div className="wrap">
          <Reveal>
          <div className="section-head">
            <h2>Same pool. Same curve. One call apart.</h2>
            <p>
              Both transactions below ran in one devnet session against the same reference pool
              while the symbol was halted. The only difference is whether the pool asked Breaker
              first.
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

      <section className="section" id="venue">
        <div className="wrap">
          <div className="section-head">
            <h2>Live venue state</h2>
            <p>
              Read from chain accounts in your browser, not from our server. A venue whose
              compliance posture is only as good as its own API has not really proved anything.
            </p>
          </div>
          <div className="card">
            <div className="card-head">
              <span>Listed symbols</span>
              <span className="count">
                {rows ? `${rows.length} listed` : rowsError ? "unavailable" : "reading chain…"}
              </span>
            </div>
            {rows && rows.length > 0 ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Status</th>
                      <th>Cap usage</th>
                      <th className="num">Prior month ADV</th>
                      <th className="num">Cap</th>
                      <th className="num">Breaches</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.address}>
                        <td>
                          <div className="ticker">{row.ticker}</div>
                          <div className="sub">Tier {row.tier}</div>
                        </td>
                        <td>
                          <Status status={row.status} />
                          <div className="status-detail">{row.statusDetail}</div>
                        </td>
                        <td>
                          <CapMeter row={row} />
                        </td>
                        <td className="num">{row.advShares.toLocaleString()} sh</td>
                        <td className="num">{row.capShares.toLocaleString()} sh</td>
                        <td className="num">{row.breachCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">
                {rowsError ? `Chain unavailable: ${rowsError}` : "Reading venue accounts…"}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="section" id="tape">
        <div className="wrap">
          <div className="section-head">
            <h2>The public tape</h2>
            <p>
              Rebuilt from chain logs on every request, so it is current to the last confirmed slot.
              Served as machine readable JSON at <code>/api/tape</code>. Nothing here is
              privileged: the same rows can be reconstructed by anyone reading the program's logs.
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
                    {tape.map((t) => (
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
                        <td className="num">${t.notional_usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
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
              <div className="empty">{tape ? "No fills recorded yet." : "Rebuilding the tape…"}</div>
            )}
          </div>
        </div>
      </section>

      <section className="section" id="integrate">
        <div className="wrap two-col">
          <div>
            <div className="section-head">
              <h2>One call before you settle</h2>
              <p>
                A pool passes the fill it is about to make. Breaker reverts the parent transaction
                when the symbol is halted, when the halt feed is too stale to prove the venue is
                mirroring the exchange, or when the fill would breach the cap.
              </p>
            </div>
            <ul className="notes">
              <li>
                <span>
                  <b>The cap is counted in shares, the tape in dollars.</b> Converting a raw token
                  amount into shares needs the multiplier actually in force, not the one in the
                  obvious field. On the mint in this run those differ by{" "}
                  {String(multiplierStep.understatement_if_stored_field_is_read ?? "48.61%")}.
                </span>
              </li>
              <li>
                <span>
                  <b>A stale halt feed fails closed.</b> A venue that cannot prove it is mirroring
                  the listing exchange does not get to keep trading on the assumption that it is.
                </span>
              </li>
              <li>
                <span>
                  <b>The first exceedance settles, the next is refused.</b> The order excuses one
                  breach and forces a three month pause for any later one, so a venue that can
                  prevent the second should never incur it.
                </span>
              </li>
            </ul>
          </div>
          <pre className="code">
            <code>
              <i>{"// Before the pool moves a single token.\n"}</i>
              {"breaker::cpi::"}<b>check_and_record</b>{"(\n"}
              {"    CpiContext::new_with_signer(\n"}
              {"        ctx.accounts.breaker_program.key(),\n"}
              {"        breaker::cpi::accounts::CheckAndRecord {\n"}
              {"            venue, symbol, halt_state,\n"}
              {"            quote_asset, mint,\n"}
              {"            pool: ctx.accounts.pool.to_account_info(),\n"}
              {"        },\n"}
              {"        &[pool_seeds],\n"}
              {"    ),\n"}
              {"    base_amount,   "}<i>{"// equity token units"}</i>{"\n"}
              {"    quote_amount,  "}<i>{"// what settled on the other side"}</i>{"\n"}
              {"    side,\n"}
              {")?;\n"}
              <i>{"// Halted, stale, paused or over cap reverts the parent tx."}</i>
            </code>
          </pre>
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
                <li>
                  <a href={EXPLORER("address", proof.breaker)} target="_blank" rel="noreferrer">
                    <span>
                      <span className="key">Breaker program</span>
                      {proof.breaker.slice(0, 10)}…{proof.breaker.slice(-4)}
                    </span>
                    <ArrowUpRight size={12} />
                  </a>
                </li>
                <li>
                  <a href={EXPLORER("address", proof.reference_pool)} target="_blank" rel="noreferrer">
                    <span>
                      <span className="key">Reference pool</span>
                      {proof.reference_pool.slice(0, 10)}…{proof.reference_pool.slice(-4)}
                    </span>
                    <ArrowUpRight size={12} />
                  </a>
                </li>
                <li>
                  <a href={EXPLORER("address", String(proof.venue ?? ""))} target="_blank" rel="noreferrer">
                    <span>
                      <span className="key">Venue</span>
                      {String(proof.venue ?? "").slice(0, 10)}…{String(proof.venue ?? "").slice(-4)}
                    </span>
                    <ArrowUpRight size={12} />
                  </a>
                </li>
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
                    <span className="key">Attested inputs</span>
                    Halt state and prior month volume are published by roles the venue nominates,
                    because both originate off chain.
                  </span>
                </li>
                <li>
                  <span>
                    <span className="key">Single venue</span>
                    The order aggregates caps across affiliated venues. This enforces one.
                  </span>
                </li>
              </ul>
            </div>
          </div>

          <div className="footer-base">
            <span>Devnet deployment · not for production use</span>
            <span>{String(capWalk.cap_shares ?? "")} share cap · Tier 1 · 0.25% of prior month ADV</span>
          </div>
        </div>
      </footer>
    </>
  );
}
