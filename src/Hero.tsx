import { ArrowRight } from "lucide-react";

// Bold and still: the headline carries the idea, and nothing else shares the
// first screen.
export default function Hero({ onEnter }: { onEnter: () => void }) {
  return (
    <section className="hero">
      <div className="hero-body">
        <div className="hero-center">
          <a className="hero-note" href="#why">
            <span>New</span>
            The SEC let real US stocks trade on chain from 17 September
          </a>
          <h1>
            Stock tokens don't know
            <br />
            when trading <span className="hero-mark">halts</span>
          </h1>
          <p className="hero-sub">
            When Nasdaq halts a stock, pools trading its token keep filling orders. Breaker is one call
            a venue adds so they stop too.
          </p>
          <div className="hero-actions">
            <button className="pill pill--solid" onClick={onEnter}>
              Try it on devnet <ArrowRight size={15} />
            </button>
            <a className="pill" href="#why">
              Why this matters
            </a>
          </div>
        </div>

      </div>
    </section>
  );
}
