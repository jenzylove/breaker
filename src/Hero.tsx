import { Suspense, lazy } from "react";

// Three is heavy, so the scene is split out and loaded after the copy paints.
// Until it arrives, and on any device without WebGL, the gradient ground
// underneath stands on its own.
const HeroScene = lazy(() => import("./HeroScene"));

export default function Hero({ onEnter }: { onEnter: () => void }) {
  return (
    <section className="hero">
      <Suspense fallback={null}>
        <HeroScene />
      </Suspense>

      <div className="hero-body">
        <div className="wrap-wide">
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
            <a className="pill" href="#rules">
              Why this matters
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
