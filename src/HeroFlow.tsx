import { useEffect, useRef } from "react";

// The hero shows the product rather than decorating it. Orders stream into two
// pools. The exchange halts the stock; the signal reaches Breaker's gate, which
// closes, and orders bounce off it. The ordinary pool has no wire to the
// exchange, so it keeps filling, and those fills turn red.
//
// Drawn on a 2D canvas: a few dozen shapes a frame, no library, and it reads
// its colours from the page's tokens so it follows the theme.

const CYCLE = 11; // seconds
const HALT_AT = 3.6;
const OPEN_AT = 8.6;
const PULSE = 0.65; // seconds for the signal to travel the wire

interface Order {
  lane: 0 | 1;
  x: number;
  state: "moving" | "filled" | "refused";
  t: number; // seconds since the state changed
  red: boolean;
}

interface Palette {
  ink: string;
  muted: string;
  grid: string;
  accent: string;
  critical: string;
  good: string;
  surface: string;
  mono: string;
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    ink: v("--ink", "#ffffff"),
    muted: v("--muted", "#898781"),
    grid: v("--grid", "#2c2c2a"),
    accent: v("--accent", "#3987e5"),
    critical: v("--critical", "#d03b3b"),
    good: v("--good", "#0ca30c"),
    surface: v("--surface", "#111722"),
    mono: v("--mono", "monospace"),
  };
}

export default function HeroFlow() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let palette = readPalette();
    const themeWatch = new MutationObserver(() => (palette = readPalette()));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    let w = 0;
    let h = 0;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const sizeWatch = new ResizeObserver(resize);
    sizeWatch.observe(canvas);

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const orders: Order[] = [];
    const spawnEvery = 0.62;
    const sinceSpawn = [0.3, 0];
    let filledDuringHalt = 0;
    let refused = 0;
    let wasHalted = false;
    let clock = still ? 6.2 : 0;
    let last = performance.now();
    let frame = 0;

    // Layout, recomputed from the canvas size each frame.
    const geo = () => {
      const left = 26;
      const pool = w - 48;
      const gate = w * 0.64;
      const exY = 44;
      const laneA = h * 0.42;
      const laneB = h * 0.78;
      return { left, pool, gate, exY, laneA, laneB, speed: Math.max(w * 0.19, 90) };
    };

    const phase = (t: number) => {
      const c = t % CYCLE;
      const halted = c >= HALT_AT && c < OPEN_AT;
      // The gate follows the exchange once the signal has arrived.
      const gateClosed = c >= HALT_AT + PULSE && c < OPEN_AT + PULSE;
      const sinceChange = halted ? c - HALT_AT : c >= OPEN_AT ? c - OPEN_AT : c + CYCLE - OPEN_AT;
      return { c, halted, gateClosed, sinceChange };
    };

    const label = (text: string, x: number, y: number, color: string, align: CanvasTextAlign = "left", size = 12) => {
      ctx.font = `500 ${size}px ${palette.mono}`;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.fillText(text, x, y);
    };

    // Canvas colour parsing of color-mix() is not universal, so alpha is
    // applied to the hex tokens directly.
    const alpha = (color: string, a: number) => {
      const hex = color.replace("#", "");
      if (!/^[0-9a-f]{6}$/i.test(hex)) return color;
      const n = parseInt(hex, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    };

    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (!still) clock += dt;
      const g = geo();
      const p = phase(clock);
      // Each halt starts its own count.
      if (p.halted && !wasHalted && !still) {
        filledDuringHalt = 0;
        refused = 0;
      }
      wasHalted = p.halted;

      ctx.clearRect(0, 0, w, h);

      // --- exchange node, directly above Breaker's gate
      const exW = 212;
      const exX = g.gate - exW / 2;
      ctx.lineWidth = 1;
      ctx.strokeStyle = p.halted ? alpha(palette.critical, 0.7) : alpha(palette.ink, 0.22);
      ctx.fillStyle = p.halted ? alpha(palette.critical, 0.12) : alpha(palette.ink, 0.04);
      ctx.beginPath();
      ctx.roundRect(exX, g.exY - 20, exW, 40, 20);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = p.halted ? palette.critical : palette.good;
      ctx.beginPath();
      ctx.arc(exX + 20, g.exY, 4.5, 0, Math.PI * 2);
      ctx.fill();
      label("NASDAQ · NVDA", exX + 34, g.exY, alpha(palette.ink, 0.85));
      label(p.halted ? "HALTED" : "OPEN", exX + exW - 18, g.exY, p.halted ? palette.critical : palette.good, "right");

      // --- the wire from the exchange to the gate, with a hop over lane A
      const wireTop = g.exY + 20;
      const gateTop = g.laneB - 26;
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = alpha(palette.ink, 0.28);
      ctx.beginPath();
      ctx.moveTo(g.gate, wireTop);
      ctx.lineTo(g.gate, g.laneA - 8);
      ctx.arc(g.gate, g.laneA, 8, -Math.PI / 2, Math.PI / 2, false);
      ctx.lineTo(g.gate, gateTop);
      ctx.stroke();
      ctx.setLineDash([]);

      // Signal pulse travelling down the wire after each change.
      if (p.sinceChange < PULSE) {
        const k = p.sinceChange / PULSE;
        const y = wireTop + (gateTop - wireTop) * k;
        const color = p.halted ? palette.critical : palette.good;
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(g.gate + (Math.abs(y - g.laneA) < 8 ? 8 * Math.cos(Math.asin((y - g.laneA) / 8)) : 0), y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // --- lanes
      for (const [lane, y] of [
        [0, g.laneA],
        [1, g.laneB],
      ] as const) {
        ctx.strokeStyle = alpha(palette.ink, 0.2);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(g.left, y);
        ctx.lineTo(g.pool - 22, y);
        ctx.stroke();

        label(lane === 0 ? "ORDINARY POOL" : "POOL RUNNING BREAKER", g.left, y - 30, alpha(palette.ink, 0.75), "left", 12.5);


      }

      // --- the gate
      const closedness = p.gateClosed
        ? Math.min((p.c - HALT_AT - PULSE) / 0.18, 1)
        : Math.max(1 - Math.max(p.c - OPEN_AT - PULSE, 0) / 0.18, 0) * (p.c >= OPEN_AT ? 1 : 0);
      const gateColor = closedness > 0.5 ? palette.critical : palette.good;
      ctx.lineCap = "round";
      ctx.lineWidth = 4;
      ctx.strokeStyle = gateColor;
      ctx.beginPath();
      // Open: a short post above the lane. Closed: a bar across it.
      const reach = 8 + 26 * closedness;
      ctx.moveTo(g.gate, gateTop);
      ctx.lineTo(g.gate, gateTop + reach + 8 * closedness);
      ctx.stroke();
      ctx.lineCap = "butt";
      label("BREAKER", g.gate + 14, gateTop + 4, alpha(palette.ink, 0.8), "left", 12.5);

      // --- orders
      for (const lane of [0, 1] as const) {
        sinceSpawn[lane] += dt;
        if (!still && sinceSpawn[lane] > spawnEvery) {
          sinceSpawn[lane] = Math.random() * 0.12;
          orders.push({ lane, x: g.left, state: "moving", t: 0, red: false });
        }
      }
      if (still && orders.length === 0) {
        for (let i = 0; i < 7; i += 1) {
          orders.push({ lane: 0, x: g.left + i * (g.pool - g.left) / 7, state: "moving", t: 0, red: i > 3 });
          if (i < 5) orders.push({ lane: 1, x: g.left + i * (g.gate - 14 - g.left) / 5, state: "moving", t: 0, red: false });
        }
      }

      for (let i = orders.length - 1; i >= 0; i -= 1) {
        const o = orders[i];
        const y = o.lane === 0 ? g.laneA : g.laneB;
        o.t += dt;
        if (o.state === "moving" && !still) {
          o.x += g.speed * dt;
          if (o.lane === 1 && p.gateClosed && o.x >= g.gate - 10 && o.x < g.gate) {
            o.state = "refused";
            o.t = 0;
            refused += 1;
          } else if (o.x >= g.pool - 22) {
            o.state = "filled";
            o.t = 0;
            o.red = o.lane === 0 && p.halted;
            if (o.red) filledDuringHalt += 1;
          }
        }

        let a = 1;
        let x = o.x;
        let color = palette.accent;
        if (o.state === "refused") {
          a = Math.max(1 - o.t / 0.6, 0);
          x = o.x - 18 * Math.min(o.t / 0.3, 1);
          color = palette.critical;
        } else if (o.state === "filled") {
          a = Math.max(1 - o.t / 0.35, 0);
          color = o.red ? palette.critical : palette.accent;
        } else if (o.red || (o.lane === 0 && p.halted && o.x > g.gate)) {
          color = palette.critical;
        }
        if (a <= 0) {
          orders.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = a;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x - 10, y - 5, 20, 10, 5);
        ctx.fill();
        if (o.state === "refused") {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          const cx = x - 4;
          const cy = y - 17;
          ctx.beginPath();
          ctx.moveTo(cx - 3, cy - 3);
          ctx.lineTo(cx + 3, cy + 3);
          ctx.moveTo(cx + 3, cy - 3);
          ctx.lineTo(cx - 3, cy + 3);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // A fill during the halt makes the pool flash.
        if (o.state === "filled" && o.red) {
          ctx.strokeStyle = alpha(palette.critical, Math.max(0.8 - o.t * 2, 0));
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(g.pool, y, 22 + o.t * 46, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // --- pool nodes, over the orders so each one slides in
      for (const y of [g.laneA, g.laneB]) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = alpha(palette.ink, 0.42);
        ctx.fillStyle = palette.surface;
        ctx.beginPath();
        ctx.arc(g.pool, y, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        label("POOL", g.pool, y, alpha(palette.ink, 0.55), "center", 9.5);
      }

      // --- what each lane is doing, under it
      const showCounts = p.halted || p.sinceChange < 1.6;
      if (p.halted) {
        label(`STILL FILLING  ${filledDuringHalt}`, g.pool + 22, g.laneA + 40, palette.critical, "right");
        label(`REFUSED  ${refused}`, g.pool + 22, g.laneB + 40, palette.good, "right");
        label("not connected to the exchange", g.left, g.laneA + 40, alpha(palette.ink, 0.5));
      } else if (showCounts && filledDuringHalt + refused > 0) {
        label(`filled ${filledDuringHalt} during the halt`, g.pool + 22, g.laneA + 40, alpha(palette.critical, 0.8), "right");
        label(`refused ${refused} during the halt`, g.pool + 22, g.laneB + 40, alpha(palette.good, 0.8), "right");
      } else {
        label("filling", g.pool + 22, g.laneA + 40, alpha(palette.ink, 0.45), "right");
        label("checked, filling", g.pool + 22, g.laneB + 40, alpha(palette.ink, 0.45), "right");
      }

      if (!still) frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    canvas.classList.add("is-ready");

    return () => {
      cancelAnimationFrame(frame);
      themeWatch.disconnect();
      sizeWatch.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      className="hero-flow"
      role="img"
      aria-label="Orders flow into two pools. When the exchange halts the stock, the pool running Breaker refuses them and the ordinary pool keeps filling."
    />
  );
}
