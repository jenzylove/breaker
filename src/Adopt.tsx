// How a venue adopts Breaker.
//
// For a consumer app, code on a landing page is noise. For infrastructure it
// is the product: the whole question a venue operator has is "what do I change
// in my program", and the honest answer is one call. Pyth and Stripe both lead
// with the snippet for the same reason.

const STEPS = [
  {
    n: "1",
    title: "Register your venue",
    body: "One transaction. You name who publishes halts and who publishes daily volume, usually a service mirroring the issuer's feed.",
  },
  {
    n: "2",
    title: "List what you trade",
    body: "Each tokenized stock, with its tier. Breaker reads the mint and refuses anything that is not a real Token-2022 equity.",
  },
  {
    n: "3",
    title: "Add one call before you settle",
    body: "Your swap asks Breaker first. If the stock is halted, the feed has gone quiet, or the trade would breach the daily limit, the whole transaction reverts.",
  },
];

export default function Adopt() {
  return (
    <section className="section adopt-section" id="adopt">
      <div className="wrap">
        <div className="section-head section-head--center">
          <span className="beat">For venues</span>
          <h2>How an exchange adds it</h2>
          <p>
            Breaker is a program on Solana, not a service you route through. A venue calls it the
            same way a protocol reads a price from Pyth: from inside its own swap, before any token
            moves.
          </p>
        </div>

        <div className="adopt-grid">
          <ol className="adopt-steps">
            {STEPS.map((step) => (
              <li key={step.n}>
                <span className="adopt-n">{step.n}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="snippet">
            <div className="snippet-head">
              <span>your_pool.rs</span>
              <span className="snippet-tag">the only change</span>
            </div>
            <pre>
              <code>
                <span className="c">{"// Before the pool moves a single token.\n"}</span>
                {"breaker::cpi::"}
                <span className="k">check_and_record</span>
                {"(\n"}
                {"    CpiContext::new_with_signer(\n"}
                {"        breaker_program,\n"}
                {"        CheckAndRecord {\n"}
                {"            venue, symbol, halt_state,\n"}
                {"            quote_asset, mint, pool,\n"}
                {"        },\n"}
                {"        &[pool_seeds],\n"}
                {"    ),\n"}
                {"    base_amount,\n"}
                {"    quote_amount,\n"}
                {"    side,\n"}
                {")?;\n"}
                <span className="c">{"// Halted, stale or over the limit: the trade reverts."}</span>
              </code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
