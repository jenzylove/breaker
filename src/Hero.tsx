import { Suspense, lazy } from "react";

// Three is a heavy dependency, so the scene is split out and loaded after the
// copy paints. Until it arrives, and on any device without WebGL, the
// atmospheric ground underneath stands on its own.
const HeroScene = lazy(() => import("./HeroScene"));

export default function Hero({ onEnter }: { onEnter: () => void }) {
  return (
    <section className="hero">
      <Suspense fallback={null}>
        <HeroScene />
      </Suspense>

      <div className="hero-body">
        <div className="wrap-wide">
          <span className="eyebrow">SEC Innovation Exemption · effective 17 September 2026</span>
          <h1>
            <span className="thin">Tokenized stocks trade</span>
            <br />
            on chain now.
          </h1>
          <div className="hero-lede">
            <span className="hero-rule" />
            <p>
              Under conditions <b>no liquidity pool meets</b>. It cannot see a halt, cannot count
              its volume against a regulatory cap, and publishes no tape. Breaker is the call a
              venue makes before it settles.
            </p>
          </div>
          <div className="hero-actions">
            <button className="pill pill--solid" onClick={onEnter}>
              Open the venue console
            </button>
            <a className="pill" href="#proof">
              See it refuse a trade
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
