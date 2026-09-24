/**
 * Client-only That Open / web-ifc runtime.
 * Keep this isolated so the INFER shell UI can be swapped without rewriting the viewer.
 *
 * Navigation:
 * - Orbit — classic CAD orbit around the loaded model centre
 * - Fly — first-person + WASD / Space / Shift (Minecraft creative-style)
 */

import * as THREE from "three";
import {
  threePositionToPlanPose,
  type ViewerCameraPose,
} from "@/lib/viewer-camera-pose";
// Type-only: @thatopen/components itself is still dynamically imported below
// to keep it out of the initial bundle. `import type` is fully erased at
// compile time, so this doesn't reintroduce that cost — it just gives the
// `worlds.create<...>()` generic call below real types instead of trying to
// use the dynamic import's value binding (`const OBC = await import(...)`)
// as a type namespace, which TS doesn't support.
import type {
  OrthoPerspectiveCamera,
  ShadowedScene,
  SimpleRenderer,
} from "@thatopen/components";
import type { FragmentsModel } from "@thatopen/fragments";
import type { ExportableGeometrySource } from "@/lib/live-scene-export";
import { LEGEND } from "@/lib/legend-colors";

export type ViewerStatusKind = "info" | "error" | "loading";

export type NavMode = "orbit" | "fly";

/** What the 3D pane draws: the IFC fragments model, or a portal navmesh. */
export type GeometryDisplayMode = "ifc" | "navmesh";

export type NavmeshThreeRegion = {
  id: string;
  /** Ring in Three metres (Y-up). */
  vertices: Array<{ x: number; y: number; z: number }>;
  holes?: Array<Array<{ x: number; y: number; z: number }>>;
};

export type NavmeshThreePortal = {
  id: string;
  kind: "door" | "space" | "exit";
  /** Door: false = IFC, true = geometry heal. */
  inferred?: boolean;
  point: { x: number; y: number; z: number };
};

export type EvacuationLoadMarker3D = {
  id: string;
  kind: "door" | "exit" | "space" | "stair" | "lift";
  point: { x: number; y: number; z: number };
  load: number;
};

export type ThatOpenRuntime = {
  loadBuffer: (buffer: Uint8Array, name: string) => Promise<void>;
  clear: () => Promise<void>;
  setNavMode: (mode: NavMode) => Promise<void>;
  getNavMode: () => NavMode;
  setGeometryDisplayMode: (mode: GeometryDisplayMode) => void;
  getGeometryDisplayMode: () => GeometryDisplayMode;
  /**
   * Replace the navmesh overlay (Three world metres). Pass null to clear.
   * Callers hide/show the IFC model via {@link setGeometryDisplayMode}.
   */
  setNavmesh: (
    data: { regions: NavmeshThreeRegion[]; portals: NavmeshThreePortal[] } | null,
  ) => void;
  /** Latest camera pose in plan metres + elevation (Three Y-up → IFC XY). */
  getCameraPose: () => ViewerCameraPose;
  /** Loaded model AABB in Three metres, or null if empty. */
  getModelBounds: () => {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  } | null;
  /** Inverse coordination matrix (column-major); undoes COORDINATE_TO_ORIGIN. */
  getCoordinationInverse: () => number[] | null;
  /**
   * Show or clear the active-storey route tube (Three world metres).
   * Pass null or fewer than 2 points to remove.
   */
  setRouteTube: (
    polylines:
      | Array<Array<{ x: number; y: number; z: number }>>
      | Array<{ x: number; y: number; z: number }>
      | null,
  ) => void;
  /**
   * Building-wide evacuation-load markers (Three world metres) — one entry
   * per door/exit/stair/lift with nonzero load. Pass null or [] to clear.
   * Renders as glowing additive sprites, sized/colored by load on the same
   * heat scale the floorplan pane uses (circle = door/exit, square = stair/lift).
   */
  setEvacuationMarkers: (markers: EvacuationLoadMarker3D[] | null) => void;
  /**
   * Smoothly fly the camera to look at a point (Three world metres) — used
   * by the floorplan pane's ranked bottleneck list so clicking an entry
   * jumps the 3D view there, not just the 2D storey.
   */
  flyToCamera: (point: { x: number; y: number; z: number }) => Promise<void>;
  /**
   * Clip / restore IFC geometry by a vertical band in Three.js world Y,
   * or show the full building.
   */
  setStoreyFilter: (filter: StoreyFilter) => Promise<void>;
  /**
   * What the Share flow needs to build a faithful GLB/USDZ export: the
   * loaded fragments models (their geometry has to be re-fetched live and
   * async — see live-scene-export.ts for why reading it off the live
   * Three.js scene doesn't work), the active route tube (a plain Three.js
   * object that doesn't need that), and the current storey clip band, so
   * the export can be cropped to match what the live band-filtered view
   * actually shows instead of always including whole multi-storey items.
   * Null when no model has loaded yet.
   */
  getExportableObjects: () => ExportableGeometrySource | null;
  dispose: () => void;
};

export type StoreyFilter =
  | { kind: "all" }
  | {
      kind: "band";
      /** Three.js world Y — geometry below this is clipped away. */
      minY: number;
      /** Three.js world Y — geometry above this is clipped away (cuts ceiling). */
      maxY: number;
    };

type StatusFn = (message: string, kind?: ViewerStatusKind) => void;
type CameraPoseFn = (pose: ViewerCameraPose) => void;
type ModelBoundsFn = (
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  } | null,
) => void;
type CoordInverseFn = (m: number[] | null) => void;

const FLY_SPEED = 12; // metres per second
const FLY_FAST_MULT = 2.5; // hold Ctrl to go faster

/** Route tube radius (metres). */
const ROUTE_TUBE_RADIUS_M = 0.3;
/** Tube radial / tubular segments. */
const ROUTE_TUBE_RADIAL = 8;
const ROUTE_TUBE_TUBULAR_PER_M = 4;
/** Cap polyline density for TubeGeometry cost. */
const ROUTE_TUBE_MAX_POINTS = 400;

/**
 * Small vertical-gradient canvas texture for the 3D viewport background —
 * exact hex conversions of styles.css's --viewport-grid-strong (top) down
 * to --viewport (bottom), so the void around/under the model reads as an
 * intentional graphite atmosphere instead of flat black. One-time cost (a
 * few KB canvas → texture), not a per-frame one.
 */
function createViewportBackgroundTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#34383d"); // --viewport-grid-strong
  gradient.addColorStop(0.55, "#111315"); // --viewport
  gradient.addColorStop(1, "#0a0b0c"); // slightly darker still at the floor
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Same sequential heat scale as the floorplan pane's evacuationHeatColor
 * (FloorplanSvgLayers.tsx) — green through yellow/orange to the app's real
 * --hazard token and on to a genuinely dark red, so "worst bottleneck"
 * means the same severity in both panes. Exact oklch→sRGB conversions of
 * --evac-heat-low (green), --warning, and the *dark-theme* --hazard/
 * --evac-heat-max values specifically: the 3D viewport is always dark (see
 * styles.css's "Viewport stays graphite-dark in both themes" comment), so
 * it always wants the dark-theme anchors regardless of the app's own
 * light/dark toggle. Plain RGB lerp, not color-mix(in oklch) like the SVG
 * version — this only ever tints a small glow sprite, not a large flat
 * fill, so the perceptual-uniformity difference isn't visible.
 */
const EVAC_HEAT_STOPS: [number, THREE.Color][] = [
  [0, new THREE.Color(0x61bd67)],
  [0.33, new THREE.Color(0xe1ad57)],
  [0.66, new THREE.Color(0xec5a5e)],
  [1, new THREE.Color(0x9b0015)],
];

function evacuationMarkerHeatColor(t: number): THREE.Color {
  const clamped = Math.max(0, Math.min(1, t));
  let lo = EVAC_HEAT_STOPS[0]!;
  let hi = EVAC_HEAT_STOPS[EVAC_HEAT_STOPS.length - 1]!;
  for (let i = 0; i < EVAC_HEAT_STOPS.length - 1; i++) {
    const a = EVAC_HEAT_STOPS[i]!;
    const b = EVAC_HEAT_STOPS[i + 1]!;
    if (clamped >= a[0] && clamped <= b[0]) {
      lo = a;
      hi = b;
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const color = new THREE.Color();
  color.lerpColors(lo[1], hi[1], (clamped - lo[0]) / span);
  return color;
}

/**
 * Colorless (white) glow sprite texture — a soft blurred halo plus a
 * sharper bright core baked into one canvas, tinted per-marker via
 * SpriteMaterial.color rather than baked in, so every marker shares just
 * two textures (one per shape) regardless of how many markers exist.
 * "circle" for doors/exits, "square" for stairs/lifts — same shape
 * convention the 2D plan uses to distinguish portal kinds without relying
 * on color alone.
 */
function createGlowSpriteTexture(shape: "circle" | "square"): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const center = size / 2;

  const fillShape = (radiusPad: number) => {
    if (shape === "circle") {
      ctx.beginPath();
      ctx.arc(center, center, center - radiusPad, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(radiusPad, radiusPad, size - radiusPad * 2, size - radiusPad * 2);
    }
  };

  ctx.filter = "blur(20px)";
  ctx.fillStyle = "#ffffff";
  fillShape(size * 0.28);

  ctx.filter = "none";
  ctx.globalAlpha = 0.9;
  fillShape(size * 0.4);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export async function createThatOpenRuntime(
  container: HTMLElement,
  onStatus?: StatusFn,
  onCameraPose?: CameraPoseFn,
  onModelBounds?: ModelBoundsFn,
  onCoordInverse?: CoordInverseFn,
): Promise<ThatOpenRuntime> {
  // WebGL fails if the canvas is created at 0×0 (common in split panes).
  await waitForSize(container);

  const OBC = await import("@thatopen/components");

  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create<ShadowedScene, OrthoPerspectiveCamera, SimpleRenderer>();

  // Construction only, no .setup() yet — ShadowedScene.setup() builds a
  // DistanceRenderer internally that reads both world.renderer and
  // world.camera.three, and throws if either isn't assigned yet — so scene
  // setup has to happen last, after renderer and camera both exist.
  world.scene = new OBC.ShadowedScene(components);

  world.renderer = new OBC.SimpleRenderer(components, container);
  world.renderer.showLogo = false;
  const rawRenderer = (world.renderer as { three?: THREE.WebGLRenderer } | null)?.three;
  if (rawRenderer) {
    rawRenderer.shadowMap.enabled = true;
    rawRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  world.camera = new OBC.OrthoPerspectiveCamera(components);
  // That Open defaults: dollyToCursor=true, infinityDolly=true, maxDistance≈300.
  // infinityDolly lets you zoom *through* the orbit target; past the pivot the
  // controls collapse (dolly dead / weird FP-like state). Keep classic orbit.
  const controls = world.camera.controls;
  applyOrbitControlTuning(controls);

  // A single warm directional "sun" + a dialed-down flat ambient (the
  // library's stock config is flat-white 1.5/1, which washes out any
  // directional shading) — ShadowedScene also lets this same light cast real
  // shadows (wired below via updateShadows/model traversal), which the
  // plain SimpleScene the viewer used before could not do at all.
  world.scene.setup({
    ambientLight: { color: new THREE.Color(0xffffff), intensity: 0.6 },
    directionalLight: {
      color: new THREE.Color(0xfff1de),
      intensity: 2.4,
      position: new THREE.Vector3(14, 22, 10),
    },
  });
  // Two-tone sky/ground bounce on top of the flat ambient above — the
  // single biggest cheap fix for a CG scene reading as shadeless/flat.
  world.scene.three.add(new THREE.HemisphereLight(0x8fb2d9, 0x2b2620, 0.55));
  // Subtle vertical falloff instead of a flat/void background, built from
  // the app's own --viewport design tokens (see styles.css) rather than an
  // arbitrary color — same "route through the real token system" fix
  // applied to the floorplan pane's marker colors.
  world.scene.three.background = createViewportBackgroundTexture();
  // Invisible except where a shadow actually falls on it — the model's own
  // self-shadowing (wall-on-wall, furniture-on-floor) reads fine up close,
  // but the classic "grounded" contact-shadow look needs a receiver under
  // the whole building, not just whatever floor slab geometry happens to be
  // there. Sits a hair below the grid's own y=0 plane to avoid z-fighting
  // with any real floor mesh that lands exactly on it.
  const shadowGround = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.ShadowMaterial({ opacity: 0.28 }),
  );
  shadowGround.name = "infer-shadow-ground";
  shadowGround.rotation.x = -Math.PI / 2;
  shadowGround.position.y = -0.02;
  shadowGround.receiveShadow = true;
  world.scene.three.add(shadowGround);
  await controls.setLookAt(20, 15, 20, 0, 0, 0);

  components.init();
  components.get(OBC.Grids).create(world);

  const fragments = components.get(OBC.FragmentsManager);
  fragments.init("/worker.mjs");

  const evacuationMarkersGroup = new THREE.Group();
  evacuationMarkersGroup.name = "infer-evacuation-markers";
  evacuationMarkersGroup.visible = false;
  world.scene.three.add(evacuationMarkersGroup);
  const evacuationGlowTextures = {
    circle: createGlowSpriteTexture("circle"),
    square: createGlowSpriteTexture("square"),
  };

  const clearEvacuationMarkerMeshes = () => {
    while (evacuationMarkersGroup.children.length) {
      const child = evacuationMarkersGroup.children[0]!;
      evacuationMarkersGroup.remove(child);
      if (child instanceof THREE.Sprite) child.material.dispose();
    }
  };

  const routeTubeGroup = new THREE.Group();
  routeTubeGroup.name = "infer-route-tube";
  world.scene.three.add(routeTubeGroup);

  const clearRouteTubeMeshes = () => {
    while (routeTubeGroup.children.length) {
      const child = routeTubeGroup.children[0]!;
      routeTubeGroup.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    }
  };

  const addTubeMesh = (points: Array<{ x: number; y: number; z: number }>) => {
    const simplified = simplifyPolyline(points, ROUTE_TUBE_MAX_POINTS);
    if (simplified.length < 2) return;

    const curvePts = simplified.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    // Deduplicate consecutive identical points (breaks CatmullRom).
    const unique: THREE.Vector3[] = [curvePts[0]!];
    for (let i = 1; i < curvePts.length; i++) {
      if (unique[unique.length - 1]!.distanceToSquared(curvePts[i]!) > 1e-8) {
        unique.push(curvePts[i]!);
      }
    }
    if (unique.length < 2) return;

    const curve = new THREE.CatmullRomCurve3(unique, false, "centripetal");
    const length = Math.max(curve.getLength(), 0.5);
    const tubular = Math.max(
      12,
      Math.min(800, Math.ceil(length * ROUTE_TUBE_TUBULAR_PER_M)),
    );
    const geometry = new THREE.TubeGeometry(
      curve,
      tubular,
      ROUTE_TUBE_RADIUS_M,
      ROUTE_TUBE_RADIAL,
      false,
    );
    const material = new THREE.MeshBasicMaterial({
      color: parseInt(LEGEND.route.replace("#", ""), 16),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 10;
    mesh.frustumCulled = false;
    mesh.name = "infer-route-tube-mesh";
    routeTubeGroup.add(mesh);
  };

  const setRouteTube = (
    polylines:
      | Array<Array<{ x: number; y: number; z: number }>>
      | Array<{ x: number; y: number; z: number }>
      | null,
  ) => {
    clearRouteTubeMeshes();
    if (!polylines || polylines.length === 0) {
      routeTubeGroup.visible = false;
      return;
    }
    // Legacy: flat point list → one tube. New: one tube per storey polyline.
    const segments: Array<Array<{ x: number; y: number; z: number }>> =
      Array.isArray(polylines[0]) &&
      typeof (polylines[0] as { x?: number }).x !== "number"
        ? (polylines as Array<Array<{ x: number; y: number; z: number }>>)
        : [polylines as Array<{ x: number; y: number; z: number }>];

    for (const pts of segments) {
      if (pts.length >= 2) addTubeMesh(pts);
    }
    routeTubeGroup.visible = routeTubeGroup.children.length > 0;
  };

  let evacuationMarkers: EvacuationLoadMarker3D[] = [];
  const setEvacuationMarkers = (markers: EvacuationLoadMarker3D[] | null) => {
    evacuationMarkers = markers ?? [];
    clearEvacuationMarkerMeshes();
    if (!evacuationMarkers.length) {
      evacuationMarkersGroup.visible = false;
      return;
    }
    let maxLoad = 0;
    for (const m of evacuationMarkers) if (m.load > maxLoad) maxLoad = m.load;
    for (const m of evacuationMarkers) {
      const heat = maxLoad > 0 ? m.load / maxLoad : 0;
      const isVertical = m.kind === "stair" || m.kind === "lift";
      // Additive blending only actually *glows* once the tinted color pushes
      // past 1.0 per channel — at plain heat-color brightness the markers
      // were confirmed live to render but stay almost imperceptible next to
      // the model at any normal viewing distance (verified: visible only as
      // a faint halo when the camera is right on top of one). Boosting the
      // color is the standard cheap way to get a real glow without a bloom
      // postprocessing pass.
      const glowColor = evacuationMarkerHeatColor(heat).multiplyScalar(2.2);
      const material = new THREE.SpriteMaterial({
        map: isVertical ? evacuationGlowTextures.square : evacuationGlowTextures.circle,
        color: glowColor,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(m.point.x, m.point.y, m.point.z);
      // Stairs/lifts get a slightly larger base so the shape (a square glow
      // vs. a circular one) reads clearly even before the heat-based scale.
      // Sized to read as a real marker from a typical orbit distance
      // (confirmed live: the original 0.5–0.65m base was only visible at
      // point-blank range), not just up close.
      const baseSize = isVertical ? 1.5 : 1.15;
      sprite.scale.setScalar(baseSize * (1 + heat * 1.6));
      sprite.renderOrder = 5;
      sprite.frustumCulled = false;
      sprite.name = `infer-evacuation-marker:${m.id}`;
      evacuationMarkersGroup.add(sprite);
    }
    evacuationMarkersGroup.visible = true;
  };

  const flyToCamera = async (point: { x: number; y: number; z: number }) => {
    // Close enough that the marker actually reads as the subject (unlike
    // refreshOrbitTarget's whole-building framing), at a fixed 3/4-elevated
    // angle rather than reusing the camera's current heading — consistent,
    // predictable framing every time a bottleneck entry is clicked.
    const dist = 6;
    await controls.setLookAt(
      point.x + dist * 0.6,
      point.y + dist * 0.55,
      point.z + dist * 0.6,
      point.x,
      point.y,
      point.z,
      true,
    );
  };

  const navmeshGroup = new THREE.Group();
  navmeshGroup.name = "infer-navmesh";
  world.scene.three.add(navmeshGroup);

  let geometryDisplayMode: GeometryDisplayMode = "ifc";
  let storeyFilter: StoreyFilter = { kind: "all" };
  const storeyClipPlanes: THREE.Plane[] = [
    new THREE.Plane(),
    new THREE.Plane(),
  ];

  const glRenderer = () =>
    (world.renderer as { three?: THREE.WebGLRenderer } | null)?.three ?? null;

  const applyMaterialClipping = (planes: THREE.Plane[]) => {
    for (const [, model] of fragments.list) {
      const obj = (model as { object?: THREE.Object3D }).object;
      if (!obj) continue;
      obj.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          if (!mat || typeof mat !== "object") continue;
          const m = mat as THREE.Material & {
            clippingPlanes?: THREE.Plane[];
            clipShadows?: boolean;
            needsUpdate?: boolean;
          };
          m.clippingPlanes = planes;
          m.clipShadows = true;
          m.needsUpdate = true;
        }
      });
    }
    // Future materials from Fragments LOD swaps.
    try {
      for (const [, material] of fragments.core.models.materials.list) {
        const m = material as THREE.Material & {
          clippingPlanes?: THREE.Plane[];
          clipShadows?: boolean;
          needsUpdate?: boolean;
        };
        if (!m || typeof m !== "object") continue;
        m.clippingPlanes = planes;
        m.clipShadows = true;
        m.needsUpdate = true;
      }
    } catch {
      /* materials list may be unavailable mid-load */
    }
  };

  const applyStoreyFilter = async (next: StoreyFilter) => {
    storeyFilter = next;
    // Only clip while IFC geometry is shown; navmesh stays full-height stacked.
    if (geometryDisplayMode !== "ifc") return;

    const gl = glRenderer();

    if (next.kind === "all") {
      if (gl) {
        gl.clippingPlanes = [];
        gl.localClippingEnabled = false;
      }
      applyMaterialClipping([]);
      try {
        // Restore any category hides (ceilings/roofs) from a prior isolate.
        for (const model of fragments.list.values()) {
          await model.setVisible(undefined, true);
        }
      } catch {
        /* ignore */
      }
      void fragments.core.update(true);
      return;
    }

    // Plane: n·x + c = 0; clip where n·x + c < 0.
    storeyClipPlanes[0]!.set(new THREE.Vector3(0, 1, 0), -next.minY);
    storeyClipPlanes[1]!.set(new THREE.Vector3(0, -1, 0), next.maxY);
    const planes = [storeyClipPlanes[0]!, storeyClipPlanes[1]!];

    if (gl) {
      gl.localClippingEnabled = true;
      gl.clippingPlanes = planes;
    }
    applyMaterialClipping(planes);

    // Explicitly hide ceiling / roof categories so we don't look "through" culled faces.
    try {
      for (const model of fragments.list.values()) {
        await model.setVisible(undefined, true);
        const ceilingCats = await model.getItemsOfCategories([
          /COVERING/i,
          /ROOF/i,
        ]);
        const ceilingIds = Object.values(ceilingCats).flat();
        if (ceilingIds.length) await model.setVisible(ceilingIds, false);
      }
    } catch (err) {
      console.warn("Ceiling hide failed", err);
    }

    void fragments.core.update(true);
  };

  const setStoreyFilter = async (filter: StoreyFilter) => {
    await applyStoreyFilter(filter);
  };

  const clearNavmeshMeshes = () => {
    while (navmeshGroup.children.length) {
      const child = navmeshGroup.children[0]!;
      navmeshGroup.remove(child);
      child.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material;
        if (!mat) return;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      });
    }
  };

  const setIfcModelVisible = (visible: boolean) => {
    for (const [, model] of fragments.list) {
      const obj = (model as { object?: THREE.Object3D }).object;
      if (obj) obj.visible = visible;
    }
  };

  const setGeometryDisplayMode = (mode: GeometryDisplayMode) => {
    geometryDisplayMode = mode;
    const showIfc = mode === "ifc";
    setIfcModelVisible(showIfc);
    navmeshGroup.visible = mode === "navmesh";
    // Keep the route tube in both IFC and navmesh views.
    routeTubeGroup.visible = routeTubeGroup.children.length > 0;
    if (showIfc) {
      void applyStoreyFilter(storeyFilter);
    } else {
      // Stacked navmesh needs the full height — clear global clip planes.
      const gl = glRenderer();
      if (gl) {
        gl.clippingPlanes = [];
        gl.localClippingEnabled = false;
      }
      applyMaterialClipping([]);
    }
    void fragments.core.update(true);
  };

  const setNavmesh = (
    data: { regions: NavmeshThreeRegion[]; portals: NavmeshThreePortal[] } | null,
  ) => {
    clearNavmeshMeshes();
    if (!data) {
      navmeshGroup.visible = geometryDisplayMode === "navmesh";
      return;
    }

    const regionMat = new THREE.MeshBasicMaterial({
      color: 0x94a3b8,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const regionEdgeMat = new THREE.LineBasicMaterial({
      color: 0x64748b,
      transparent: true,
      opacity: 0.95,
    });

    for (const region of data.regions) {
      if (region.vertices.length < 3) continue;
      const avgY =
        region.vertices.reduce((s, v) => s + v.y, 0) / region.vertices.length;
      const shape = new THREE.Shape();
      const first = region.vertices[0]!;
      shape.moveTo(first.x, -first.z);
      for (let i = 1; i < region.vertices.length; i++) {
        const v = region.vertices[i]!;
        shape.lineTo(v.x, -v.z);
      }
      shape.closePath();
      for (const hole of region.holes ?? []) {
        if (hole.length < 3) continue;
        const path = new THREE.Path();
        path.moveTo(hole[0]!.x, -hole[0]!.z);
        for (let i = 1; i < hole.length; i++) {
          path.lineTo(hole[i]!.x, -hole[i]!.z);
        }
        path.closePath();
        shape.holes.push(path);
      }
      const geom = new THREE.ShapeGeometry(shape);
      const pos = geom.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        // Shape is in X/–Z; lift onto storey plane (Three Y).
        const x = pos.getX(i);
        const zShape = pos.getY(i);
        pos.setXYZ(i, x, avgY, -zShape);
      }
      pos.needsUpdate = true;
      geom.computeVertexNormals();
      const mesh = new THREE.Mesh(geom, regionMat.clone());
      mesh.name = `navmesh-region:${region.id}`;
      mesh.renderOrder = 2;
      mesh.frustumCulled = false;
      navmeshGroup.add(mesh);

      const edgePts: number[] = [];
      for (const v of region.vertices) {
        edgePts.push(v.x, avgY + 0.02, v.z);
      }
      edgePts.push(first.x, avgY + 0.02, first.z);
      const edgeGeom = new THREE.BufferGeometry();
      edgeGeom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(edgePts, 3),
      );
      const edge = new THREE.Line(edgeGeom, regionEdgeMat.clone());
      edge.frustumCulled = false;
      navmeshGroup.add(edge);
    }

    for (const portal of data.portals) {
      const hex =
        portal.kind === "exit"
          ? LEGEND.exit
          : portal.kind === "space"
            ? LEGEND.spaceHeal
            : portal.inferred
              ? LEGEND.doorHeal
              : LEGEND.ifcDoor;
      const color = parseInt(hex.replace("#", ""), 16);
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.25, 12, 10),
        new THREE.MeshBasicMaterial({ color }),
      );
      marker.position.set(portal.point.x, portal.point.y + 0.15, portal.point.z);
      marker.name = `navmesh-portal:${portal.id}`;
      marker.frustumCulled = false;
      navmeshGroup.add(marker);
    }

    navmeshGroup.visible = geometryDisplayMode === "navmesh";
  };

  const scratchPos = new THREE.Vector3();
  /** Plan-dot feet: only WASD / placement update this in Fly (not mouse-look). */
  const feetWorld = new THREE.Vector3();
  const scratchFwd = new THREE.Vector3();
  const scratchEye = new THREE.Vector3();
  let feetValid = false;
  let lastPosePublishMs = 0;
  // Declared early — readStandingPosition / fly helpers close over this binding.
  let navMode: NavMode = "orbit";

  /**
   * That Open FirstPerson locks orbit distance to 1 m and mouse-look *orbits the
   * eye* around the target. Collapse that so look ≈ rotate in place, and keep an
   * owned feet position so the floorplan dot never follows that orbit.
   */
  const hardenFirstPersonControls = () => {
    controls.minDistance = 1e-4;
    controls.maxDistance = 1e-4;
    // camera-controls uses `.distance` as the spherical radius eye↔target.
    (controls as { distance: number }).distance = 1e-4;
    controls.truckSpeed = 50;
    controls.verticalDragToForward = false;
    // Look = rotate; avoid left-drag trucking the pivot (that would slide the feet).
    const buttons = (
      controls as {
        mouseButtons: {
          left: number;
          middle: number;
          right: number;
          wheel: number;
        };
      }
    ).mouseButtons;
    // CameraControls.ACTION.ROTATE === 1 in camera-controls.
    buttons.left = 1;
  };

  const captureFeetFromControls = () => {
    // FirstPerson pivot = standing point (eye orbits this when distance > 0).
    controls.getTarget(feetWorld);
    feetValid = true;
  };

  const readStandingPosition = (out: THREE.Vector3) => {
    if (navMode === "fly") {
      if (!feetValid) {
        // First read in Fly: pin to target (pivot), never the orbiting eye.
        controls.getTarget(out);
        feetWorld.copy(out);
        feetValid = true;
        return;
      }
      out.copy(feetWorld);
      return;
    }
    controls.getPosition(out);
  };

  const readLookDirection = (out: THREE.Vector3) => {
    // camera-controls spherical angles stay valid even when FP distance ≈ 0
    // (eye≈target), where getWorldDirection / eye→target become unstable.
    const az = (controls as { azimuthAngle: number }).azimuthAngle;
    const pol = (controls as { polarAngle: number }).polarAngle;
    if (Number.isFinite(az) && Number.isFinite(pol)) {
      // Camera sits at target + offset; look = −offset.
      out.set(
        -Math.sin(pol) * Math.sin(az),
        -Math.cos(pol),
        -Math.sin(pol) * Math.cos(az),
      );
      if (out.lengthSq() > 1e-10) {
        out.normalize();
        return;
      }
    }
    controls.getPosition(scratchEye);
    controls.getTarget(out);
    out.sub(scratchEye);
    if (out.lengthSq() > 1e-10) {
      out.normalize();
      return;
    }
    world.camera.three.updateMatrixWorld(true);
    world.camera.three.getWorldDirection(out);
  };

  const publishCameraPose = (force = false) => {
    if (!onCameraPose) return;
    const now = performance.now();
    // ~20 Hz is enough for the floorplan dot; avoids flooding React state.
    if (!force && now - lastPosePublishMs < 50) return;
    lastPosePublishMs = now;
    readStandingPosition(scratchPos);
    readLookDirection(scratchFwd);
    onCameraPose(
      threePositionToPlanPose(scratchPos, {
        x: scratchFwd.x,
        y: scratchFwd.y,
        z: scratchFwd.z,
      }),
    );
  };

  const getCameraPose = (): ViewerCameraPose => {
    readStandingPosition(scratchPos);
    readLookDirection(scratchFwd);
    return threePositionToPlanPose(scratchPos, {
      x: scratchFwd.x,
      y: scratchFwd.y,
      z: scratchFwd.z,
    });
  };

  world.camera.controls.addEventListener("update", () => {
    fragments.core.update();
    // Always republish (throttled): Fly feet stay pinned via readStandingPosition,
    // but look direction must update the floorplan heading arrow.
    publishCameraPose();
  });
  // "rest" (motion settled below restThreshold), not "update" (fires
  // continuously mid-drag) — recomputing shadow bounds does a depth-buffer
  // render + worker readback, so it only runs once the camera stops, not on
  // every drag tick. updateShadows() itself no-ops while already computing.
  world.camera.controls.addEventListener("rest", () => {
    void world.scene.updateShadows();
  });

  /** Building pivot for Orbit — always the loaded model AABB centre. */
  const orbitTarget = new THREE.Vector3(0, 0, 0);
  const modelBox = new THREE.Box3();
  let hasOrbitTarget = false;
  let orbitRadius = 25;
  /** Inverse of Fragments coordination matrix (column-major 16). */
  let coordinationInverse: number[] | null = null;

  const publishCoordInverse = (m: number[] | null) => {
    coordinationInverse = m;
    onCoordInverse?.(m);
  };

  const refreshOrbitTarget = () => {
    const box = new THREE.Box3();
    for (const [, model] of fragments.list) {
      try {
        const b = (model as { box?: THREE.Box3 }).box;
        if (b && !b.isEmpty()) {
          box.union(b);
          continue;
        }
      } catch {
        /* fall through */
      }
      box.expandByObject((model as { object: THREE.Object3D }).object);
    }
    if (box.isEmpty()) {
      hasOrbitTarget = false;
      modelBox.makeEmpty();
      onModelBounds?.(null);
      controls.setBoundary(undefined);
      return;
    }
    modelBox.copy(box);
    // Track the model's real floor elevation instead of a hardcoded world
    // y≈0 guess — storeys can sit at any real-world elevation, and a fixed
    // offset left the ground plane floating *above* this particular
    // building's floor, geometrically occluding the navmesh region fills
    // (transparent, depthWrite:false) rendered at the true floor height.
    shadowGround.position.y = box.min.y - 0.02;
    box.getCenter(orbitTarget);
    const size = new THREE.Vector3();
    box.getSize(size);
    orbitRadius = Math.max(size.length() * 0.75, 10);
    hasOrbitTarget = true;
    // Fly mode (WASD/Space/Shift/Ctrl) otherwise has no limit at all — a
    // user can truck/forward/elevate away from the building forever with no
    // way back except manually reorienting. The margin scales with the
    // model itself so a small room and a campus-scale building both get a
    // walkable buffer to view the exterior from outside, not just a fixed
    // metre count that'd be cramped on one and pointless on the other.
    // boundaryFriction stays at the library default (0) — a firm stop you
    // can still slide along, not a soft decelerating approach.
    const flyBoundary = box.clone().expandByScalar(Math.max(size.length() * 1.5, 30));
    controls.setBoundary(flyBoundary);
    onModelBounds?.({
      minX: box.min.x,
      maxX: box.max.x,
      minY: box.min.y,
      maxY: box.max.y,
      minZ: box.min.z,
      maxZ: box.max.z,
    });
  };

  /** Re-lock orbit pivot to building centre; optionally force a full-building framing. */
  const reanchorOrbitToBuilding = async (forceFit = false) => {
    refreshOrbitTarget();
    const target = hasOrbitTarget ? orbitTarget.clone() : new THREE.Vector3(0, 0, 0);
    const pos = new THREE.Vector3();
    controls.getPosition(pos);

    const dist = pos.distanceTo(target);
    // After FirstPerson, camera is often on top of the old FP target — push out.
    // On model load, always frame the full AABB.
    if (forceFit || !Number.isFinite(dist) || dist < 3) {
      pos.set(
        target.x + orbitRadius * 0.7,
        target.y + orbitRadius * 0.45,
        target.z + orbitRadius * 0.7,
      );
    }

    applyOrbitControlTuning(controls);
    controls.minDistance = 1;
    controls.maxDistance = Math.max(orbitRadius * 20, 10_000);
    await controls.setLookAt(
      pos.x,
      pos.y,
      pos.z,
      target.x,
      target.y,
      target.z,
      false,
    );
  };

  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    // Fragments never sets these itself (confirmed: no castShadow/receiveShadow
    // anywhere in the package) — every mesh defaults to Object3D's false/false,
    // so without this the shadow-casting light above would light nothing.
    // A one-time traversal right after add isn't enough: fragments streams
    // mesh "tiles" in and out as the view updates (LOD), so tiles that
    // appear later would never get flagged, and this has to re-run on every
    // update cycle, not just once at load (confirmed empirically — a single
    // post-add traversal here left every fragments mesh at castShadow=false
    // even minutes after the model had fully loaded and rendered).
    const applyShadowFlags = () => {
      model.object.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
      });
    };
    model.onViewUpdated.add(applyShadowFlags);
    applyShadowFlags();
    void fragments.core.update(true);
    refreshOrbitTarget();
    void world.scene.updateShadows();
  });

  fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
    if (!("isLodMaterial" in material && material.isLodMaterial)) {
      material.polygonOffset = true;
      material.polygonOffsetUnits = 1;
      material.polygonOffsetFactor = Math.random();
    }
    if (storeyFilter.kind === "band") {
      const m = material as THREE.Material & {
        clippingPlanes?: THREE.Plane[];
        clipShadows?: boolean;
        needsUpdate?: boolean;
      };
      m.clippingPlanes = [storeyClipPlanes[0]!, storeyClipPlanes[1]!];
      m.clipShadows = true;
      m.needsUpdate = true;
    }
  });

  const ifcLoader = components.get(OBC.IfcLoader);
  await ifcLoader.setup({
    autoSetWasm: false,
    wasm: {
      path: "/wasm/",
      absolute: true,
    },
    // Must stay true for georeferenced IFCs (e.g. Trapelo at ~2e5×9e5 m).
    // Float32 WebGL cannot resolve a ~50 m building that far from the origin.
    // Plan-dot alignment uses a centre translation vs footprints instead.
    webIfc: {
      COORDINATE_TO_ORIGIN: true,
    },
  });

  const resize = () => {
    try {
      world.renderer?.resize();
    } catch {
      /* ignore */
    }
  };
  const ro = new ResizeObserver(() => resize());
  ro.observe(container);
  window.addEventListener("resize", resize);
  resize();

  const keys = new Set<string>();
  let raf = 0;
  let lastT = 0;
  /** Fly WASD/Space/Shift only while the pointer is over this pane — otherwise
   * Shift held for floorplan rotate (Shift+scroll) also descends the 3D camera. */
  let pointerInside = false;

  const isTypingTarget = (el: EventTarget | null) => {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  };

  const onPointerEnter = () => {
    pointerInside = true;
  };
  const onPointerLeave = () => {
    pointerInside = false;
    keys.clear();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (navMode !== "fly" || !pointerInside || isTypingTarget(e.target)) return;
    const k = e.code;
    if (
      k === "KeyW" ||
      k === "KeyA" ||
      k === "KeyS" ||
      k === "KeyD" ||
      k === "Space" ||
      k === "ShiftLeft" ||
      k === "ShiftRight" ||
      k === "ControlLeft" ||
      k === "ControlRight"
    ) {
      e.preventDefault();
      keys.add(k);
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.code);
  };

  const stopFlyLoop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastT = 0;
    keys.clear();
  };

  const flyTick = (t: number) => {
    raf = requestAnimationFrame(flyTick);
    if (navMode !== "fly") return;
    const dt = lastT ? Math.min((t - lastT) / 1000, 0.05) : 0;
    lastT = t;
    if (!dt) return;

    const fast =
      keys.has("ControlLeft") || keys.has("ControlRight") ? FLY_FAST_MULT : 1;
    const step = FLY_SPEED * fast * dt;

    let forward = 0;
    let truck = 0;
    let elevate = 0;
    if (keys.has("KeyW")) forward += step;
    if (keys.has("KeyS")) forward -= step;
    if (keys.has("KeyD")) truck += step;
    if (keys.has("KeyA")) truck -= step;
    if (keys.has("Space")) elevate += step;
    if (keys.has("ShiftLeft") || keys.has("ShiftRight")) elevate -= step;

    if (forward) void controls.forward(forward, false);
    if (truck) void controls.truck(truck, 0, false);
    if (elevate) void controls.elevate(elevate, false);
    // Only locomotion moves the plan-dot feet (not mouse-look / controls update).
    if (forward || truck || elevate) {
      // enableTransition=false updates end-state synchronously enough for getTarget.
      controls.getTarget(feetWorld);
      feetValid = true;
      publishCameraPose();
    }
  };

  const startFlyLoop = () => {
    stopFlyLoop();
    raf = requestAnimationFrame(flyTick);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  container.addEventListener("pointerenter", onPointerEnter);
  container.addEventListener("pointerleave", onPointerLeave);

  const clear = async () => {
    clearRouteTubeMeshes();
    clearNavmeshMeshes();
    clearEvacuationMarkerMeshes();
    evacuationMarkers = [];
    evacuationMarkersGroup.visible = false;
    for (const id of [...fragments.list.keys()]) {
      await fragments.core.disposeModel(id);
    }
    hasOrbitTarget = false;
    orbitTarget.set(0, 0, 0);
    modelBox.makeEmpty();
    onModelBounds?.(null);
    controls.setBoundary(undefined);
    publishCoordInverse(null);
  };

  const setNavMode = async (mode: NavMode) => {
    if (mode === navMode) return;
    navMode = mode;

    if (mode === "fly") {
      // Keep current eye — FirstPerson remaps target/distance; pin pivot back.
      const eye = new THREE.Vector3();
      controls.getPosition(eye);
      await world.camera.projection.set("Perspective");
      world.camera.set("FirstPerson");
      hardenFirstPersonControls();
      await controls.moveTo(eye.x, eye.y, eye.z, false);
      hardenFirstPersonControls();
      captureFeetFromControls();
      container.focus({ preventScroll: true });
      startFlyLoop();
      publishCameraPose(true);
      onStatus?.("Fly mode", "info");
    } else {
      stopFlyLoop();
      feetValid = false;
      // Snapshot eye before Orbit mode remaps controls (same as original).
      const pos = new THREE.Vector3();
      controls.getPosition(pos);
      world.camera.set("Orbit");
      applyOrbitControlTuning(controls);
      refreshOrbitTarget();
      const target = hasOrbitTarget ? orbitTarget.clone() : new THREE.Vector3(0, 0, 0);
      const dist = pos.distanceTo(target);
      // Minimal fix only: if collapsed onto the pivot, push to a usable orbit.
      if (!Number.isFinite(dist) || dist < 3) {
        pos.set(
          target.x + orbitRadius * 0.7,
          target.y + orbitRadius * 0.45,
          target.z + orbitRadius * 0.7,
        );
      }
      await controls.setLookAt(
        pos.x,
        pos.y,
        pos.z,
        target.x,
        target.y,
        target.z,
        false,
      );
      publishCameraPose(true);
      onStatus?.("Orbit mode", "info");
    }
    void fragments.core.update(true);
  };

  // Scene lights aren't included here — buildExportGroup adds its own
  // fixed pair unconditionally, since the live scene's lights (including the
  // shadow-casting sun + hemisphere ambient above) are an internal
  // ShadowedScene.setup() implementation detail with no stable handle anyway.
  const getExportableObjects = (): ExportableGeometrySource | null => {
    if (fragments.list.size === 0) return null;
    const fragmentsModels: FragmentsModel[] = [];
    for (const [, model] of fragments.list) fragmentsModels.push(model);
    const plainObjects: THREE.Object3D[] = [];
    if (routeTubeGroup.children.length > 0) plainObjects.push(routeTubeGroup);
    // Only while actually clipping (band + IFC display mode, matching
    // applyStoreyFilter's own guard) — "all" and navmesh mode both render
    // full-height with no clip planes active.
    const clipBand =
      storeyFilter.kind === "band" && geometryDisplayMode === "ifc"
        ? { minY: storeyFilter.minY, maxY: storeyFilter.maxY }
        : null;
    return { fragmentsModels, plainObjects, clipBand };
  };

  return {
    clear,
    async loadBuffer(buffer, name) {
      onStatus?.(`Loading ${name} in 3D…`, "loading");
      await clear();
      resize();
      await ifcLoader.load(buffer, false, name, {
        processData: {
          progressCallback: (value: number) => {
            onStatus?.(
              `Converting ${name}… ${Math.round(value * 100)}%`,
              "loading",
            );
          },
        },
      });
      resize();
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      refreshOrbitTarget();

      // Exact origin undo for georeferenced IFCs (Trapelo etc.).
      // Retry a few frames — matrix is sometimes not ready on the first tick.
      publishCoordInverse(null);
      for (let attempt = 0; attempt < 6; attempt++) {
        let published = false;
        for (const [, model] of fragments.list) {
          try {
            const getMatrix = (
              model as {
                getCoordinationMatrix?: () => Promise<THREE.Matrix4> | THREE.Matrix4;
              }
            ).getCoordinationMatrix;
            if (!getMatrix) continue;
            const matrix = await Promise.resolve(getMatrix.call(model));
            // isMatrix4 is a real runtime marker three.js sets on every
            // Matrix4 instance (Matrix4.prototype.isMatrix4 = true), used
            // deliberately here instead of `instanceof THREE.Matrix4` since
            // that breaks across duplicate three.js copies in node_modules
            // (a real risk with a fragments/components dependency bundling
            // its own three.js) while the marker property doesn't. The
            // installed @types/three just doesn't declare it.
            if (matrix && (matrix as unknown as { isMatrix4?: boolean }).isMatrix4) {
              const mat = matrix as THREE.Matrix4;
              const inv = mat.clone().invert();
              const t = new THREE.Vector3();
              const s = new THREE.Vector3();
              const q = new THREE.Quaternion();
              inv.decompose(t, q, s);
              const tFwd = new THREE.Vector3();
              mat.decompose(tFwd, q, s);
              const shifted = t.lengthSq() > 1e-4 || tFwd.lengthSq() > 1e-4;
              if (shifted) {
                // toArray()'s installed type infers ArrayLike<number> here
                // rather than number[] (a types-def gap, same class as the
                // isMatrix4 one above) — it's a real number[] at runtime.
                publishCoordInverse(Array.from(inv.toArray()));
                published = true;
                break;
              }
            }
          } catch {
            /* model may not expose coordinates yet */
          }
        }
        if (published) break;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        refreshOrbitTarget();
      }

      // Always land in Orbit with the full building framed (ignore prior Fly).
      stopFlyLoop();
      navMode = "orbit";
      world.camera.set("Orbit");
      await reanchorOrbitToBuilding(true);
      publishCameraPose(true);
      setGeometryDisplayMode(geometryDisplayMode);
      await applyStoreyFilter(storeyFilter);
      onStatus?.(`3D view loaded: ${name}`, "info");
    },
    setNavMode,
    getNavMode: () => navMode,
    setGeometryDisplayMode,
    getGeometryDisplayMode: () => geometryDisplayMode,
    setNavmesh,
    setStoreyFilter,
    getCameraPose,
    getModelBounds: () =>
      hasOrbitTarget && !modelBox.isEmpty()
        ? {
            minX: modelBox.min.x,
            maxX: modelBox.max.x,
            minY: modelBox.min.y,
            maxY: modelBox.max.y,
            minZ: modelBox.min.z,
            maxZ: modelBox.max.z,
          }
        : null,
    getCoordinationInverse: () =>
      coordinationInverse ? [...coordinationInverse] : null,
    setRouteTube,
    setEvacuationMarkers,
    flyToCamera,
    getExportableObjects,
    dispose() {
      stopFlyLoop();
      clearRouteTubeMeshes();
      clearNavmeshMeshes();
      clearEvacuationMarkerMeshes();
      evacuationGlowTextures.circle.dispose();
      evacuationGlowTextures.square.dispose();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      container.removeEventListener("pointerenter", onPointerEnter);
      container.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("resize", resize);
      ro.disconnect();
      try {
        components.dispose();
      } catch {
        // ignore dispose races
      }
    },
  };
}

function applyOrbitControlTuning(controls: {
  dollyToCursor: boolean;
  infinityDolly: boolean;
  minDistance: number;
  maxDistance: number;
  truckSpeed: number;
}) {
  controls.dollyToCursor = false;
  controls.infinityDolly = false;
  controls.minDistance = 1;
  controls.maxDistance = 10_000;
  controls.truckSpeed = 2;
}

/** Keep endpoints; stride-sample the middle when over maxCount. */
function simplifyPolyline<T>(points: T[], maxCount: number): T[] {
  if (points.length <= maxCount) return points;
  const out: T[] = [];
  const last = points.length - 1;
  const step = last / (maxCount - 1);
  for (let i = 0; i < maxCount; i++) {
    const idx = i === maxCount - 1 ? last : Math.round(i * step);
    out.push(points[idx]!);
  }
  return out;
}

function waitForSize(el: HTMLElement, timeoutMs = 4000): Promise<void> {
  if (el.clientWidth > 1 && el.clientHeight > 1) return Promise.resolve();
  return new Promise((resolve) => {
    const started = Date.now();
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 1 && el.clientHeight > 1) {
        ro.disconnect();
        resolve();
      }
    });
    ro.observe(el);
    const tick = () => {
      if (el.clientWidth > 1 && el.clientHeight > 1) {
        ro.disconnect();
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        ro.disconnect();
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
