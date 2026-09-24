import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// A real-time WebGL scene: a dense cluster of glass drifting through a warm
// shaft of light.
//
// Glass is a physical transmission material, so it genuinely refracts the
// ground behind it. The flat lenses are what make the composition read, and
// they only work with a bright rim: a thin disc with a dull edge is
// indistinguishable from the background.
//
// It carries our meaning without being a diagram. Fills drift through a venue,
// and one is caught inside the single warm ring in the scene.

interface Piece {
  kind: "sphere" | "lens" | "ring" | "wire";
  pos: [number, number, number];
  size: number;
  rot?: [number, number, number];
  /** Far pieces are frosted, which reads as depth without a bokeh pass. */
  frost?: number;
  tint?: string;
  /** Wires only. */
  len?: number;
}

// A tight overlapping cluster, not a scatter. Density is what gives the
// reference its depth; spreading the same objects out flattens it.
const PIECES: Piece[] = [
  // Large lenses, overlapping. The signature element.
  { kind: "lens", pos: [3.15, 0.35, 1.0], size: 1.5, rot: [1.18, 0.3, -0.5] },
  { kind: "lens", pos: [4.45, 1.2, 0.1], size: 1.15, rot: [1.32, -0.25, 0.42] },
  { kind: "lens", pos: [2.25, -0.95, 0.5], size: 1.05, rot: [1.05, 0.62, 0.22] },
  { kind: "lens", pos: [5.05, -0.55, -0.5], size: 0.88, rot: [1.26, 0.12, -0.34] },
  { kind: "lens", pos: [3.6, 1.95, -0.9], size: 0.72, rot: [1.2, -0.48, 0.18], frost: 0.12 },
  { kind: "lens", pos: [1.75, 1.15, -1.3], size: 0.95, rot: [1.3, 0.2, 0.6], frost: 0.16 },

  // Spheres woven through them.
  { kind: "sphere", pos: [2.5, 1.5, 1.4], size: 0.38, frost: 0.02 },
  { kind: "sphere", pos: [4.5, 0.15, 1.2], size: 0.3, frost: 0.02 },
  { kind: "sphere", pos: [1.85, -1.75, 0.8], size: 0.26, frost: 0.12 },
  { kind: "sphere", pos: [4.9, 1.85, 0.5], size: 0.22, frost: 0.18 },
  { kind: "sphere", pos: [5.3, -1.5, 0.9], size: 0.44, frost: 0.03 },
  { kind: "sphere", pos: [3.05, -1.9, -0.2], size: 0.2, frost: 0.22 },
  { kind: "sphere", pos: [1.35, 0.25, 1.6], size: 0.16, frost: 0.05 },

  // Thin wires. Quiet, but they tie the cluster together.
  { kind: "wire", pos: [3.4, 1.0, -0.4], size: 0.008, len: 4.2, rot: [0.3, 0.2, 0.75] },
  { kind: "wire", pos: [4.2, -0.6, 0.2], size: 0.006, len: 3.4, rot: [0.1, -0.3, -0.5] },

  // The one warm object. Everything else is cool, so the eye lands here.
  { kind: "ring", pos: [2.85, -0.45, 1.75], size: 0.6, rot: [1.1, 0.22, -0.32], tint: "#e0705a" },
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
    // Held below 1. The earlier pass was exposed so hot that the glass washed
    // out against the ground and the lenses disappeared entirely.
    renderer.toneMappingExposure = 0.92;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    // The scene is code split, so the canvas arrives a beat after the copy.
    // Fade it in over the placeholder rather than popping an empty area.
    requestAnimationFrame(() => container.classList.add("is-ready"));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      38,
      container.clientWidth / container.clientHeight,
      0.1,
      100,
    );
    camera.position.set(1.9, 0.1, 7.1);
    camera.lookAt(3.3, 0.05, 0.4);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
    scene.environment = envTexture;

    const group = new THREE.Group();
    // Shifted clear of the headline. The cluster wants to sit right of the
    // copy, not across it.
    group.position.x = 0.55;
    scene.add(group);

    const glass = (frost = 0.03, tint?: string) =>
      new THREE.MeshPhysicalMaterial({
        transmission: 1,
        thickness: 0.42,
        roughness: 0.012 + frost,
        ior: 1.52,
        clearcoat: 1,
        clearcoatRoughness: 0.015 + frost * 0.4,
        metalness: 0,
        iridescence: 1,
        iridescenceIOR: 2.0,
        iridescenceThicknessRange: [160, 680],
        color: new THREE.Color("#ffffff"),
        attenuationColor: new THREE.Color(tint ?? "#c4d8f7"),
        attenuationDistance: tint ? 1.0 : 7.5,
        envMapIntensity: 2.6,
        specularIntensity: 1,
        transparent: true,
      });

    const sphereGeo = new THREE.SphereGeometry(1, 64, 64);
    const lensGeo = new THREE.CylinderGeometry(1, 1, 0.032, 128, 1);
    const ringGeo = new THREE.TorusGeometry(1, 0.07, 32, 180);
    const wireGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1);

    const floaters: { mesh: THREE.Object3D; phase: number; amp: number }[] = [];

    for (const piece of PIECES) {
      let mesh: THREE.Mesh;

      if (piece.kind === "wire") {
        mesh = new THREE.Mesh(
          wireGeo,
          new THREE.MeshPhysicalMaterial({
            color: new THREE.Color("#ffffff"),
            roughness: 0.08,
            metalness: 0.2,
            transmission: 0.6,
            thickness: 0.2,
            envMapIntensity: 2.4,
            transparent: true,
            opacity: 0.75,
          }),
        );
        mesh.scale.set(piece.size, piece.len ?? 3, piece.size);
      } else {
        const geo =
          piece.kind === "sphere" ? sphereGeo : piece.kind === "lens" ? lensGeo : ringGeo;
        mesh = new THREE.Mesh(geo, glass(piece.frost ?? 0.03, piece.tint));
        mesh.scale.setScalar(piece.size);
      }

      mesh.position.set(...piece.pos);
      if (piece.rot) mesh.rotation.set(...piece.rot);
      group.add(mesh);
      floaters.push({
        mesh,
        phase: Math.random() * Math.PI * 2,
        amp: piece.kind === "wire" ? 0.02 : 0.04 + Math.random() * 0.07,
      });

      if (piece.kind === "ring") {
        const caught = new THREE.Mesh(
          sphereGeo,
          new THREE.MeshPhysicalMaterial({
            color: new THREE.Color("#e2705c"),
            roughness: 0.07,
            metalness: 0,
            clearcoat: 1,
            clearcoatRoughness: 0.03,
            transmission: 0.5,
            thickness: 0.45,
            ior: 1.45,
            iridescence: 0.75,
            attenuationColor: new THREE.Color("#c8452f"),
            attenuationDistance: 0.8,
            envMapIntensity: 2.2,
            transparent: true,
          }),
        );
        caught.position.set(...piece.pos);
        caught.scale.setScalar(piece.size * 0.5);
        group.add(caught);
        floaters.push({ mesh: caught, phase: floaters[floaters.length - 1].phase, amp: 0.04 });
      }
    }

    /* ----------------------------------------------------------- the marble */

    // Marbling is a surface property, not a shape, so it is painted to a canvas
    // and mapped. An earlier attempt used a torus knot for the swirl and read
    // as a white pretzel suspended in a ball.
    const marbleTexture = (() => {
      const size = 512;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;

      ctx.fillStyle = "#07208c";
      ctx.fillRect(0, 0, size, size);

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

      // Deep blue first, so the lighter veins sit on saturation rather than
      // washing the whole sphere out.
      for (let i = 0; i < 16; i += 1) {
        blob(
          Math.random() * size,
          Math.random() * size,
          70 + Math.random() * 170,
          "rgba(4,22,120,1)",
          0.4 + Math.random() * 0.4,
        );
      }
      for (let i = 0; i < 18; i += 1) {
        const warm = Math.random() > 0.78;
        blob(
          Math.random() * size,
          Math.random() * size,
          35 + Math.random() * 120,
          warm ? "rgba(255,226,206,0.95)" : "rgba(150,210,255,0.95)",
          0.12 + Math.random() * 0.3,
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
    marble.position.set(3.75, 0.3, 1.45);
    group.add(marble);

    const core = new THREE.Mesh(
      sphereGeo,
      new THREE.MeshPhysicalMaterial({
        map: marbleTexture,
        roughness: 0.2,
        metalness: 0.1,
        clearcoat: 1,
        clearcoatRoughness: 0.06,
        // Held well down. At full strength the iridescence bleached the blue to
        // lavender and the marble stopped being the focal point.
        iridescence: 0.35,
        iridescenceIOR: 1.6,
        iridescenceThicknessRange: [200, 520],
        envMapIntensity: 1.15,
      }),
    );
    core.scale.setScalar(0.58);
    marble.add(core);

    const shell = new THREE.Mesh(sphereGeo, glass(0.008));
    shell.scale.setScalar(0.66);
    marble.add(shell);

    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(-4, 3.2, 5);
    scene.add(key);
    // The warm shaft the composition sits in.
    const warm = new THREE.DirectionalLight(0xffb98c, 1.5);
    warm.position.set(4.5, -2.2, 2.6);
    scene.add(warm);
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    /* ------------------------------------------------------------- motion */

    const pointer = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };
    const onPointer = (event: PointerEvent) => {
      target.x = (event.clientX / window.innerWidth - 0.5) * 0.44;
      target.y = (event.clientY / window.innerHeight - 0.5) * 0.3;
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
          f.mesh.position.y = baseY[i] + Math.sin(t * 0.38 + f.phase) * f.amp;
          f.mesh.rotation.z += 0.0007;
        });
        marble.rotation.y = t * 0.14;
        marble.position.y = 0.3 + Math.sin(t * 0.46) * 0.07;
        group.rotation.y = pointer.x * 0.3;
        group.rotation.x = pointer.y * 0.26;
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
