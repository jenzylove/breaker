import { useEffect, useRef, useState } from "react";

// An atmospheric scene rather than a diagram.
//
// The spheres are fills and the rings are breakers. One fill drifts cleanly
// through an open ring. One is held at a closed one, which carries the only
// warm colour in the scene. Nothing here is ornament: the composition says the
// same thing the program does.
//
// Built entirely from gradients and transforms, so it scales to any viewport
// and themes with the rest of the page instead of being a flat asset.

interface Body {
  /** Percentage position within the stage. */
  x: number;
  y: number;
  size: number;
  /** Parallax weight. Far objects move less and blur more. */
  depth: number;
  kind: "glass" | "core" | "ring" | "held";
  delay: number;
}

const BODIES: Body[] = [
  { x: 62, y: 46, size: 30, depth: 1, kind: "core", delay: 0 },
  { x: 40, y: 22, size: 9, depth: 0.55, kind: "glass", delay: -3 },
  { x: 84, y: 24, size: 6.5, depth: 0.4, kind: "glass", delay: -6 },
  { x: 33, y: 72, size: 7.5, depth: 0.5, kind: "glass", delay: -9 },
  { x: 90, y: 70, size: 11, depth: 0.7, kind: "glass", delay: -2 },
  { x: 52, y: 84, size: 5, depth: 0.3, kind: "glass", delay: -7 },
  { x: 46, y: 36, size: 26, depth: 0.8, kind: "ring", delay: -1 },
  { x: 74, y: 74, size: 18, depth: 0.6, kind: "held", delay: -5 },
];

function useParallax(strength = 26) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const onMove = (event: PointerEvent) => {
      setOffset({
        x: (event.clientX / window.innerWidth - 0.5) * strength,
        y: (event.clientY / window.innerHeight - 0.5) * strength,
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [strength]);
  return offset;
}

function Scene() {
  const offset = useParallax();
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div className="scene" ref={ref} aria-hidden>
      <div className="scene-wash" />
      {BODIES.map((b, i) => (
        <div
          key={i}
          className={`body body--${b.kind}`}
          style={
            {
              left: `${b.x}%`,
              top: `${b.y}%`,
              "--size": `${b.size}vmax`,
              "--delay": `${b.delay}s`,
              transform: `translate(-50%, -50%) translate3d(${offset.x * b.depth}px, ${
                offset.y * b.depth
              }px, 0)`,
              filter: b.depth < 0.5 ? `blur(${(0.5 - b.depth) * 14}px)` : undefined,
              opacity: b.depth < 0.5 ? 0.75 : 1,
            } as React.CSSProperties
          }
        >
          {b.kind === "held" ? <span className="body-caught" /> : null}
        </div>
      ))}
    </div>
  );
}

export default function Hero({ onEnter }: { onEnter: () => void }) {
  return (
    <section className="hero">
      <Scene />
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
