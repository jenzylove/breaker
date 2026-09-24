import HeroFlow from "./HeroFlow";

export default function Hero({ onEnter }: { onEnter: () => void }) {
  return (
    <section className="hero">
      <div className="hero-body">
        <div className="wrap-wide hero-grid">
          <div className="hero-copy">
            <h1>
              <span className="thin">Stock tokens don't know</span>
              <br />
              when trading halts.
            </h1>
            <div className="hero-lede">
              <span className="hero-rule" />
              <p>
                Tesla, NVIDIA and Apple now trade on Solana around the clock. When the real exchange
                halts one of them, the pool has no idea and keeps filling orders.{" "}
                <b>Breaker is the check that stops it.</b>
              </p>
            </div>
            <div className="hero-actions">
              <button className="pill pill--solid" onClick={onEnter}>
                Watch it stop a trade
              </button>
              <a className="pill" href="#why">
                Why this matters
              </a>
            </div>
          </div>
          <figure className="hero-visual">
            <figcaption className="hero-visual-head">
              <span>
                <b>One halt, two pools</b>
                <em>What happens to the same stream of orders</em>
              </span>
              <span className="hero-legend">
                <i className="k-order" /> order
                <i className="k-bad" /> filled in a halt
                <i className="k-gate" /> Breaker
              </span>
            </figcaption>
            <div className="hero-visual-body">
              <HeroFlow />
            </div>
          </figure>
        </div>
      </div>
    </section>
  );
}
