import { useEffect, useRef, useState } from "react";

// Two fills travelling the same trace toward settlement.
//
// The upper path passes a closed breaker and settles. The lower one meets a
// tripped breaker: its pulse stops dead at the gate and the trace beyond is
// drawn as dead conduit, because nothing moved. That is the whole product in
// one picture, and it is the same contrast the devnet proof shows in real
// transactions.
//
// Depth is real rather than drawn: the guides, conduit and live traces sit on
// separate planes under a perspective transform, so they separate as the
// pointer moves. Subtle on purpose - this page is shown to regulators.

const TOP = "M 10 54 L 96 54 L 134 26 L 300 26";
const BOTTOM_LIVE = "M 10 118 L 96 118 L 134 150 L 166 150";
const BOTTOM_DEAD = "M 166 150 L 300 150";

function Breaker({ x, y, tripped }: { x: number; y: number; tripped: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`} className={tripped ? "brk brk--tripped" : "brk"}>
      <rect x={-25} y={-25} width={50} height={50} rx={10} className="brk-housing" />
      <circle cx={-15} cy={0} r={3.2} className="brk-node" />
      <circle cx={15} cy={0} r={3.2} className="brk-node" />
      <line
        className="brk-arm"
        x1={-15}
        y1={0}
        x2={tripped ? 9 : 15}
        y2={tripped ? -16 : 0}
        strokeWidth={2.6}
        strokeLinecap="round"
      />
    </g>
  );
}

/** Clamped pointer parallax. Returns degrees, not pixels, so depth reads. */
function useTilt(max = 5) {
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    const onMove = (event: PointerEvent) => {
      const node = ref.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      // Normalise against the viewport so the art responds across the hero,
      // not only when the pointer is directly over it.
      const dx = (event.clientX - cx) / (window.innerWidth / 2);
      const dy = (event.clientY - cy) / (window.innerHeight / 2);
      setTilt({
        x: Math.max(-1, Math.min(1, -dy)) * max,
        y: Math.max(-1, Math.min(1, dx)) * max,
      });
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [max]);

  return { ref, tilt };
}

export default function HeroArt() {
  const { ref, tilt } = useTilt();

  return (
    <div className="art-stage" ref={ref} aria-hidden={false}>
      <div
        className="art-scene"
        style={{ transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` }}
      >
        {/* back plane: the venue's quiet guide traces */}
        <svg className="art-layer art-layer--back" viewBox="0 0 312 190" role="presentation">
          <g className="art-guides" fill="none" strokeWidth={1}>
            <path d="M 10 80 L 74 80 L 106 50 L 300 50" />
            <path d="M 10 94 L 74 94 L 106 124 L 300 124" />
            <path d="M 10 30 L 60 30" />
            <path d="M 10 174 L 60 174" />
          </g>
        </svg>

        {/* mid plane: dead conduit past the tripped gate */}
        <svg className="art-layer art-layer--mid" viewBox="0 0 312 190" role="presentation">
          <path d={BOTTOM_DEAD} className="art-dead" fill="none" strokeWidth={2.4} strokeLinecap="round" />
        </svg>

        {/* front plane: live traces, gates, pulses */}
        <svg
          className="art-layer art-layer--front"
          viewBox="0 0 312 190"
          role="img"
          aria-label="Two fills on the same trace: one passes a closed breaker and settles, one meets a tripped breaker and is refused"
        >
          <path d={TOP} className="art-live" fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
          <path d={BOTTOM_LIVE} className="art-live" fill="none" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />

          <circle r={3.6} className="art-pulse">
            <animateMotion dur="3.6s" repeatCount="indefinite" path={TOP} />
          </circle>
          {/* travels, then holds at the gate for the rest of the cycle */}
          <circle r={3.6} className="art-pulse art-pulse--stopped">
            <animateMotion
              dur="3.6s"
              repeatCount="indefinite"
              path={BOTTOM_LIVE}
              keyPoints="0;1;1"
              keyTimes="0;0.55;1"
              calcMode="linear"
            />
          </circle>

          <Breaker x={166} y={26} tripped={false} />
          <Breaker x={166} y={150} tripped />

          <text x={202} y={17} className="art-label art-label--ok">settled</text>
          <text x={202} y={183} className="art-label art-label--stop">refused</text>
        </svg>
      </div>
    </div>
  );
}
