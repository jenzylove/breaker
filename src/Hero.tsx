import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";

// Two fills entering on the same rail and parting at the gate.
//
// The upper one clears a closed breaker and settles. The lower one meets a
// tripped breaker: its pulse stops dead at the contact and the conduit past it
// is drawn as dead line, because nothing moved. The divergence is the product.
//
// Depth is real rather than shaded: rails, gates and pulses sit on separate
// planes under a perspective transform and separate as the pointer moves.

const RAIL_IN = "M -40 300 L 210 300";
const RAIL_UP = "M 210 300 L 330 170 L 560 170";
const RAIL_DOWN_LIVE = "M 210 300 L 330 430 L 452 430";
const RAIL_DOWN_DEAD = "M 452 430 L 760 430";
const RAIL_UP_TAIL = "M 560 170 L 760 170";

function Gate({ x, y, tripped }: { x: number; y: number; tripped: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`} className={tripped ? "gate gate--tripped" : "gate"}>
      <rect x={-54} y={-54} width={108} height={108} rx={20} className="gate-housing" />
      <circle cx={-30} cy={0} r={6} className="gate-node" />
      <circle cx={30} cy={0} r={6} className="gate-node" />
      <line
        className="gate-arm"
        x1={-30}
        y1={0}
        x2={tripped ? 16 : 30}
        y2={tripped ? -34 : 0}
        strokeWidth={6}
        strokeLinecap="round"
      />
    </g>
  );
}

function useTilt(max = 6) {
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const onMove = (event: PointerEvent) => {
      const dx = event.clientX / window.innerWidth - 0.5;
      const dy = event.clientY / window.innerHeight - 0.5;
      setTilt({ x: -dy * max, y: dx * max });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [max]);

  return { ref, tilt };
}

export function HeroArt() {
  const { ref, tilt } = useTilt();
  return (
    <div className="hero-art" ref={ref} aria-hidden>
      <div
        className="hero-scene"
        style={{ transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` }}
      >
        <svg className="hero-svg" viewBox="0 0 760 600" preserveAspectRatio="xMidYMid slice">
          {/* back plane: the venue's quiet bus */}
          <g className="hero-guides" fill="none" strokeWidth={2}>
            <path d="M -40 232 L 150 232 L 250 120 L 760 120" />
            <path d="M -40 368 L 150 368 L 250 490 L 760 490" />
            <path d="M -40 300 L 760 300" strokeDasharray="2 14" />
          </g>

          <path d={RAIL_DOWN_DEAD} className="hero-dead" fill="none" strokeWidth={7} strokeLinecap="round" />

          <g className="hero-rails" fill="none" strokeWidth={7} strokeLinecap="round" strokeLinejoin="round">
            <path d={RAIL_IN} className="hero-live" />
            <path d={RAIL_UP} className="hero-live" />
            <path d={RAIL_UP_TAIL} className="hero-live" />
            <path d={RAIL_DOWN_LIVE} className="hero-live hero-live--doomed" />
          </g>

          <circle r={9} className="hero-pulse">
            <animateMotion dur="4.2s" repeatCount="indefinite" path={`${RAIL_IN} ${RAIL_UP.slice(1)}`} />
          </circle>
          <circle r={9} className="hero-pulse hero-pulse--stopped">
            <animateMotion
              dur="4.2s"
              repeatCount="indefinite"
              path={`${RAIL_IN} ${RAIL_DOWN_LIVE.slice(1)}`}
              keyPoints="0;1;1"
              keyTimes="0;0.62;1"
              calcMode="linear"
            />
          </circle>

          <Gate x={452} y={170} tripped={false} />
          <Gate x={452} y={430} tripped />

          <text x={528} y={128} className="hero-label hero-label--ok">settled</text>
          <text x={528} y={508} className="hero-label hero-label--stop">refused</text>
        </svg>
      </div>
    </div>
  );
}

export default function Hero({ onEnter }: { onEnter: () => void }) {
  return (
    <section className="hero">
      <HeroArt />
      <div className="hero-body">
        <div className="wrap-wide">
          <span className="eyebrow">SEC Innovation Exemption · effective 17 September 2026</span>
          <h1>
            Tokenized stocks can trade
            <br /> on chain now. On conditions
            <br /> no AMM meets.
          </h1>
          <p>
            A liquidity pool cannot see that Nasdaq halted a stock, cannot count its own volume
            against a regulatory cap, and publishes no dollar tape. Breaker is the call a venue
            makes before it settles.
          </p>
          <div className="hero-actions">
            <button className="btn btn--primary" onClick={onEnter}>
              Open the venue console
            </button>
            <a className="btn btn--ghost" href="#proof">
              See it refuse a trade
            </a>
          </div>
        </div>
      </div>
      <button className="hero-scroll" onClick={onEnter} aria-label="Scroll to the console">
        <ArrowDown size={16} />
      </button>
    </section>
  );
}
