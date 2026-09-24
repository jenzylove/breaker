import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// A real-time WebGL scene.
//
// The composition is a field of glass: spheres and flat lenses scattered in
// depth, with one marble carrying the eye. Everything uses a physical
// transmission material, so the glass genuinely refracts what is behind it
// rather than being a light coloured gradient standing in for refraction.
//
// It reads as our product without being a diagram: fills drifting through a
// venue, one of them caught inside a ring.

interface Piece {
  kind: "sphere" | "lens" | "ring";
  pos: [number, number, number];
  size: number;
  /** Tilt for lenses and rings. */
  rot?: [number, number, number];
  /** Far pieces are frosted, which reads as depth without a bokeh pass. */
  frost?: number;
  tint?: string;
}

const PIECES: Piece[] = [
  // Foreground glass, scattered across the right half.
  { kind: "sphere", pos: [2.35, 1.45, 1.5], size: 0.34, frost: 0.05 },
  { kind: "sphere", pos: [4.15, 0.95, -0.4], size: 0.46, frost: 0.03 },
  { kind: "sphere", pos: [1.55, -1.5, 0.9], size: 0.26, frost: 0.18 },
  { kind: "sphere", pos: [3.5, -1.85, 0.8], size: 0.2, frost: 0.22 },
  { kind: "sphere", pos: [5.0, -1.25, 0.6], size: 0.55, frost: 0.04 },
  { kind: "sphere", pos: [4.6, 2.05, 0.9], size: 0.17, frost: 0.26 },
  { kind: "sphere", pos: [0.85, 1.85, -0.8], size: 0.22, frost: 0.3 },

  // Flat lenses, the signature of the reference. Thin discs caught at angles.
  { kind: "lens", pos: [2.9, 0.55, 0.35], size: 1.15, rot: [1.15, 0.35, -0.42] },
  { kind: "lens", pos: [4.75, 1.75, -0.7], size: 0.78, rot: [1.35, -0.2, 0.55] },
  { kind: "lens", pos: [1.95, -0.85, -0.5], size: 0.92, rot: [1.05, 0.6, 0.28] },
  { kind: "lens", pos: [5.35, -0.15, -0.9], size: 0.62, rot: [1.28, 0.1, -0.3] },
  { kind: "lens", pos: [3.15, 2.25, -1.2], size: 0.55, rot: [1.2, -0.45, 0.2], frost: 0.2 },

  // The one warm element: a ring holding a fill. The only colour that is not
  // cool in the whole scene, which is why the eye lands on it.
  { kind: "ring", pos: [3.05, -0.35, 1.3], size: 0.62, rot: [1.12, 0.2, -0.35], tint: "#e07a68" },
];

export default function HeroScene() {
  const mount = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = mount.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch {
      return; // No WebGL. The gradient ground behind this is the fallback.
    }

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      40,
      container.clientWidth / container.clientHeight,
      0.1,
      100,
    );
    camera.position.set(1.6, 0, 8.2);
    camera.lookAt(2.9, 0, 0);

    // The environment is what the glass reflects and refracts. Without one a
    // transmission material renders as flat grey.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    scene.environment = envTexture;

    const group = new THREE.Group();
    scene.add(group);

    const glass = (frost = 0.05, tint?: string) =>
      new THREE.MeshPhysicalMaterial({
        transmission: 1,
        thickness: 0.55,
        roughness: 0.015 + frost,
        ior: 1.5,
        clearcoat: 1,
        clearcoatRoughness: 0.02 + frost * 0.5,
        metalness: 0,
        iridescence: 1,
        iridescenceIOR: 1.9,
        iridescenceThicknessRange: [140, 560],
        color: new THREE.Color("#ffffff"),
        attenuationColor: new THREE.Color(tint ?? "#cfe0fb"),
        attenuationDistance: tint ? 1.2 : 6.5,
        envMapIntensity: 2.1,
        specularIntensity: 1,
        transparent: true,
      });

    const sphereGeo = new THREE.SphereGeometry(1, 64, 64);
    const lensGeo = new THREE.CylinderGeometry(1, 1, 0.045, 96, 1);
    const ringGeo = new THREE.TorusGeometry(1, 0.075, 32, 160);

    const floaters: { mesh: THREE.Object3D; phase: number; amp: number }[] = [];

    for (const piece of PIECES) {
      const geo =
        piece.kind === "sphere" ? sphereGeo : piece.kind === "lens" ? lensGeo : ringGeo;
      const mesh = new THREE.Mesh(geo, glass(piece.frost ?? 0.05, piece.tint));
      mesh.position.set(...piece.pos);
      mesh.scale.setScalar(piece.size);
      if (piece.rot) mesh.rotation.set(...piece.rot);
      group.add(mesh);
      floaters.push({
        mesh,
        phase: Math.random() * Math.PI * 2,
        amp: 0.05 + Math.random() * 0.09,
      });

      // The warm ring holds a fill, which is the whole point of the scene.
      if (piece.kind === "ring") {
        const caught = new THREE.Mesh(
          sphereGeo,
          new THREE.MeshPhysicalMaterial({
            color: new THREE.Color("#e2705c"),
            roughness: 0.08,
            metalness: 0,
            clearcoat: 1,
            clearcoatRoughness: 0.04,
            transmission: 0.55,
            thickness: 0.5,
            ior: 1.45,
            iridescence: 0.8,
            attenuationColor: new THREE.Color("#c8452f"),
            attenuationDistance: 0.9,
            envMapIntensity: 1.8,
            transparent: true,
          }),
        );
        caught.position.set(...piece.pos);
        caught.scale.setScalar(piece.size * 0.52);
        group.add(caught);
        floaters.push({ mesh: caught, phase: floaters[floaters.length - 1].phase, amp: 0.05 });
      }
    }

    /* ----------------------------------------------------------- the marble */

    // The focal point. Marbling is a surface property, not a shape, so it is
    // painted procedurally and mapped onto the core. An earlier attempt used a
    // torus knot for the swirl and read as a white pretzel suspended in a ball.
    const marbleTexture = (() => {
      const size = 512;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;

      ctx.fillStyle = "#122f9e";
      ctx.fillRect(0, 0, size, size);

      // Layered soft blobs read as depth in the glass once lit.
      const blob = (x: number, y: number, r: number, colour: string, alpha: number) => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, colour);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.globalAlpha = alpha;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      };

      for (let i = 0; i < 26; i += 1) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const r = 40 + Math.random() * 170;
        const warm = Math.random() > 0.72;
        blob(
          x,
          y,
          r,
          warm ? "rgba(255,238,228,0.9)" : "rgba(235,244,255,0.85)",
          0.14 + Math.random() * 0.3,
        );
      }
      for (let i = 0; i < 12; i += 1) {
        blob(
          Math.random() * size,
          Math.random() * size,
          60 + Math.random() * 150,
          "rgba(20,60,210,0.95)",
          0.2 + Math.random() * 0.3,
        );
      }
      ctx.globalAlpha = 1;

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      return texture;
    })();

    const marble = new THREE.Group();
    marble.position.set(3.85, 0.25, 1.1);
    group.add(marble);

    const core = new THREE.Mesh(
      sphereGeo,
      new THREE.MeshPhysicalMaterial({
        map: marbleTexture,
        roughness: 0.24,
        metalness: 0.12,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
        iridescence: 0.9,
        iridescenceIOR: 2,
        iridescenceThicknessRange: [200, 680],
        envMapIntensity: 1.35,
      }),
    );
    core.scale.setScalar(0.52);
    marble.add(core);

    // A clear shell just proud of the core, so there is a band of glass and a
    // highlight sitting over the marbling.
    const shell = new THREE.Mesh(sphereGeo, glass(0.01));
    shell.scale.setScalar(0.6);
    marble.add(shell);

    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(-4, 3.2, 5);
    scene.add(key);
    const warm = new THREE.DirectionalLight(0xffcfae, 1.1);
    warm.position.set(4.5, -2, 3);
    scene.add(warm);
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    /* ------------------------------------------------------------- motion */

    const pointer = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };
    const onPointer = (event: PointerEvent) => {
      target.x = (event.clientX / window.innerWidth - 0.5) * 0.5;
      target.y = (event.clientY / window.innerHeight - 0.5) * 0.34;
    };
    if (!reduced) window.addEventListener("pointermove", onPointer, { passive: true });

    const onResize = () => {
      const { clientWidth: w, clientHeight: h } = container;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    // A WebGL loop running behind three screens of content is a battery bug.
    let visible = true;
    const visibility = new IntersectionObserver(([e]) => (visible = e.isIntersecting), {
      threshold: 0,
    });
    visibility.observe(container);

    const clock = new THREE.Clock();
    const baseY = floaters.map((f) => f.mesh.position.y);
    let frame = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (!visible || document.hidden) return;

      const t = clock.getElapsedTime();
      pointer.x += (target.x - pointer.x) * 0.04;
      pointer.y += (target.y - pointer.y) * 0.04;

      if (!reduced) {
        floaters.forEach((f, i) => {
          f.mesh.position.y = baseY[i] + Math.sin(t * 0.42 + f.phase) * f.amp;
          f.mesh.rotation.z += 0.0009;
        });
        marble.rotation.y = t * 0.16;
        marble.position.y = 0.25 + Math.sin(t * 0.5) * 0.08;

        group.rotation.y = pointer.x * 0.35;
        group.rotation.x = pointer.y * 0.3;
      }

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibility.disconnect();
      window.removeEventListener("pointermove", onPointer);
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        }
      });
      marbleTexture.dispose();
      envTexture.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div className="hero-canvas" ref={mount} aria-hidden />;
}
