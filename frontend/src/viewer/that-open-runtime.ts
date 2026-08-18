/**
 * Client-only That Open / web-ifc runtime.
 * Keep this isolated so the INFER shell UI can be swapped without rewriting the viewer.
 *
 * Navigation:
 * - Orbit — classic CAD orbit around the loaded model centre
 * - Fly — first-person + WASD / Space / Shift (Minecraft creative-style)
 */

import * as THREE from "three";

export type ViewerStatusKind = "info" | "error" | "loading";

export type NavMode = "orbit" | "fly";

export type ThatOpenRuntime = {
  loadBuffer: (buffer: Uint8Array, name: string) => Promise<void>;
  clear: () => Promise<void>;
  setNavMode: (mode: NavMode) => Promise<void>;
  getNavMode: () => NavMode;
  dispose: () => void;
};

type StatusFn = (message: string, kind?: ViewerStatusKind) => void;

const FLY_SPEED = 12; // metres per second
const FLY_FAST_MULT = 2.5; // hold Ctrl to go faster

export async function createThatOpenRuntime(
  container: HTMLElement,
  onStatus?: StatusFn,
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

  world.camera.controls.addEventListener("update", () => {
    fragments.core.update();
  });

  /** Building pivot for Orbit — always the loaded model AABB centre. */
  const orbitTarget = new THREE.Vector3(0, 0, 0);
  let hasOrbitTarget = false;
  let orbitRadius = 25;

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
      return;
    }
    box.getCenter(orbitTarget);
    const size = new THREE.Vector3();
    box.getSize(size);
    orbitRadius = Math.max(size.length() * 0.75, 10);
    hasOrbitTarget = true;
  };

  /** Re-lock orbit pivot to building centre; keep eye position when sane. */
  const reanchorOrbitToBuilding = async () => {
    refreshOrbitTarget();
    const target = hasOrbitTarget ? orbitTarget.clone() : new THREE.Vector3(0, 0, 0);
    const pos = new THREE.Vector3();
    controls.getPosition(pos);

    const dist = pos.distanceTo(target);
    // After FirstPerson, camera is often on top of the old FP target — push out.
    if (!Number.isFinite(dist) || dist < 3) {
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

  let navMode: NavMode = "orbit";
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
  };

  const startFlyLoop = () => {
    stopFlyLoop();
    raf = requestAnimationFrame(flyTick);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  onStatus?.("3D viewer ready.", "info");

  const clear = async () => {
    for (const id of [...fragments.list.keys()]) {
      await fragments.core.disposeModel(id);
    }
    hasOrbitTarget = false;
    orbitTarget.set(0, 0, 0);
  };

  const setNavMode = async (mode: NavMode) => {
    if (mode === navMode) return;
    navMode = mode;

    if (mode === "fly") {
      await world.camera.projection.set("Perspective");
      world.camera.set("FirstPerson");
      controls.truckSpeed = 50;
      controls.verticalDragToForward = false;
      container.focus({ preventScroll: true });
      startFlyLoop();
      onStatus?.(
        "Fly mode: WASD move · Space up · Shift down · Ctrl faster · drag to look",
        "info",
      );
    } else {
      stopFlyLoop();
      const pos = new THREE.Vector3();
      controls.getPosition(pos);
      world.camera.set("Orbit");
      applyOrbitControlTuning(controls);
      refreshOrbitTarget();
      const target = hasOrbitTarget ? orbitTarget.clone() : new THREE.Vector3(0, 0, 0);
      const dist = pos.distanceTo(target);
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
      onStatus?.("Orbit mode · pivot = building centre", "info");
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

      if (navMode === "fly") {
        world.camera.set("FirstPerson");
        controls.truckSpeed = 50;
      } else {
        world.camera.set("Orbit");
        await reanchorOrbitToBuilding();
      }
      onStatus?.(`3D view loaded: ${name}`, "info");
    },
    setNavMode,
    getNavMode: () => navMode,
    dispose() {
      stopFlyLoop();
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
