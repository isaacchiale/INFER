/**
 * Client-only That Open / web-ifc runtime.
 * Keep this isolated so the INFER shell UI can be swapped without rewriting the viewer.
 */

export type ViewerStatusKind = "info" | "error" | "loading";

export type ThatOpenRuntime = {
  loadBuffer: (buffer: Uint8Array, name: string) => Promise<void>;
  clear: () => Promise<void>;
  dispose: () => void;
};

type StatusFn = (message: string, kind?: ViewerStatusKind) => void;

export async function createThatOpenRuntime(
  container: HTMLElement,
  onStatus?: StatusFn,
): Promise<ThatOpenRuntime> {
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
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  await world.camera.controls.setLookAt(20, 15, 20, 0, 0, 0);

  components.init();
  components.get(OBC.Grids).create(world);

  const fragments = components.get(OBC.FragmentsManager);
  fragments.init("/worker.mjs");

  world.camera.controls.addEventListener("update", () => {
    fragments.core.update();
  });

  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    void fragments.core.update(true);
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

  onStatus?.("3D viewer ready.", "info");

  const clear = async () => {
    for (const id of [...fragments.list.keys()]) {
      await fragments.core.disposeModel(id);
    }
  };

  return {
    clear,
    async loadBuffer(buffer, name) {
      onStatus?.(`Loading ${name} in 3D…`, "loading");
      await clear();
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
      onStatus?.(`3D view loaded: ${name}`, "info");
    },
    dispose() {
      try {
        components.dispose();
      } catch {
        // ignore dispose races
      }
    },
  };
}
