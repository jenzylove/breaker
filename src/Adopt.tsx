// How a venue adopts Breaker.
//
// For a consumer app, code on a landing page is noise. For infrastructure it
// is the product: the whole question a venue developer has is "what do I change
// in my program", and the honest answer is one call. The code shown is the real
// difference between the two pools in the demo, so the section and the demo
// prove each other.

import { ArrowDown, ArrowUpRight } from "lucide-react";

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

export default function Adopt() {
  const toDemo = () =>
    document.getElementById("demo")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <section className="section adopt-section" id="adopt">
      <div className="wrap">
        <div className="section-head section-head--center">
          <span className="beat">For venues</span>
          <h2>How an exchange plugs it in</h2>
          <p>
            Breaker is not a site anyone trades on. It is a program on Solana that other trading
            programs call. The developer of a pool or exchange adds one call to their swap, and from
            then on every trade on that venue has to pass three checks before any token moves.
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
              If any check fails, the whole trade is cancelled. No token moves and nobody is filled
              at a price the market has not set.
            </p>
          </div>

          <div className="adopt-code">
            <div className="snippet">
              <div className="snippet-head">
                <span>reference-pool/src/lib.rs</span>
                <span className="snippet-tag">the only change</span>
              </div>
              <pre>
                <code>
                  <span className="ln">{"pub fn swap(ctx, base_amount) -> Result<()> {\n"}</span>
                  <span className="ln">{"    let quote_out = quote_for_base(..)?;\n"}</span>
                  <span className="ln">{"\n"}</span>
                  <span className="ln ln--add">{"+   breaker::cpi::check_and_record(\n"}</span>
                  <span className="ln ln--add">{"+       CpiContext::new_with_signer(\n"}</span>
                  <span className="ln ln--add">{"+           breaker_program,\n"}</span>
                  <span className="ln ln--add">{"+           CheckAndRecord { venue, symbol, halt_state,\n"}</span>
                  <span className="ln ln--add">{"+                            quote_asset, mint, pool },\n"}</span>
                  <span className="ln ln--add">{"+           &[pool_seeds],\n"}</span>
                  <span className="ln ln--add">{"+       ),\n"}</span>
                  <span className="ln ln--add">{"+       base_amount, quote_out, side,\n"}</span>
                  <span className="ln ln--add">{"+   )?;\n"}</span>
                  <span className="ln">{"\n"}</span>
                  <span className="ln">
                    {"    settle(..)  "}
                    <span className="c">{"// tokens move only if the check passed\n"}</span>
                  </span>
                  <span className="ln">{"}"}</span>
                </code>
              </pre>
            </div>

            <div className="adopt-proof">
              <p>
                This is the whole difference between the two pools in the demo above. The ordinary
                pool is the same function without the added lines.
              </p>
              <div className="adopt-proof-links">
                <button className="link link--button" onClick={toDemo}>
                  Watch it run <ArrowDown size={13} />
                </button>
                <a className="link" href={`${SOURCE}#L69`} target="_blank" rel="noreferrer">
                  Ordinary swap <ArrowUpRight size={13} />
                </a>
                <a className="link" href={`${SOURCE}#L99`} target="_blank" rel="noreferrer">
                  Swap with Breaker <ArrowUpRight size={13} />
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
