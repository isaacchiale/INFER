import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { buildExportGroup, type ExportableGeometrySource } from "./live-scene-export.ts";
import type { FragmentsModel, MeshData } from "@thatopen/fragments";

/**
 * Minimal stand-in for a real FragmentsModel, shaped to match the actual
 * @thatopen/fragments@3.4.7 API (verified directly against
 * node_modules/@thatopen/fragments/dist/index.d.ts and cross-checked
 * against a real consumer, @thatopen/components' EdgesProjector, which
 * uses this exact API the same way: `mesh.applyMatrix4(transform);
 * mesh.applyMatrix4(model.object.matrixWorld)`).
 */
function fakeModel(opts: {
  visibleItems?: number[];
  allLocalIds?: number[];
  geometryByLocalId: Map<number, MeshData[]>;
  styleByLocalId?: Map<number, { color: THREE.Color; opacity: number; transparent: boolean }>;
  objectTransform?: THREE.Matrix4;
}): FragmentsModel {
  const object = new THREE.Object3D();
  if (opts.objectTransform) object.matrix.copy(opts.objectTransform);
  object.matrixAutoUpdate = false;
  object.updateMatrixWorld(true);

  const model = {
    object,
    visibleItems: new Set(opts.visibleItems ?? []),
    async getLocalIds() {
      return opts.allLocalIds ?? Array.from(opts.geometryByLocalId.keys());
    },
    async getItemsGeometry(localIds: number[]) {
      return localIds.map((id) => opts.geometryByLocalId.get(id) ?? []);
    },
    async getItemsMaterialDefinition(localIds: number[]) {
      const styles = opts.styleByLocalId;
      if (!styles) return [];
      const out: { definition: { color: THREE.Color; opacity: number; transparent: boolean }; localIds: number[] }[] = [];
      for (const id of localIds) {
        const style = styles.get(id);
        if (style) out.push({ definition: style, localIds: [id] });
      }
      return out;
    },
  };
  return model as unknown as FragmentsModel;
}

function boxMeshData(color?: THREE.Color): MeshData {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const pos = geo.getAttribute("position");
  const idx = geo.getIndex()!;
  return {
    transform: new THREE.Matrix4(),
    positions: Float32Array.from(pos.array),
    indices: Uint16Array.from(idx.array as ArrayLike<number>),
    localId: 1,
  };
}

/** A box mesh spanning exactly [minY, maxY] in world Y, for clip-band tests. */
function boxMeshDataSpanningY(minY: number, maxY: number): MeshData {
  const geo = new THREE.BoxGeometry(2, maxY - minY, 2);
  geo.translate(0, (minY + maxY) / 2, 0);
  const pos = geo.getAttribute("position");
  const idx = geo.getIndex()!;
  return {
    transform: new THREE.Matrix4(),
    positions: Float32Array.from(pos.array),
    indices: Uint16Array.from(idx.array as ArrayLike<number>),
    localId: 1,
  };
}

function yBounds(mesh: THREE.Mesh): { minY: number; maxY: number } {
  const bbox = new THREE.Box3().setFromBufferAttribute(mesh.geometry.getAttribute("position") as THREE.BufferAttribute);
  return { minY: bbox.min.y, maxY: bbox.max.y };
}

function tubeMesh(): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(2, 1, 0),
  ]);
  const geometry = new THREE.TubeGeometry(curve, 8, 0.1, 6, false);
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x1d4ed8, transparent: true, opacity: 0.85 }));
}

function makeSource(opts: {
  fragmentsModels?: FragmentsModel[];
  plainObjects?: THREE.Object3D[];
  clipBand?: { minY: number; maxY: number } | null;
}): ExportableGeometrySource {
  return {
    fragmentsModels: opts.fragmentsModels ?? [],
    plainObjects: opts.plainObjects ?? [],
    clipBand: opts.clipBand ?? null,
  };
}

describe("buildExportGroup — fragments models (async data API)", () => {
  it("rebuilds a visible item's geometry with the right color", async () => {
    const color = new THREE.Color(0xff0000);
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshData()]]]),
      styleByLocalId: new Map([[1, { color, opacity: 1, transparent: false }]]),
    });

    const { group, hasBuildingGeometry } = await buildExportGroup(makeSource({ fragmentsModels: [model] }));
    assert.equal(hasBuildingGeometry, true);
    const meshes = group.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
    assert.equal(meshes.length, 1);
    assert.equal((meshes[0]!.material as THREE.MeshStandardMaterial).color.getHex(), 0xff0000);
  });

  it("composes the item's own transform with the model's world transform (modelMatrix * itemTransform)", async () => {
    const itemTransform = new THREE.Matrix4().makeTranslation(5, 0, 0);
    const part: MeshData = { ...boxMeshData(), transform: itemTransform };
    const modelTransform = new THREE.Matrix4().makeTranslation(100, 0, 0);
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [part]]]),
      objectTransform: modelTransform,
    });

    const { group } = await buildExportGroup(makeSource({ fragmentsModels: [model] }));
    const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    const bbox = new THREE.Box3().setFromBufferAttribute(mesh.geometry.getAttribute("position") as THREE.BufferAttribute);
    const center = bbox.getCenter(new THREE.Vector3());
    assert.ok(Math.abs(center.x - 105) < 1e-6, `expected x~105, got ${center.x}`);
  });

  it("falls back to getLocalIds() when visibleItems is empty (nothing rendered yet)", async () => {
    const model = fakeModel({
      visibleItems: [],
      allLocalIds: [7],
      geometryByLocalId: new Map([[7, [boxMeshData()]]]),
    });
    const { hasBuildingGeometry } = await buildExportGroup(makeSource({ fragmentsModels: [model] }));
    assert.equal(hasBuildingGeometry, true);
  });

  it("defaults color/opacity when no material definition is returned for an item", async () => {
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshData()]]]),
      // no styleByLocalId at all
    });
    const { group } = await buildExportGroup(makeSource({ fragmentsModels: [model] }));
    const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;
    assert.equal(material.opacity, 1);
    assert.equal(material.transparent, false);
  });

  it("skips a part with no usable positions rather than throwing", async () => {
    const badPart: MeshData = { transform: new THREE.Matrix4(), positions: new Float32Array(0) };
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [badPart]]]),
    });
    const { group, hasBuildingGeometry } = await buildExportGroup(makeSource({ fragmentsModels: [model] }));
    assert.equal(hasBuildingGeometry, false);
    assert.equal(group.children.filter((c) => (c as THREE.Mesh).isMesh).length, 0);
  });

  it("keeps geometry from other models when one model's query throws", async () => {
    const good = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshData()]]]),
    });
    const broken = {
      object: new THREE.Object3D(),
      visibleItems: new Set([1]),
      async getLocalIds() {
        return [1];
      },
      async getItemsGeometry() {
        throw new Error("worker unavailable");
      },
      async getItemsMaterialDefinition() {
        return [];
      },
    } as unknown as FragmentsModel;

    const { group, hasBuildingGeometry } = await buildExportGroup(makeSource({ fragmentsModels: [broken, good] }));
    assert.equal(hasBuildingGeometry, true);
    assert.equal(group.children.filter((c) => (c as THREE.Mesh).isMesh).length, 1);
  });

  it("includes multiple mesh parts for a single item", async () => {
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshData(), boxMeshData()]]]),
    });
    const { group } = await buildExportGroup(makeSource({ fragmentsModels: [model] }));
    assert.equal(group.children.filter((c) => (c as THREE.Mesh).isMesh).length, 2);
  });

  it("hasBuildingGeometry is false with only plainObjects (route tube) and no fragments geometry", async () => {
    const { hasBuildingGeometry } = await buildExportGroup(makeSource({ plainObjects: [tubeMesh()] }));
    assert.equal(hasBuildingGeometry, false);
  });
});

describe("buildExportGroup — plain objects (route tube)", () => {
  it("rebuilds the tube with a proper integer index (not Float32) and preserves transparency", async () => {
    const tube = tubeMesh();
    const { group } = await buildExportGroup(makeSource({ plainObjects: [tube] }));
    const rebuilt = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    assert.ok(rebuilt, "tube should be rebuilt");

    const index = rebuilt.geometry.getIndex()!;
    assert.notEqual(
      index.array.constructor,
      Float32Array,
      "index must not be a Float32Array — glTF requires an unsigned-int componentType",
    );

    const material = rebuilt.material as THREE.MeshStandardMaterial;
    assert.equal(material.transparent, true);
    assert.ok(Math.abs(material.opacity - 0.85) < 1e-6);
  });

  it("doesn't reparent or mutate the live tube object", async () => {
    const scene = new THREE.Scene();
    const tube = tubeMesh();
    scene.add(tube);
    const originalGeometry = tube.geometry;

    await buildExportGroup(makeSource({ plainObjects: [tube] }));

    assert.equal(tube.parent, scene);
    assert.equal(tube.geometry, originalGeometry);
  });

  it("skips a plain mesh whose position attribute has no backing array, instead of throwing", async () => {
    const tube = tubeMesh();
    const positionAttr = tube.geometry.getAttribute("position") as THREE.BufferAttribute;
    (positionAttr as unknown as { array: unknown }).array = undefined;

    let result: Awaited<ReturnType<typeof buildExportGroup>> | undefined;
    await assert.doesNotReject(async () => {
      result = await buildExportGroup(makeSource({ plainObjects: [tube] }));
    });
    assert.equal(result!.group.children.filter((c) => (c as THREE.Mesh).isMesh).length, 0);
  });
});

describe("buildExportGroup — general", () => {
  it("always includes exactly two lights regardless of input", async () => {
    const { group } = await buildExportGroup(makeSource({}));
    const lights = group.children.filter((c) => (c as THREE.Light).isLight);
    assert.equal(lights.length, 2);
  });

  it("returns an empty (lights-only), non-building group for a fully empty source", async () => {
    const { group, hasBuildingGeometry } = await buildExportGroup(makeSource({}));
    assert.equal(hasBuildingGeometry, false);
    assert.equal(group.children.filter((c) => (c as THREE.Mesh).isMesh).length, 0);
  });
});

describe("buildExportGroup — storey clip band", () => {
  it("leaves a fully-inside item's geometry untouched (fast path, no clip performed)", async () => {
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshDataSpanningY(0, 1)]]]),
    });
    const { group } = await buildExportGroup(
      makeSource({ fragmentsModels: [model], clipBand: { minY: -5, maxY: 5 } }),
    );
    const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    const bounds = yBounds(mesh);
    assert.ok(Math.abs(bounds.minY - 0) < 1e-6);
    assert.ok(Math.abs(bounds.maxY - 1) < 1e-6);
  });

  it("crops a straddling item's geometry to the clip band", async () => {
    // A wall-like box spanning two storeys' worth of height (y: -1..3),
    // with the band isolating just the lower storey (y: 0..1) — the
    // exact "wall crossing two storeys" scenario the live viewer's
    // clippingPlanes handles and the export previously didn't.
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshDataSpanningY(-1, 3)]]]),
    });
    const { group } = await buildExportGroup(
      makeSource({ fragmentsModels: [model], clipBand: { minY: 0, maxY: 1 } }),
    );
    const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    assert.ok(mesh, "expected a clipped mesh to remain, not be fully culled");
    const bounds = yBounds(mesh);
    assert.ok(bounds.minY >= -1e-6, `clipped minY should be >= 0, got ${bounds.minY}`);
    assert.ok(bounds.maxY <= 1 + 1e-6, `clipped maxY should be <= 1, got ${bounds.maxY}`);
  });

  it("fully culls an item entirely outside the clip band", async () => {
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshDataSpanningY(10, 11)]]]),
    });
    const { group, hasBuildingGeometry } = await buildExportGroup(
      makeSource({ fragmentsModels: [model], clipBand: { minY: 0, maxY: 1 } }),
    );
    assert.equal(hasBuildingGeometry, false);
    assert.equal(group.children.filter((c) => (c as THREE.Mesh).isMesh).length, 0);
  });

  it("also clips the route tube (a global renderer clip plane applies to it live too, not just fragments materials)", async () => {
    // Tube spans y=0..1 (see tubeMesh's curve points); isolate y: 0..0.4.
    const { group } = await buildExportGroup(
      makeSource({ plainObjects: [tubeMesh()], clipBand: { minY: 0, maxY: 0.4 } }),
    );
    const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    assert.ok(mesh, "expected a clipped tube mesh to remain");
    const bounds = yBounds(mesh);
    assert.ok(bounds.maxY <= 0.4 + 1e-6, `clipped tube maxY should be <= 0.4, got ${bounds.maxY}`);
  });

  it("does nothing when clipBand is null (no active storey filter)", async () => {
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshDataSpanningY(-1, 3)]]]),
    });
    const { group } = await buildExportGroup(makeSource({ fragmentsModels: [model], clipBand: null }));
    const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    const bounds = yBounds(mesh);
    assert.ok(Math.abs(bounds.minY - -1) < 1e-6);
    assert.ok(Math.abs(bounds.maxY - 3) < 1e-6);
  });
});
