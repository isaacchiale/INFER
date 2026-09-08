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

export type ViewerStatusKind = "info" | "error" | "loading";

export type NavMode = "orbit" | "fly";

export type ThatOpenRuntime = {
  loadBuffer: (buffer: Uint8Array, name: string) => Promise<void>;
  clear: () => Promise<void>;
  setNavMode: (mode: NavMode) => Promise<void>;
  getNavMode: () => NavMode;
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
  dispose: () => void;
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
  const world = worlds.create<
    OBC.SimpleScene,
    OBC.OrthoPerspectiveCamera,
    OBC.SimpleRenderer
  >();

  world.scene = new OBC.SimpleScene(components);
  world.scene.setup();
  world.scene.three.background = null;

  world.renderer = new OBC.SimpleRenderer(components, container);
  world.renderer.showLogo = false;
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  // That Open defaults: dollyToCursor=true, infinityDolly=true, maxDistance≈300.
  // infinityDolly lets you zoom *through* the orbit target; past the pivot the
  // controls collapse (dolly dead / weird FP-like state). Keep classic orbit.
  const controls = world.camera.controls;
  applyOrbitControlTuning(controls);
  await controls.setLookAt(20, 15, 20, 0, 0, 0);

  components.init();
  components.get(OBC.Grids).create(world);

  const fragments = components.get(OBC.FragmentsManager);
  fragments.init("/worker.mjs");

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
      color: 0x3b82f6,
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
      return;
    }
    modelBox.copy(box);
    box.getCenter(orbitTarget);
    const size = new THREE.Vector3();
    box.getSize(size);
    orbitRadius = Math.max(size.length() * 0.75, 10);
    hasOrbitTarget = true;
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
    void fragments.core.update(true);
    refreshOrbitTarget();
  });

  fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
    if (!("isLodMaterial" in material && material.isLodMaterial)) {
      material.polygonOffset = true;
      material.polygonOffsetUnits = 1;
      material.polygonOffsetFactor = Math.random();
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

  const isTypingTarget = (el: EventTarget | null) => {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (navMode !== "fly" || isTypingTarget(e.target)) return;
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

  onStatus?.("3D viewer ready.", "info");

  const clear = async () => {
    clearRouteTubeMeshes();
    for (const id of [...fragments.list.keys()]) {
      await fragments.core.disposeModel(id);
    }
    hasOrbitTarget = false;
    orbitTarget.set(0, 0, 0);
    modelBox.makeEmpty();
    onModelBounds?.(null);
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
            if (matrix && (matrix as THREE.Matrix4).isMatrix4) {
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
                publishCoordInverse(inv.toArray());
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
      onStatus?.(`3D view loaded: ${name}`, "info");
    },
    setNavMode,
    getNavMode: () => navMode,
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
    dispose() {
      stopFlyLoop();
      clearRouteTubeMeshes();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
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
