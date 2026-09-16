import * as THREE from "three";
import type { FragmentsModel, MeshData } from "@thatopen/fragments";

/**
 * `CurrentLod.GEOMETRY` from @thatopen/fragments (full detail, not the
 * wireframe/invisible LOD tiers) — passed as a literal rather than
 * importing the `const enum` across the package boundary.
 */
const FULL_GEOMETRY_LOD = 0;

export type ExportableGeometrySource = {
  /** Real loaded fragments models — geometry is fetched live and async, see buildExportGroup's doc comment for why. */
  fragmentsModels: FragmentsModel[];
  /** Plain Three.js objects that don't go through the fragments query API (currently: the route tube group). */
  plainObjects: THREE.Object3D[];
  /**
   * The live viewer's active storey clip band (Three.js world Y), or null
   * when viewing "all levels". Matches that-open-runtime.ts's own
   * `renderer.clippingPlanes` exactly — see clipMeshToBand's doc comment
   * for why the export needs to replicate this itself rather than relying
   * on `visibleItems` alone.
   */
  clipBand: { minY: number; maxY: number } | null;
};

export type ExportGroupResult = {
  group: THREE.Group;
  /**
   * True if any real building geometry (not just the route tube and the
   * fixed lights) actually made it into the group. The route tube is
   * always present whenever the Share button is even enabled, so callers
   * must check this — not just "does the group have any mesh children" —
   * to tell a real export apart from an empty room with a tube floating in
   * it, and fall back to the footprint proxy instead of silently sharing
   * that.
   */
  hasBuildingGeometry: boolean;
};

/**
 * Builds a fully clean, standalone Three.js group safe to hand to
 * GLTFExporter/USDZExporter, from the app's live loaded IFC geometry.
 *
 * An earlier version of this function read geometry straight off the live
 * Three.js scene's mesh attributes (cloning/rebuilding from
 * `mesh.geometry.attributes`). That doesn't work: @thatopen/fragments frees
 * each attribute's CPU-side backing array — `attr.onUpload(() => { delete
 * this.array })`, see `MeshManager.cleanAttributeMemory` in
 * @thatopen/fragments — the moment three.js first uploads it to the GPU.
 * That's true of essentially every mesh the user has actually looked at,
 * not a rare edge case, which is why that approach kept silently exporting
 * almost nothing (or, after an earlier fix wrongly targeted a different
 * culprit, still nothing) regardless of what specific attribute-shape bug
 * was patched around it.
 *
 * The only reliable source is fragments' own async data API —
 * `model.getItemsGeometry()` / `model.getItemsMaterialDefinition()` —
 * which fetch real position/normal/index/color data on demand rather than
 * reading whatever three.js happens to still have cached. `model.visibleItems`
 * (items with at least one tile currently rendered) scopes the export to
 * what's actually on screen, which also naturally respects any
 * excluded/hidden elements, rather than always exporting the whole
 * multi-storey building regardless of what the viewer shows. It does *not*
 * by itself replicate the live viewer's storey-band clip though — an item
 * merely visible on the current storey is exported whole even if it
 * physically extends past the band (e.g. a wall spanning two storeys) —
 * so `source.clipBand`, when set, additionally crops each mesh's geometry
 * to that band (see clipMeshToBand below), matching applyStoreyFilter's
 * own no-capping clippingPlanes exactly.
 *
 * Per-item/part failures are caught and skipped (logged, not fatal) —
 * given how much has gone wrong in this pipeline already, one bad part
 * should degrade the export, not blank it.
 */
export async function buildExportGroup(source: ExportableGeometrySource): Promise<ExportGroupResult> {
  const group = new THREE.Group();
  let hasBuildingGeometry = false;
  const clipBand = source.clipBand;

  for (const model of source.fragmentsModels) {
    try {
      const added = await addModelGeometry(group, model, clipBand);
      hasBuildingGeometry = hasBuildingGeometry || added;
    } catch (err) {
      console.warn("Share export: skipping a model whose geometry couldn't be fetched", err);
    }
  }

  // The route tube is clipped by the same band live too: applyStoreyFilter
  // sets `renderer.clippingPlanes` globally, which — unlike
  // `material.clippingPlanes` — applies to every material rendered, tube
  // included, not just fragments' own materials.
  for (const object of source.plainObjects) {
    object.updateMatrixWorld(true);
    object.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh) return;
      try {
        let rebuilt: THREE.Mesh | null = rebuildPlainMesh(node as THREE.Mesh);
        if (rebuilt && clipBand) rebuilt = clipMeshToBand(rebuilt, clipBand);
        if (rebuilt) group.add(rebuilt);
      } catch (err) {
        console.warn("Share export: skipping a mesh that couldn't be rebuilt", err);
      }
    });
  }

  group.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 8, 4);
  group.add(sun);

  return { group, hasBuildingGeometry };
}

type Style = { color: THREE.Color; opacity: number; transparent: boolean };

/** Returns true if at least one mesh was added. */
async function addModelGeometry(
  group: THREE.Group,
  model: FragmentsModel,
  clipBand: { minY: number; maxY: number } | null,
): Promise<boolean> {
  model.object.updateMatrixWorld(true);
  const modelMatrix = model.object.matrixWorld;

  // Prefer what's actually rendered (respects the storey filter and any
  // excluded elements); fall back to everything if nothing has rendered
  // yet — e.g. exporting immediately after load, before a frame has ticked.
  let localIds = Array.from(model.visibleItems);
  if (localIds.length === 0) {
    localIds = await model.getLocalIds();
  }
  if (localIds.length === 0) return false;

  const [geometryPerItem, materialDefs] = await Promise.all([
    model.getItemsGeometry(localIds, FULL_GEOMETRY_LOD),
    model.getItemsMaterialDefinition(localIds),
  ]);

  const styleByLocalId = new Map<number, Style>();
  for (const entry of materialDefs) {
    for (const localId of entry.localIds) {
      styleByLocalId.set(localId, {
        color: entry.definition.color,
        opacity: entry.definition.opacity,
        transparent: entry.definition.transparent,
      });
    }
  }

  let added = false;
  for (let i = 0; i < localIds.length; i++) {
    const parts = geometryPerItem[i];
    if (!parts) continue;
    const style = styleByLocalId.get(localIds[i]!);
    for (const part of parts) {
      try {
        let rebuilt: THREE.Mesh | null = rebuildFromMeshData(part, modelMatrix, style);
        if (rebuilt && clipBand) rebuilt = clipMeshToBand(rebuilt, clipBand);
        if (rebuilt) {
          group.add(rebuilt);
          added = true;
        }
      } catch (err) {
        console.warn("Share export: skipping an item part that couldn't be rebuilt", err);
      }
    }
  }
  return added;
}

function rebuildFromMeshData(
  part: MeshData,
  modelMatrix: THREE.Matrix4,
  style: Style | undefined,
): THREE.Mesh | null {
  if (!part.positions || part.positions.length === 0) return null;
  if (!part.transform) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(part.positions), 3));

  if (part.normals && part.normals.length > 0) {
    // Signed-normalized — matches fragments' own live-scene normals (see
    // MeshManager.setNormals in @thatopen/fragments: `new
    // THREE.BufferAttribute(normals, 3, true)`), not raw float components.
    geometry.setAttribute("normal", new THREE.BufferAttribute(part.normals, 3, true));
  } else {
    geometry.computeVertexNormals();
  }

  if (part.indices && part.indices.length > 0) {
    // Already a proper integer typed array (Uint8/16/32Array) straight from
    // fragments — no Float32-index bug risk here the way the old raw-array
    // extraction path had.
    geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
  }

  // Composition order confirmed against @thatopen/components' own
  // EdgesProjector, which consumes this exact API the same way:
  // `mesh.applyMatrix4(transform); mesh.applyMatrix4(model.object.matrixWorld)`
  // — i.e. modelMatrix * transform, item-local then model-world.
  const worldMatrix = modelMatrix.clone().multiply(part.transform);
  geometry.applyMatrix4(worldMatrix);

  const material = new THREE.MeshStandardMaterial({
    color: style ? style.color.clone() : new THREE.Color(0x808080),
    opacity: style?.opacity ?? 1,
    transparent: style?.transparent ?? false,
  });

  return new THREE.Mesh(geometry, material);
}

// --- Storey clip band ---
//
// The live viewer isolates one storey with `renderer.clippingPlanes` /
// `material.clippingPlanes` (see applyStoreyFilter in that-open-runtime.ts)
// — a GPU fragment-level clip with no capping: geometry past the plane
// just isn't drawn, the object reads as an open/hollow cross-section, not a
// sealed cut face. `model.visibleItems` (what scopes the export to begin
// with) marks an item visible if ANY part of it renders, so an item that
// merely *straddles* the band — e.g. a wall spanning two storeys — was
// being exported whole, unclipped, even though the live view only shows
// the slice inside the band. These functions replicate that same
// no-capping clip on the exported geometry so the two match.

const CLIP_PLANE_NORMAL_MIN = new THREE.Vector3(0, 1, 0);
const CLIP_PLANE_NORMAL_MAX = new THREE.Vector3(0, -1, 0);

/**
 * Clips a mesh's geometry to `clipBand` in place-equivalent fashion
 * (returns a new mesh sharing the material; the input mesh/geometry are
 * left untouched). Returns the same mesh unchanged when it's already
 * fully inside the band (the common case — most items live on one storey
 * and never approach the clip planes), null when it's fully outside
 * (culled entirely), and a new mesh with recomputed normals when it
 * actually straddles a plane and needs real clipping.
 */
function clipMeshToBand(mesh: THREE.Mesh, clipBand: { minY: number; maxY: number }): THREE.Mesh | null {
  const positionAttr = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const positions = positionAttr.array as Float32Array;
  if (positions.length === 0) return null;

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minY >= clipBand.minY && maxY <= clipBand.maxY) return mesh;
  if (maxY < clipBand.minY || minY > clipBand.maxY) return null;

  const indexAttr = mesh.geometry.getIndex();
  const indices = indexAttr ? (indexAttr.array as Uint8Array | Uint16Array | Uint32Array) : null;

  // Plane equation n·x + c = 0; a point is kept where distanceToPoint >= 0
  // — this sign convention is copied directly from applyStoreyFilter's own
  // `storeyClipPlanes[0].set(new THREE.Vector3(0, 1, 0), -minY)` /
  // `storeyClipPlanes[1].set(new THREE.Vector3(0, -1, 0), maxY)`.
  const planes = [
    new THREE.Plane(CLIP_PLANE_NORMAL_MIN, -clipBand.minY),
    new THREE.Plane(CLIP_PLANE_NORMAL_MAX, clipBand.maxY),
  ];

  const clipped = clipTrianglesToPlanes(positions, indices, planes);
  if (clipped.positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(clipped.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(clipped.indices, 1));
  // Original per-vertex normals don't carry across new clip-boundary
  // vertices (there's nothing meaningful to interpolate them from without
  // a full half-edge walk) — recomputed instead. Only meshes that actually
  // straddle a plane pay this cost; the common fully-inside case above
  // returns the original mesh with its real fragments-sourced normals
  // untouched.
  geometry.computeVertexNormals();

  return new THREE.Mesh(geometry, mesh.material);
}

/** Sutherland-Hodgman polygon clip applied per-triangle, against each plane in sequence — no capping (see clipMeshToBand's doc comment). */
function clipTrianglesToPlanes(
  positions: Float32Array,
  indices: Uint8Array | Uint16Array | Uint32Array | null,
  planes: THREE.Plane[],
): { positions: Float32Array; indices: Uint32Array } {
  const vertexAt = (i: number): THREE.Vector3 =>
    new THREE.Vector3(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);

  let triangles: THREE.Vector3[][] = [];
  if (indices) {
    for (let i = 0; i + 2 < indices.length; i += 3) {
      triangles.push([vertexAt(indices[i]!), vertexAt(indices[i + 1]!), vertexAt(indices[i + 2]!)]);
    }
  } else {
    for (let i = 0; i + 2 < positions.length / 3; i += 3) {
      triangles.push([vertexAt(i), vertexAt(i + 1), vertexAt(i + 2)]);
    }
  }

  for (const plane of planes) {
    const next: THREE.Vector3[][] = [];
    for (const tri of triangles) {
      next.push(...clipTriangleAgainstPlane(tri, plane));
    }
    triangles = next;
  }

  const outPositions = new Float32Array(triangles.length * 9);
  const outIndices = new Uint32Array(triangles.length * 3);
  let vi = 0;
  for (const tri of triangles) {
    for (const v of tri) {
      outPositions[vi * 3] = v.x;
      outPositions[vi * 3 + 1] = v.y;
      outPositions[vi * 3 + 2] = v.z;
      outIndices[vi] = vi;
      vi++;
    }
  }
  return { positions: outPositions, indices: outIndices };
}

/** Clips one triangle against one plane, returning 0, 1, or 2 triangles (a clipped triangle becomes a 3- or 4-sided polygon, fan-triangulated). */
function clipTriangleAgainstPlane(tri: THREE.Vector3[], plane: THREE.Plane): THREE.Vector3[][] {
  const d = tri.map((v) => plane.distanceToPoint(v));
  const inside = d.map((x) => x >= 0);
  const insideCount = inside.filter(Boolean).length;

  if (insideCount === 0) return [];
  if (insideCount === 3) return [tri];

  const poly: THREE.Vector3[] = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    if (inside[i]) poly.push(tri[i]!);
    if (inside[i] !== inside[j]) {
      const t = d[i]! / (d[i]! - d[j]!);
      poly.push(tri[i]!.clone().lerp(tri[j]!, t));
    }
  }

  const out: THREE.Vector3[][] = [];
  for (let i = 1; i + 1 < poly.length; i++) {
    out.push([poly[0]!, poly[i]!, poly[i + 1]!]);
  }
  return out;
}

// --- Plain (non-fragments) objects: currently just the route tube group,
// built fresh every time by that-open-runtime.ts, so its attributes are
// never GPU-uploaded-then-freed the way fragments' are. The backing-array
// guard below is defense in depth, not the fix for the main problem.

function hasBackingArray(
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined,
): attr is THREE.BufferAttribute | THREE.InterleavedBufferAttribute {
  if (!attr) return false;
  const interleaved = attr as THREE.InterleavedBufferAttribute;
  if (interleaved.isInterleavedBufferAttribute) return Boolean(interleaved.data?.array);
  return Boolean((attr as THREE.BufferAttribute).array);
}

function extractAttribute(
  attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  itemSize: number,
): Float32Array {
  const out = new Float32Array(attr.count * itemSize);
  for (let i = 0; i < attr.count; i++) {
    for (let c = 0; c < itemSize; c++) {
      out[i * itemSize + c] = attr.getComponent(i, c);
    }
  }
  return out;
}

/**
 * Preserves whatever integer type the source index already used, instead
 * of forcing Float32Array: three.js auto-picks Uint16Array/Uint32Array for
 * generated geometry like TubeGeometry, and glTF index accessors are
 * required to be an unsigned-int componentType — a Float32 index produced
 * spec-invalid GLBs that every viewer (Android Scene Viewer, model-viewer,
 * three's own GLTFLoader) silently rejected or rendered nothing for.
 */
function cloneIndexAttribute(index: THREE.BufferAttribute): THREE.BufferAttribute {
  const Ctor = index.array.constructor as new (n: number) => Uint8Array | Uint16Array | Uint32Array;
  const out = new Ctor(index.count);
  for (let i = 0; i < index.count; i++) out[i] = index.getX(i);
  return new THREE.BufferAttribute(out, 1);
}

function extractStyle(material: THREE.Material): Style {
  const mat = material as unknown as { color?: unknown; opacity?: number; transparent?: boolean };
  return {
    color: mat.color instanceof THREE.Color ? mat.color.clone() : new THREE.Color(0x808080),
    opacity: typeof mat.opacity === "number" ? mat.opacity : 1,
    transparent: Boolean(mat.transparent),
  };
}

function rebuildPlainMesh(mesh: THREE.Mesh): THREE.Mesh | null {
  const src = mesh.geometry;
  const positionAttr = src.getAttribute("position");
  if (!hasBackingArray(positionAttr) || positionAttr.count === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(extractAttribute(positionAttr, 3), 3));

  const normalAttr = src.getAttribute("normal");
  if (hasBackingArray(normalAttr)) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(extractAttribute(normalAttr, 3), 3));
  } else {
    geometry.computeVertexNormals();
  }

  const uvAttr = src.getAttribute("uv");
  if (hasBackingArray(uvAttr)) {
    geometry.setAttribute("uv", new THREE.BufferAttribute(extractAttribute(uvAttr, 2), 2));
  }

  const index = src.getIndex();
  if (index && hasBackingArray(index)) {
    geometry.setIndex(cloneIndexAttribute(index));
  }

  geometry.applyMatrix4(mesh.matrixWorld);

  const srcMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const style = srcMaterial ? extractStyle(srcMaterial) : { color: new THREE.Color(0x808080), opacity: 1, transparent: false };
  const material = new THREE.MeshStandardMaterial(style);

  return new THREE.Mesh(geometry, material);
}
