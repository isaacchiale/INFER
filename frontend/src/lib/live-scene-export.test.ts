import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import {
  buildExportGroup,
  buildRouteStoreyClipBands,
  type ClipBand,
  type ExportableGeometrySource,
} from "./live-scene-export.ts";
import { RenderedFaces } from "@thatopen/fragments";
import type { FragmentsModel, MeshData } from "@thatopen/fragments";
import type { FootprintsDocument } from "@/types/footprints";
import type { ThreeAabb } from "@/lib/viewer-camera-pose";

/** Test convenience: most cases don't care about clip bands at all. */
function build(source: ExportableGeometrySource, clipBands: ClipBand[] | null = null) {
  return buildExportGroup(source, clipBands);
}

/**
 * Minimal stand-in for a real FragmentsModel, shaped to match the actual
 * @thatopen/fragments@3.4.7 API (verified directly against
 * node_modules/@thatopen/fragments/dist/index.d.ts and cross-checked
 * against a real consumer, @thatopen/components' EdgesProjector, which
 * uses this exact API the same way: `mesh.applyMatrix4(transform);
 * mesh.applyMatrix4(model.object.matrixWorld)`).
 */
type FakeStyle = {
  color: THREE.Color;
  opacity: number;
  transparent: boolean;
  renderedFaces?: RenderedFaces;
};

function fakeModel(opts: {
  visibleItems?: number[];
  allLocalIds?: number[];
  geometryByLocalId: Map<number, MeshData[]>;
  styleByLocalId?: Map<number, FakeStyle>;
  /** Per-sample material, like fragments' getSamples()/getMaterials(). */
  materialBySampleId?: Map<
    number,
    { r: number; g: number; b: number; a: number; renderedFaces: RenderedFaces }
  >;
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
      const out: { definition: FakeStyle; localIds: number[] }[] = [];
      for (const id of localIds) {
        const style = styles.get(id);
        if (style) out.push({ definition: style, localIds: [id] });
      }
      return out;
    },
    async getSamples(ids: Iterable<number>) {
      const out = new Map<number, { material: number }>();
      // Material id == sample id + 1000, so a sample/material mix-up would show.
      for (const id of ids)
        if (opts.materialBySampleId?.has(id)) out.set(id, { material: id + 1000 });
      return out;
    },
    async getMaterials(ids: Iterable<number>) {
      const out = new Map<number, unknown>();
      for (const id of ids) {
        const m = opts.materialBySampleId?.get(id - 1000);
        if (m) out.set(id, m);
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
  const bbox = new THREE.Box3().setFromBufferAttribute(
    mesh.geometry.getAttribute("position") as THREE.BufferAttribute,
  );
  return { minY: bbox.min.y, maxY: bbox.max.y };
}

function tubeMesh(): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(2, 1, 0),
  ]);
  const geometry = new THREE.TubeGeometry(curve, 8, 0.1, 6, false);
  return new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0x1d4ed8, transparent: true, opacity: 0.85 }),
  );
}

function makeSource(opts: {
  fragmentsModels?: FragmentsModel[];
  plainObjects?: THREE.Object3D[];
}): ExportableGeometrySource {
  return {
    fragmentsModels: opts.fragmentsModels ?? [],
    plainObjects: opts.plainObjects ?? [],
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

    const { group, hasBuildingGeometry } = await build(makeSource({ fragmentsModels: [model] }));
    assert.equal(hasBuildingGeometry, true);
    const meshes = group.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
    assert.equal(meshes.length, 1);
    assert.equal((meshes[0]!.material as THREE.MeshStandardMaterial).color.getHex(), 0xff0000);
  });

  it("colours each part of an item from its own sample's material, not one colour per item", async () => {
    // A door: leaf (sample 10, brown) + glass (sample 11, translucent blue),
    // while the per-item definition (the buggy fragments call) says black.
    const leaf: MeshData = { ...boxMeshData(), sampleId: 10 };
    const glass: MeshData = { ...boxMeshData(), sampleId: 11 };
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [leaf, glass]]]),
      styleByLocalId: new Map([
        [1, { color: new THREE.Color(0, 0, 0), opacity: 1, transparent: false }],
      ]),
      materialBySampleId: new Map([
        [10, { r: 150, g: 90, b: 40, a: 255, renderedFaces: RenderedFaces.ONE }],
        [11, { r: 120, g: 180, b: 220, a: 90, renderedFaces: RenderedFaces.TWO }],
      ]),
    });

    const { group } = await build(makeSource({ fragmentsModels: [model] }));
    const mats = (group.children as THREE.Mesh[]).map(
      (m) => m.material as THREE.MeshStandardMaterial,
    );
    assert.equal(mats.length, 2);
    const hex = mats.map((m) => m.color.getHexString(THREE.SRGBColorSpace));
    assert.deepEqual(hex, ["965a28", "78b4dc"]);
    assert.equal(mats[0]!.transparent, false);
    assert.equal(mats[1]!.transparent, true);
    assert.ok(Math.abs(mats[1]!.opacity - 90 / 255) < 1e-6);
    assert.equal(mats[1]!.side, THREE.DoubleSide);
  });

  it("falls back to the item's colour for a part with no sample material", async () => {
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [{ ...boxMeshData(), sampleId: 99 }]]]),
      styleByLocalId: new Map([
        [1, { color: new THREE.Color(0xff0000), opacity: 1, transparent: false }],
      ]),
      materialBySampleId: new Map(),
    });
    const { group } = await build(makeSource({ fragmentsModels: [model] }));
    const mesh = group.children[0] as THREE.Mesh;
    assert.equal((mesh.material as THREE.MeshStandardMaterial).color.getHex(), 0xff0000);
  });

  it("exports plain float normals, not fragments' Int16 quantized ones", async () => {
    const part = boxMeshData();
    const normals = new THREE.BoxGeometry(1, 1, 1).getAttribute("normal").array;
    part.normals = Int16Array.from(normals as ArrayLike<number>, (v) => Math.round(v * 32767));
    const model = fakeModel({ visibleItems: [1], geometryByLocalId: new Map([[1, [part]]]) });

    const { group } = await build(makeSource({ fragmentsModels: [model] }));
    const normal = (group.children[0] as THREE.Mesh).geometry.getAttribute(
      "normal",
    ) as THREE.BufferAttribute;
    assert.ok(normal.array instanceof Float32Array);
    assert.equal(normal.normalized, false);
    for (let i = 0; i < normal.count; i++) {
      const len = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
      assert.ok(Math.abs(len - 1) < 1e-3, `normal ${i} length ${len}`);
    }
  });

  it("keeps faces pointing outward when the baked transform mirrors the part", async () => {
    const part = boxMeshData();
    part.normals = Int16Array.from(
      new THREE.BoxGeometry(1, 1, 1).getAttribute("normal").array as ArrayLike<number>,
      (v) => Math.round(v * 32767),
    );
    part.transform = new THREE.Matrix4().makeScale(-1, 1, 1);
    const model = fakeModel({ visibleItems: [1], geometryByLocalId: new Map([[1, [part]]]) });

    const { group } = await build(makeSource({ fragmentsModels: [model] }));
    const geo = (group.children[0] as THREE.Mesh).geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const nrm = geo.getAttribute("normal") as THREE.BufferAttribute;
    const idx = geo.getIndex()!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let t = 0; t < idx.count; t += 3) {
      a.fromBufferAttribute(pos, idx.getX(t));
      b.fromBufferAttribute(pos, idx.getX(t + 1));
      c.fromBufferAttribute(pos, idx.getX(t + 2));
      const faceNormal = new THREE.Vector3()
        .subVectors(c, b)
        .cross(new THREE.Vector3().subVectors(a, b));
      const vertexNormal = new THREE.Vector3().fromBufferAttribute(nrm, idx.getX(t));
      assert.ok(faceNormal.dot(vertexNormal) > 0, `triangle ${t / 3} winds against its normal`);
    }
  });

  it("carries a double-sided source material (RenderedFaces.TWO) into DoubleSide on export", async () => {
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshData()]]]),
      styleByLocalId: new Map([
        [
          1,
          {
            color: new THREE.Color(0xffffff),
            opacity: 1,
            transparent: false,
            renderedFaces: RenderedFaces.TWO,
          },
        ],
      ]),
    });

    const { group } = await build(makeSource({ fragmentsModels: [model] }));
    const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    assert.equal((mesh.material as THREE.MeshStandardMaterial).side, THREE.DoubleSide);
  });

  it("defaults a single-sided source material (RenderedFaces.ONE) to FrontSide", async () => {
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshData()]]]),
      styleByLocalId: new Map([
        [
          1,
          {
            color: new THREE.Color(0xffffff),
            opacity: 1,
            transparent: false,
            renderedFaces: RenderedFaces.ONE,
          },
        ],
      ]),
    });

    const { group } = await build(makeSource({ fragmentsModels: [model] }));
    const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    assert.equal((mesh.material as THREE.MeshStandardMaterial).side, THREE.FrontSide);
  });

  it("rebuilds an item whose material color crossed a structured-clone boundary (plain {r,g,b}, no .clone)", async () => {
    // fragments computes materials off-thread for some models; the value
    // that reaches getItemsMaterialDefinition() then crosses a postMessage
    // structured-clone boundary, which keeps plain enumerable properties
    // but strips the THREE.Color prototype (no .clone method) — this
    // crashed every real item's material construction for such a model.
    const plainColor = { r: 0.2, g: 0.4, b: 0.6 } as unknown as THREE.Color;
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshData()]]]),
      styleByLocalId: new Map([[1, { color: plainColor, opacity: 1, transparent: false }]]),
    });

    const { group, hasBuildingGeometry } = await build(makeSource({ fragmentsModels: [model] }));
    assert.equal(hasBuildingGeometry, true, "should not silently drop the item");
    const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    const color = (mesh.material as THREE.MeshStandardMaterial).color;
    assert.ok(Math.abs(color.r - 0.2) < 1e-6);
    assert.ok(Math.abs(color.g - 0.4) < 1e-6);
    assert.ok(Math.abs(color.b - 0.6) < 1e-6);
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

    const { group } = await build(makeSource({ fragmentsModels: [model] }));
    const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    const bbox = new THREE.Box3().setFromBufferAttribute(
      mesh.geometry.getAttribute("position") as THREE.BufferAttribute,
    );
    const center = bbox.getCenter(new THREE.Vector3());
    assert.ok(Math.abs(center.x - 105) < 1e-6, `expected x~105, got ${center.x}`);
  });

  it("falls back to getLocalIds() when visibleItems is empty (nothing rendered yet)", async () => {
    const model = fakeModel({
      visibleItems: [],
      allLocalIds: [7],
      geometryByLocalId: new Map([[7, [boxMeshData()]]]),
    });
    const { hasBuildingGeometry } = await build(makeSource({ fragmentsModels: [model] }));
    assert.equal(hasBuildingGeometry, true);
  });

  it("defaults color/opacity when no material definition is returned for an item", async () => {
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshData()]]]),
      // no styleByLocalId at all
    });
    const { group } = await build(makeSource({ fragmentsModels: [model] }));
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
    const { group, hasBuildingGeometry } = await build(makeSource({ fragmentsModels: [model] }));
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

    const { group, hasBuildingGeometry } = await build(
      makeSource({ fragmentsModels: [broken, good] }),
    );
    assert.equal(hasBuildingGeometry, true);
    assert.equal(group.children.filter((c) => (c as THREE.Mesh).isMesh).length, 1);
  });

  it("includes multiple mesh parts for a single item", async () => {
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshData(), boxMeshData()]]]),
    });
    const { group } = await build(makeSource({ fragmentsModels: [model] }));
    assert.equal(group.children.filter((c) => (c as THREE.Mesh).isMesh).length, 2);
  });

  it("hasBuildingGeometry is false with only plainObjects (route tube) and no fragments geometry", async () => {
    const { hasBuildingGeometry } = await build(makeSource({ plainObjects: [tubeMesh()] }));
    assert.equal(hasBuildingGeometry, false);
  });
});

describe("buildExportGroup — plain objects (route tube)", () => {
  it("rebuilds the tube with a proper integer index (not Float32) and preserves transparency", async () => {
    const tube = tubeMesh();
    const { group } = await build(makeSource({ plainObjects: [tube] }));
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

  it("carries the live source material's side onto the rebuilt mesh", async () => {
    const tube = tubeMesh();
    (tube.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide;
    const { group } = await build(makeSource({ plainObjects: [tube] }));
    const rebuilt = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    assert.equal((rebuilt.material as THREE.MeshStandardMaterial).side, THREE.DoubleSide);
  });

  it("doesn't reparent or mutate the live tube object", async () => {
    const scene = new THREE.Scene();
    const tube = tubeMesh();
    scene.add(tube);
    const originalGeometry = tube.geometry;

    await build(makeSource({ plainObjects: [tube] }));

    assert.equal(tube.parent, scene);
    assert.equal(tube.geometry, originalGeometry);
  });

  it("skips a plain mesh whose position attribute has no backing array, instead of throwing", async () => {
    const tube = tubeMesh();
    const positionAttr = tube.geometry.getAttribute("position") as THREE.BufferAttribute;
    (positionAttr as unknown as { array: unknown }).array = undefined;

    let result: Awaited<ReturnType<typeof buildExportGroup>> | undefined;
    await assert.doesNotReject(async () => {
      result = await build(makeSource({ plainObjects: [tube] }));
    });
    assert.equal(result!.group.children.filter((c) => (c as THREE.Mesh).isMesh).length, 0);
  });
});

describe("buildExportGroup — general", () => {
  it("never bakes any lights into the export", async () => {
    // glTF/USDZ export silently drops HemisphereLight (no ambient-light
    // equivalent in the format) and doesn't reliably preserve a
    // DirectionalLight's aim either — every mainstream glTF/USDZ viewer
    // already applies its own default environment lighting to arbitrary
    // content, so this export deliberately brings none of its own. See
    // buildExportGroup's own comment for the full reasoning.
    const { group } = await build(makeSource({}));
    const lights = group.children.filter((c) => (c as THREE.Light).isLight);
    assert.equal(lights.length, 0);
  });

  it("returns a fully empty, non-building group for a fully empty source", async () => {
    const { group, hasBuildingGeometry } = await build(makeSource({}));
    assert.equal(hasBuildingGeometry, false);
    assert.equal(group.children.length, 0);
  });
});

describe("buildExportGroup — storey clip bands", () => {
  it("leaves a fully-inside item's geometry untouched (fast path, no clip performed)", async () => {
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshDataSpanningY(0, 1)]]]),
    });
    const { group } = await build(makeSource({ fragmentsModels: [model] }), [
      { minY: -5, maxY: 5 },
    ]);
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
    const { group } = await build(makeSource({ fragmentsModels: [model] }), [{ minY: 0, maxY: 1 }]);
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
    const { group, hasBuildingGeometry } = await build(makeSource({ fragmentsModels: [model] }), [
      { minY: 0, maxY: 1 },
    ]);
    assert.equal(hasBuildingGeometry, false);
    assert.equal(group.children.filter((c) => (c as THREE.Mesh).isMesh).length, 0);
  });

  it("also clips the route tube (a global renderer clip plane applies to it live too, not just fragments materials)", async () => {
    // Tube spans y=0..1 (see tubeMesh's curve points); isolate y: 0..0.4.
    const { group } = await build(makeSource({ plainObjects: [tubeMesh()] }), [
      { minY: 0, maxY: 0.4 },
    ]);
    const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    assert.ok(mesh, "expected a clipped tube mesh to remain");
    const bounds = yBounds(mesh);
    assert.ok(bounds.maxY <= 0.4 + 1e-6, `clipped tube maxY should be <= 0.4, got ${bounds.maxY}`);
  });

  it("keeps geometry spanning two disjoint kept bands as two separate pieces, nothing in the excluded gap", async () => {
    // A shaft-like item running continuously from y=0 to y=10 (e.g. floor 1
    // through floor 5), with only floor 1 (y: 0..1) and floor 5 (y: 9..10)
    // actually visited by the route — floors 2-4 (y: 1..9) excluded. No
    // capping means each kept slice comes back as its own separate mesh.
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshDataSpanningY(0, 10)]]]),
    });
    const { group } = await build(makeSource({ fragmentsModels: [model] }), [
      { minY: 0, maxY: 1 },
      { minY: 9, maxY: 10 },
    ]);
    const meshes = group.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
    assert.equal(meshes.length, 2, "expected two separate pieces, one per kept band");
    const boundsByMesh = meshes.map(yBounds).sort((a, b) => a.minY - b.minY);
    assert.ok(Math.abs(boundsByMesh[0]!.minY - 0) < 1e-6);
    assert.ok(boundsByMesh[0]!.maxY <= 1 + 1e-6);
    assert.ok(boundsByMesh[1]!.minY >= 9 - 1e-6);
    assert.ok(Math.abs(boundsByMesh[1]!.maxY - 10) < 1e-6);
  });

  it("exports the route's storeys even when the viewer is only showing a different storey", async () => {
    // Viewer isolated to floor 3 (only item 3 is on screen); the route is
    // on floors 1 and 5. Scoping by visibleItems exported nothing here and
    // silently fell back to the footprint proxy.
    const model = fakeModel({
      visibleItems: [3],
      geometryByLocalId: new Map([
        [1, [boxMeshDataSpanningY(0, 1)]],
        [3, [boxMeshDataSpanningY(4, 5)]],
        [5, [boxMeshDataSpanningY(9, 10)]],
      ]),
    });
    const { group, hasBuildingGeometry, stats } = await build(
      makeSource({ fragmentsModels: [model] }),
      [
        { minY: 0, maxY: 1 },
        { minY: 9, maxY: 10 },
      ],
    );
    assert.equal(hasBuildingGeometry, true);
    assert.equal(stats.items, 3);
    const spans = (group.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[])
      .map(yBounds)
      .sort((a, b) => a.minY - b.minY);
    assert.equal(spans.length, 2, "floor 1 and floor 5 items only, not the on-screen floor 3 item");
    assert.ok(Math.abs(spans[0]!.minY - 0) < 1e-6);
    assert.ok(Math.abs(spans[1]!.minY - 9) < 1e-6);
  });

  it("does nothing when clipBands is null (no scope computed)", async () => {
    const model = fakeModel({
      visibleItems: [1],
      geometryByLocalId: new Map([[1, [boxMeshDataSpanningY(-1, 3)]]]),
    });
    const { group } = await build(makeSource({ fragmentsModels: [model] }), null);
    const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
    const bounds = yBounds(mesh);
    assert.ok(Math.abs(bounds.minY - -1) < 1e-6);
    assert.ok(Math.abs(bounds.maxY - 3) < 1e-6);
  });
});

describe("buildRouteStoreyClipBands", () => {
  // Five evenly-spaced storeys (3m apart), one room on the ground floor
  // (needed for footprintPlanBounds) and one on the top floor, so a route
  // "from floor 1 to floor 5" has real plan bounds to work from.
  const footprints: FootprintsDocument = {
    schema_version: "1.0",
    model_id: "m1",
    coordinate_system: "ifc_world_xy_metres",
    storeys: [
      { global_id: "s1", name: "L1", elevation: 0 },
      { global_id: "s2", name: "L2", elevation: 3 },
      { global_id: "s3", name: "L3", elevation: 6 },
      { global_id: "s4", name: "L4", elevation: 9 },
      { global_id: "s5", name: "L5", elevation: 12 },
    ],
    spaces: [
      {
        global_id: "sp1",
        name: "Room 1",
        storey_global_id: "s1",
        polygon: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 5, y: 5 },
          { x: 0, y: 5 },
        ],
        incomplete: false,
        method: "ifc_mesh_xy_outline",
      },
      {
        global_id: "sp5",
        name: "Room 5",
        storey_global_id: "s5",
        polygon: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
          { x: 5, y: 5 },
          { x: 0, y: 5 },
        ],
        incomplete: false,
        method: "ifc_mesh_xy_outline",
      },
    ],
    doors: [],
  };
  const modelBounds: ThreeAabb = { minX: 0, maxX: 5, minY: 0, maxY: 15, minZ: -5, maxZ: 0 };

  it("returns null when modelBounds is null", () => {
    const bands = buildRouteStoreyClipBands({
      footprints,
      storeyIds: new Set(["s1"]),
      modelBounds: null,
      coordInverse: null,
    });
    assert.equal(bands, null);
  });

  it("returns null when no storeys are requested", () => {
    const bands = buildRouteStoreyClipBands({
      footprints,
      storeyIds: new Set(),
      modelBounds,
      coordInverse: null,
    });
    assert.equal(bands, null);
  });

  it("returns one band per requested storey, skipping the ones in between", () => {
    // A route from floor 1 to floor 5 riding stairs — only those two
    // storeys requested, floors 2-4 deliberately left out.
    const bands = buildRouteStoreyClipBands({
      footprints,
      storeyIds: new Set(["s1", "s5"]),
      modelBounds,
      coordInverse: null,
    });
    assert.ok(bands, "expected two bands, not null");
    assert.equal(bands!.length, 2);
  });

  it("orders bands consistently with storey elevation (the higher storey's band sits above the lower one's)", () => {
    const bands = buildRouteStoreyClipBands({
      footprints,
      storeyIds: new Set(["s1", "s5"]),
      modelBounds,
      coordInverse: null,
    });
    assert.ok(bands);
    const [first, second] = [...bands!].sort((a, b) => a.minY - b.minY);
    assert.ok(first!.maxY <= second!.minY + 1e-6, "floor 1's band must not overlap floor 5's");
  });

  it("keeps a single storey's band roughly centred on its own elevation when there's no coordination matrix", () => {
    // No coordInverse -> the no-coord fallback path, which (with
    // modelBounds.minY aligned to the lowest storey's elevation, both 0
    // here) passes storey elevation through to Three Y directly.
    const bands = buildRouteStoreyClipBands({
      footprints,
      storeyIds: new Set(["s1"]),
      modelBounds,
      coordInverse: null,
    });
    assert.ok(bands);
    assert.equal(bands!.length, 1);
    const [band] = bands!;
    // Formula: minElevM = elev - 0.25, maxElevM = elev + max(nextElev-elev, 1.5)*0.78,
    // nextElev = 3 (storey s2) here, so minY ~ -0.25, maxY ~ 3*0.78 = 2.34.
    assert.ok(Math.abs(band!.minY - -0.25) < 0.1, `expected minY near -0.25, got ${band!.minY}`);
    assert.ok(Math.abs(band!.maxY - 2.34) < 0.1, `expected maxY near 2.34, got ${band!.maxY}`);
  });
});
