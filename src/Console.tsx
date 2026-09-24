import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  ArrowUpRight,
  CircleSlash,
  Clock,
  Gauge,
  Loader2,
  PauseCircle,
  Plus,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import {
  BREAKER_PROGRAM,
  explainError,
  haltPda,
  initializeVenue,
  listSymbol,
  setHalt,
  symbolPda,
  updateAdv,
  venuePda,
} from "./lib/client";
import { decodeHaltState, decodeSymbol, toRow, type SymbolRow } from "./lib/venue";
import { fetchXStocks, type XStock } from "./lib/xstocks";

const EXPLORER = (kind: "address" | "tx", id: string) =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

const STATUS_ICON = {
  trading: ShieldCheck,
  halted: CircleSlash,
  stale: Clock,
  paused: PauseCircle,
  capped: Gauge,
  unconfigured: TriangleAlert,
} as const;

const STATUS_LABEL = {
  trading: "Trading",
  halted: "Halted",
  stale: "Feed stale",
  paused: "Paused",
  capped: "Cap reached",
  unconfigured: "Not configured",
} as const;

function Status({ status }: { status: SymbolRow["status"] }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className={`status status-${status}`}>
      <Icon size={14} strokeWidth={2.2} aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

function CapMeter({ row }: { row: SymbolRow }) {
  const used = Math.min(row.capUsed, 1);
  const over = Math.max(Math.min(row.capUsed - 1, 1), 0);
  return (
    <div className="meter">
      <div className="meter-track" role="meter" aria-valuenow={row.capUsed * 100} aria-valuemin={0} aria-valuemax={100}>
        <div className="meter-fill" style={{ width: `${used * 100}%` }} />
        {over > 0 ? <div className="meter-over" style={{ width: `${over * 100}%` }} /> : null}
      </div>
      <div className="meter-label">
        <span>{(row.capUsed * 100).toFixed(1)}% of cap</span>
        <span>{row.headroomShares.toFixed(2)} sh left</span>
      </div>
    </div>
  );
}

type Step = 1 | 2 | 3 | 4;

export default function Console() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const [venueExists, setVenueExists] = useState<boolean | null>(null);
  const [rows, setRows] = useState<SymbolRow[]>([]);
  const [stocks, setStocks] = useState<XStock[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "bad"; text: string; tx?: string } | null>(null);

  const venue = useMemo(() => (publicKey ? venuePda(publicKey) : null), [publicKey]);

  /* ------------------------------------------------------------- reads */

  const refresh = useCallback(async () => {
    if (!venue) {
      setVenueExists(null);
      setRows([]);
      return;
    }
    const info = await connection.getAccountInfo(venue).catch(() => null);
    setVenueExists(Boolean(info));
    if (!info) {
      setRows([]);
      return;
    }

    // Every symbol account this venue owns. The venue key sits right after the
    // account discriminator.
    const accounts = await connection
      .getProgramAccounts(BREAKER_PROGRAM, {
        filters: [{ memcmp: { offset: 8, bytes: venue.toBase58() } }],
      })
      .catch(() => []);

    const symbols = accounts
      .map((a) => {
        try {
          return decodeSymbol(a.pubkey.toBase58(), Uint8Array.from(a.account.data));
        } catch {
          return null;
        }
      })
      .filter((s): s is NonNullable<typeof s> => s !== null && s.ticker.length > 0);

    if (symbols.length === 0) {
      setRows([]);
      return;
    }

    const halts = await connection.getMultipleAccountsInfo(
      symbols.map((s) => haltPda(new PublicKey(s.address))),
    );
    const now = Math.floor(Date.now() / 1000);
    setRows(
      symbols.map((s, i) => {
        const raw = halts[i];
        const halt = raw
          ? decodeHaltState(haltPda(new PublicKey(s.address)).toBase58(), Uint8Array.from(raw.data))
          : null;
        return toRow(s, halt, now);
      }),
    );
  }, [connection, venue]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    fetchXStocks()
      .then(setStocks)
      .catch(() => setStocks([]));
  }, []);

  /* ------------------------------------------------------------ writes */

  const run = useCallback(
    async (label: string, build: () => Transaction, success: string) => {
      if (!publicKey) return;
      setBusy(label);
      setNotice(null);
      try {
        const tx = build();
        const signature = await sendTransaction(tx, connection);
        await connection.confirmTransaction(signature, "confirmed");
        setNotice({ kind: "ok", text: success, tx: signature });
        await refresh();
      } catch (error) {
        const logs = (error as { logs?: string[] })?.logs;
        const explained = explainError(logs);
        setNotice({
          kind: "bad",
          text: explained
            ? `${explained.code}: ${explained.meaning}`
            : (error as Error)?.message ?? "Transaction failed",
        });
      } finally {
        setBusy(null);
      }
    },
    [connection, publicKey, refresh, sendTransaction],
  );

  const createVenue = () =>
    run("venue", () => new Transaction().add(initializeVenue(publicKey!)), "Venue opened.");

  const addSymbol = (stock: XStock) =>
    run(
      `list:${stock.ticker}`,
      () =>
        new Transaction().add(listSymbol(publicKey!, new PublicKey(stock.mint), stock.ticker, 1)),
      `${stock.ticker} listed. It starts halted until you open it.`,
    );

  const publishAdv = (row: SymbolRow, advShares: number) =>
    run(
      `adv:${row.ticker}`,
      () =>
        new Transaction().add(
          updateAdv(venue!, new PublicKey(row.address), publicKey!, advShares),
        ),
      `Published ${advShares.toLocaleString()} share ADV for ${row.ticker}.`,
    );

  const toggleHalt = (row: SymbolRow) =>
    run(
      `halt:${row.ticker}`,
      () =>
        new Transaction().add(
          setHalt(venue!, new PublicKey(row.address), publicKey!, !(row.halt?.halted ?? true)),
        ),
      row.halt?.halted ? `${row.ticker} opened for trading.` : `${row.ticker} halted.`,
    );

  /* -------------------------------------------------------------- step */

  const step: Step = !connected ? 1 : !venueExists ? 2 : rows.length === 0 ? 3 : 4;
  const listed = new Set(rows.map((r) => r.mint));
  const available = (stocks ?? []).filter((s) => !listed.has(s.mint));

  return (
    <section className="console" id="console">
      <div className="wrap">
        <div className="console-head">
          <div>
            <span className="eyebrow">Venue console · devnet</span>
            <h2>Run a venue that cannot break the rules</h2>
            <p>
              Four steps. Each one is a real transaction against the deployed program, and the
              symbols you list are real tokenized equities read live from mainnet.
            </p>
          </div>
        </div>

        <ol className="steps">
          {[
            { n: 1, title: "Connect a wallet", detail: "Devnet. Any Phantom or Solflare wallet." },
            { n: 2, title: "Open your venue", detail: "One transaction. You become its halt and volume publisher." },
            { n: 3, title: "List a symbol", detail: "Pick a real xStock. It starts halted until you open it." },
            { n: 4, title: "Operate it", detail: "Publish volume, open or halt, and watch the cap move." },
          ].map((s) => (
            <li
              key={s.n}
              className={`step ${step === s.n ? "step--now" : step > s.n ? "step--done" : ""}`}
            >
              <span className="step-n">{step > s.n ? "✓" : String(s.n).padStart(2, "0")}</span>
              <span>
                <b>{s.title}</b>
                <span className="step-detail">{s.detail}</span>
              </span>
            </li>
          ))}
        </ol>

        {notice ? (
          <div className={`notice notice--${notice.kind}`}>
            <span>{notice.text}</span>
            {notice.tx ? (
              <a href={EXPLORER("tx", notice.tx)} target="_blank" rel="noreferrer">
                View transaction <ArrowUpRight size={13} />
              </a>
            ) : null}
          </div>
        ) : null}

        {/* ---------------------------------------------------- step 2 */}
        {connected && venueExists === false ? (
          <div className="card card--action">
            <div>
              <h3>You do not have a venue yet</h3>
              <p>
                Opening one creates a venue account owned by your wallet and nominates you as its
                halt publisher and volume publisher. Both roles exist because both inputs originate
                off chain.
              </p>
            </div>
            <button className="btn btn--primary" onClick={createVenue} disabled={busy === "venue"}>
              {busy === "venue" ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
              Open venue
            </button>
          </div>
        ) : null}

        {/* ---------------------------------------------------- step 4 */}
        {venueExists && rows.length > 0 ? (
          <div className="card">
            <div className="card-head">
              <span>Your listed symbols</span>
              <span className="count">{rows.length} listed</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Status</th>
                    <th>Cap usage</th>
                    <th className="num">Prior month ADV</th>
                    <th className="num">Cap</th>
                    <th>Operate</th>
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
                      <td className="num">
                        {row.advShares > 0 ? `${row.advShares.toLocaleString()} sh` : "—"}
                      </td>
                      <td className="num">
                        {row.capShares > 0 ? `${row.capShares.toLocaleString()} sh` : "—"}
                      </td>
                      <td>
                        <div className="row-actions">
                          {row.advShares === 0 ? (
                            <button
                              className="btn btn--small"
                              onClick={() => publishAdv(row, 80_000)}
                              disabled={busy === `adv:${row.ticker}`}
                            >
                              {busy === `adv:${row.ticker}` ? (
                                <Loader2 size={13} className="spin" />
                              ) : null}
                              Publish ADV
                            </button>
                          ) : null}
                          <button
                            className="btn btn--small"
                            onClick={() => toggleHalt(row)}
                            disabled={busy === `halt:${row.ticker}`}
                          >
                            {busy === `halt:${row.ticker}` ? (
                              <Loader2 size={13} className="spin" />
                            ) : null}
                            {row.halt?.halted ? "Open trading" : "Halt"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {/* ------------------------------------------------ step 3 / add */}
        {venueExists ? (
          <div className="card" style={{ marginTop: 20 }}>
            <div className="card-head">
              <span>List a real tokenized equity</span>
              <span className="count">read live from mainnet</span>
            </div>
            {stocks === null ? (
              <div className="empty">Reading mainnet mints…</div>
            ) : available.length === 0 ? (
              <div className="empty">Every mint we track is already listed on your venue.</div>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Mint</th>
                      <th className="num">Stored multiplier</th>
                      <th className="num">In force</th>
                      <th>Reading the obvious field</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {available.map((s) => (
                      <tr key={s.mint}>
                        <td>
                          <div className="ticker">{s.ticker}</div>
                          <div className="sub">{s.name}</div>
                        </td>
                        <td className="num">{s.storedMultiplier.toFixed(7)}</td>
                        <td className="num">{s.effectiveMultiplier.toFixed(7)}</td>
                        <td>
                          {s.stale ? (
                            <span className="status status-capped">
                              <TriangleAlert size={14} strokeWidth={2.2} aria-hidden />
                              understates by {s.understatementPct.toFixed(2)}%
                            </span>
                          ) : (
                            <span className="sub">matches, nothing scheduled</span>
                          )}
                        </td>
                        <td>
                          <button
                            className="btn btn--small"
                            onClick={() => addSymbol(s)}
                            disabled={busy === `list:${s.ticker}`}
                          >
                            {busy === `list:${s.ticker}` ? (
                              <Loader2 size={13} className="spin" />
                            ) : (
                              <Plus size={13} />
                            )}
                            List
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="card-foot">
              These are live mainnet mints. The multiplier in force is frequently not the one in the
              obvious field, and the cap is counted in shares, so a venue reading the wrong field
              misstates its own regulatory volume by that margin.
            </div>
          </div>
        ) : null}

        {!connected ? (
          <div className="card card--action">
            <div>
              <h3>Connect to run your own venue</h3>
              <p>
                You become its halt and volume publisher, and every action from here is a real
                transaction you sign. Devnet only, so it costs nothing.
              </p>
            </div>
            <WalletMultiButton />
          </div>
        ) : null}
      </div>
    </section>
  );
}
