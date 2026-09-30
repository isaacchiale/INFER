import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { FragmentsModel, MeshData } from "@thatopen/fragments";
import { elevationsForVerticalRemap } from "@/lib/storey-elevations";
import {
  footprintPlanBounds,
  resolveRouteTubeLiftOptions,
  spaceStoreyIds,
  storeysMetres,
} from "@/lib/route-tube";
import { ifcPlanToThree, type Mat4Elements, type ThreeAabb } from "@/lib/viewer-camera-pose";
import type { FootprintsDocument } from "@/types/footprints";

/**
 * `CurrentLod.GEOMETRY` from @thatopen/fragments (full detail, not the
 * wireframe/invisible LOD tiers) — passed as a literal rather than
 * importing the `const enum` across the package boundary.
 */
const FULL_GEOMETRY_LOD = 0;

/**
 * `RenderedFaces.TWO` from @thatopen/fragments. A local constant, not the
 * enum import: this module also runs in the Share export worker, and a
 * value import pulled the entire fragments library into that bundle.
 */
const RENDERED_FACES_TWO = 1;

export type ClipBand = { minY: number; maxY: number };

export type ExportableGeometrySource = {
  /** Real loaded fragments models — geometry is fetched live and async, see buildExportGroup's doc comment for why. */
  fragmentsModels: FragmentsModel[];
  /** Plain Three.js objects that don't go through the fragments query API (currently: the route tube group). */
  plainObjects: THREE.Object3D[];
};

export type ExportGroupResult = {
  group: THREE.Group;
  /**
   * True if any real building geometry (not just the route tube) actually
   * made it into the group. The route tube is
   * always present whenever the Share button is even enabled, so callers
   * must check this — not just "does the group have any mesh children" —
   * to tell a real export apart from an empty room with a tube floating in
   * it, and fall back to the footprint proxy instead of silently sharing
   * that.
   */
  hasBuildingGeometry: boolean;
  /**
   * Counts across all fragments models, so a caller that falls back to the
   * proxy can log *why* (no items at all vs. everything clipped away vs.
   * every part failing to rebuild) instead of falling back silently.
   */
  stats: ExportStats;
};

export type ExportStats = {
  /** Items whose geometry was fetched. */
  items: number;
  /** Items skipped before fetching: their bounding box misses every clip band. */
  itemsSkipped: number;
  partsRebuilt: number;
  /** Clipped pieces kept, before merging. */
  piecesKept: number;
  /** Building meshes in the export after merging by material. */
  meshes: number;
};

/**
 * Turns the set of storeys a route touches into Three.js world-Y clip bands
 * for buildExportGroup, so the live-geometry export only includes the
 * storeys the route actually visits — not whatever the 3D Viewer's own
 * storey filter currently happens to show (which could be the entire
 * multi-storey building on an "all levels" view, completely unrelated to
 * the route). Works for any number of storeys, contiguous or not, e.g. a
 * route riding stairs from floor 1 to floor 5: each visited floor gets its
 * own band and nothing is invented for the floors in between.
 *
 * Reuses `resolveRouteTubeLiftOptions` (route-tube.ts) — the exact same
 * function that keeps the live on-screen route tube correctly placed,
 * including the coordination-matrix / centre-delta fallback logic — rather
 * than calling `ifcPlanToThree` bare the way the flat proxy path does.
 * `route-share-scene.ts`'s bare `planPoint()` is fine there because
 * everything in that scene goes through the same bare call self-consistently;
 * here the resulting Y has to line up with the *live fragments geometry's*
 * real world-Y (positioned via each item's true model transform), which a
 * bare call does not reliably do once a model has a coordination matrix.
 *
 * The per-storey band formula (next storey's elevation, or +3.5m if
 * topmost; band = [elev - 0.25, elev + max(nextElev - elev, 1.5) * 0.78])
 * matches InferModelViewport's own single-storey clip-band effect exactly,
 * so "one storey's slice" means the same thing here as it does in the live
 * viewer's storey filter.
 *
 * Returns null (meaning: don't clip, export everything visible) whenever
 * the inputs can't support a reliable band — missing model bounds, no
 * storeys, or no footprint data to build plan bounds from — rather than
 * risk clipping away a real export down to nothing.
 */
export function buildRouteStoreyClipBands(args: {
  footprints: FootprintsDocument;
  storeyIds: ReadonlySet<string>;
  modelBounds: ThreeAabb | null;
  coordInverse: Mat4Elements | null;
}): ClipBand[] | null {
  const { footprints, storeyIds, modelBounds, coordInverse } = args;
  if (!modelBounds || storeyIds.size === 0) return null;

  const planBounds = footprintPlanBounds(footprints);
  if (!planBounds) return null;

  const modelHeightM = modelBounds.maxY - modelBounds.minY;
  const ranked = storeysMetres(footprints, modelHeightM).sort((a, b) => a.elevation - b.elevation);
  if (!ranked.length) return null;

  const storeyElevationsM = elevationsForVerticalRemap(ranked, spaceStoreyIds(footprints));
  const liftOpts = resolveRouteTubeLiftOptions({
    planBounds,
    probeElevationM: storeyElevationsM.length
      ? Math.min(...storeyElevationsM)
      : ranked[0]!.elevation,
    modelBounds,
    storeyElevationsM,
    coordInverse,
  });
  // resolveRouteTubeLiftOptions bakes in ROUTE_TUBE_HEIGHT_OFFSET_M (0.7m —
  // how far the *tube* floats above the floor for visibility). A clip band
  // needs the true storey elevation, not that tube-specific lift — same
  // fix InferModelViewport.tsx's own single-storey clip-band effect applies
  // ("No height offset — clip against true storey elevations").
  liftOpts.heightOffsetM = 0;

  const midX = (planBounds.minX + planBounds.maxX) / 2;
  const midY = (planBounds.minY + planBounds.maxY) / 2;

  const bands: ClipBand[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const storey = ranked[i]!;
    if (!storeyIds.has(storey.global_id)) continue;
    const nextElev = i + 1 < ranked.length ? ranked[i + 1]!.elevation : storey.elevation + 3.5;
    const storeyHeight = Math.max(nextElev - storey.elevation, 1.5);
    const minElevM = storey.elevation - 0.25;
    const maxElevM = storey.elevation + storeyHeight * 0.78;
    const lo = ifcPlanToThree(midX, midY, minElevM, liftOpts);
    const hi = ifcPlanToThree(midX, midY, maxElevM, liftOpts);
    bands.push({ minY: Math.min(lo.y, hi.y), maxY: Math.max(lo.y, hi.y) });
  }
  return bands.length ? bands : null;
}

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
 * reading whatever three.js happens to still have cached.
 *
 * Which items get fetched depends on `clipBands`:
 * - Set (the route's own storeys, see buildRouteStoreyClipBands): every item
 *   in the model, cropped to those bands. NOT `model.visibleItems` — that
 *   is "items with at least one tile rendered on screen", i.e. it depends
 *   on the 3D Viewer's camera framing and storey filter. Intersecting it
 *   with the route's bands exported only whatever happened to be on screen,
 *   and nothing at all when the route's storeys weren't being shown — which
 *   silently dropped the share onto the footprint proxy.
 * - Null (no scope could be computed): `visibleItems`, falling back to
 *   every item if nothing has rendered yet, so an unscoped export is at
 *   least bounded by what the viewer shows instead of the whole building.
 *
 * Clipping matches applyStoreyFilter's own no-capping clippingPlanes, so an
 * item straddling a band (e.g. a wall spanning two storeys) is cropped to
 * the slice inside it, not exported whole (see clipGeometryToBands below).
 *
 * Per-item/part failures are caught and skipped (logged, not fatal) —
 * given how much has gone wrong in this pipeline already, one bad part
 * should degrade the export, not blank it.
 */
export async function buildExportGroup(
  source: ExportableGeometrySource,
  clipBands: ClipBand[] | null,
): Promise<ExportGroupResult> {
  return buildExportScene(await gatherExportPayload(source, clipBands), clipBands);
}

// --- Gather (main thread) ---------------------------------------------------
//
// Only this half touches fragments — its data API lives on the main thread.
// Everything it returns is plain typed arrays and numbers, so the heavy half
// (buildExportScene: rebuild, clip, merge, then GLB/USDZ encoding) can run in
// a Web Worker without freezing the page (see share-export-client.ts).

/** Material as plain data: linear RGB, like THREE.Color's own components. */
export type StyleData = {
  color: [number, number, number];
  opacity: number;
  transparent: boolean;
  side: THREE.Side;
};

/** One geometry part, untransformed, plus the world matrix to bake into it. */
export type ExportPart = {
  positions: Float32Array | Float64Array;
  normals?: Int16Array | Float32Array;
  indices?: Uint8Array | Uint16Array | Uint32Array;
  /** Column-major world matrix (Matrix4.elements). */
  matrix: number[];
  style: StyleData | null;
};

export type ExportPayload = {
  /** Building geometry from fragments — clipped and merged by material. */
  parts: ExportPart[];
  /** The live route tube(s) — clipped, never merged. */
  tubes: ExportPart[];
  /** Items fetched, and items skipped by the bounding-box prefilter. */
  items: number;
  itemsSkipped: number;
};

export async function gatherExportPayload(
  source: ExportableGeometrySource,
  clipBands: ClipBand[] | null,
): Promise<ExportPayload> {
  const payload: ExportPayload = { parts: [], tubes: [], items: 0, itemsSkipped: 0 };
  for (const model of source.fragmentsModels) {
    try {
      await gatherModelParts(model, clipBands, payload);
    } catch (err) {
      console.warn("Share export: skipping a model whose geometry couldn't be fetched", err);
    }
  }
  for (const object of source.plainObjects) {
    object.updateMatrixWorld(true);
    object.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh) return;
      try {
        const part = plainMeshPart(node as THREE.Mesh);
        if (part) payload.tubes.push(part);
      } catch (err) {
        console.warn("Share export: skipping a mesh that couldn't be read", err);
      }
    });
  }
  return payload;
}

function styleData(style: Style): StyleData {
  return {
    color: [style.color.r, style.color.g, style.color.b],
    opacity: style.opacity,
    transparent: style.transparent,
    side: style.side,
  };
}

async function gatherModelParts(
  model: FragmentsModel,
  clipBands: ClipBand[] | null,
  payload: ExportPayload,
): Promise<void> {
  model.object.updateMatrixWorld(true);
  const modelMatrix = model.object.matrixWorld;

  // See buildExportGroup's doc comment for why a scoped export must not
  // start from visibleItems.
  let localIds = clipBands ? [] : Array.from(model.visibleItems);
  if (localIds.length === 0) {
    localIds = await model.getLocalIds();
  }
  if (clipBands) {
    const before = localIds.length;
    localIds = await itemsTouchingBands(model, localIds, clipBands);
    payload.itemsSkipped += before - localIds.length;
  }
  payload.items += localIds.length;
  if (localIds.length === 0) return;

  const [geometryPerItem, materialDefs] = await Promise.all([
    model.getItemsGeometry(localIds, FULL_GEOMETRY_LOD),
    model.getItemsMaterialDefinition(localIds),
  ]);
  const styleBySampleId = await sampleStyles(model, geometryPerItem);

  // Per-item fallback only — see sampleStyles for why it can't be trusted
  // as the primary source.
  const styleByLocalId = new Map<number, Style>();
  for (const entry of materialDefs) {
    for (const localId of entry.localIds) {
      styleByLocalId.set(localId, {
        color: safeColor(entry.definition.color),
        opacity: entry.definition.opacity,
        transparent: entry.definition.transparent,
        // A genuinely double-sided source element (glass panes, thin
        // one-surface panels) needs DoubleSide or the export silently loses
        // its back face — MeshStandardMaterial defaults to FrontSide.
        side:
          entry.definition.renderedFaces === RENDERED_FACES_TWO
            ? THREE.DoubleSide
            : THREE.FrontSide,
      });
    }
  }

  for (let i = 0; i < localIds.length; i++) {
    const parts = geometryPerItem[i];
    if (!parts) continue;
    const itemStyle = styleByLocalId.get(localIds[i]!);
    for (const part of parts) {
      if (!part.positions || part.positions.length === 0 || !part.transform) continue;
      const style =
        (part.sampleId != null ? styleBySampleId.get(part.sampleId) : undefined) ?? itemStyle;
      // Composition order confirmed against @thatopen/components' own
      // EdgesProjector, which consumes this exact API the same way:
      // `mesh.applyMatrix4(transform); mesh.applyMatrix4(model.object.matrixWorld)`
      // — i.e. modelMatrix * transform, item-local then model-world.
      const matrix = modelMatrix.clone().multiply(part.transform);
      payload.parts.push({
        positions: part.positions,
        ...(part.normals && part.normals.length > 0 ? { normals: part.normals } : {}),
        ...(part.indices && part.indices.length > 0 ? { indices: part.indices } : {}),
        matrix: Array.from(matrix.elements),
        style: style ? styleData(style) : null,
      });
    }
  }
}

/**
 * Drops items whose world bounding box can't reach any clip band, before
 * their geometry is fetched at all. Without this a route on 2 storeys of a
 * 20-storey building fetched and rebuilt all 20 storeys' geometry only to
 * clip 18 of them away. Boxes are cheap (fragments keeps them resident);
 * on any failure every item is kept, so this can only save work, never
 * lose geometry.
 */
async function itemsTouchingBands(
  model: FragmentsModel,
  localIds: number[],
  clipBands: ClipBand[],
): Promise<number[]> {
  try {
    const boxes = await model.getBoxes(localIds);
    if (boxes.length !== localIds.length) return localIds;
    return localIds.filter((_, i) => {
      const box = boxes[i];
      if (!box || box.isEmpty()) return true;
      return clipBands.some((band) => box.max.y >= band.minY && box.min.y <= band.maxY);
    });
  } catch (err) {
    console.warn("Share export: bounding boxes unavailable, fetching every item", err);
    return localIds;
  }
}

type Style = { color: THREE.Color; opacity: number; transparent: boolean; side: THREE.Side };

/**
 * fragments' `getItemsMaterialDefinition()` types its `color` field as
 * `THREE.Color`, but at runtime it is not reliably one — this crashed
 * every real item's material construction (`style.color.clone is not a
 * function`) for a model where fragments computes materials off-thread:
 * the value crosses a `postMessage` structured-clone boundary, which keeps
 * plain enumerable properties (`r`, `g`, `b`) but strips the class's
 * prototype methods. Reconstructing from those numeric components instead
 * of trusting the type declaration is what actually survives that.
 */
function safeColor(color: THREE.Color): THREE.Color {
  if (typeof color.clone === "function") return color.clone();
  const c = color as unknown as { r: number; g: number; b: number };
  return new THREE.Color(c.r, c.g, c.b);
}

/**
 * The exact colour of every geometry part, the way the live viewer draws it:
 * part → sample → material (fragments' own 0–255 sRGB bytes).
 *
 * `getItemsMaterialDefinition()` can't be the primary source: its worker
 * implementation reads `meshes.samples(itemIndex)` — an *item* index used
 * as a *sample* index — and keeps one material per item. So a multi-part
 * item (a door's frame, leaf, glass and handle) gets a single colour, often
 * one belonging to an unrelated sample; on a phone that showed up as doors
 * and glass panes exported solid black.
 *
 * Empty map (callers fall back per item) if the lookup API isn't available.
 */
async function sampleStyles(
  model: FragmentsModel,
  geometryPerItem: MeshData[][],
): Promise<Map<number, Style>> {
  const styles = new Map<number, Style>();
  const sampleIds = new Set<number>();
  for (const parts of geometryPerItem) {
    for (const part of parts ?? []) if (part.sampleId != null) sampleIds.add(part.sampleId);
  }
  if (sampleIds.size === 0) return styles;
  try {
    const samples = await model.getSamples([...sampleIds]);
    const materialIds = new Set<number>();
    for (const sample of samples.values()) materialIds.add(sample.material);
    const materials = await model.getMaterials([...materialIds]);
    for (const [sampleId, sample] of samples) {
      const material = materials.get(sample.material);
      if (!material) continue;
      styles.set(sampleId, {
        // Same conversion fragments' own ParserHelper.parseMaterial uses.
        color: new THREE.Color().setRGB(
          material.r / 255,
          material.g / 255,
          material.b / 255,
          THREE.SRGBColorSpace,
        ),
        opacity: material.a / 255,
        transparent: material.a < 255,
        side: material.renderedFaces === RENDERED_FACES_TWO ? THREE.DoubleSide : THREE.FrontSide,
      });
    }
  } catch (err) {
    console.warn("Share export: per-part colours unavailable, using per-item colours", err);
  }
  return styles;
}

/**
 * fragments hands normals over as Int16 (signed-normalized). Exported
 * as-is they force the `KHR_mesh_quantization` glTF extension, and
 * USDZExporter writes the raw integers straight into the USD file — either
 * way phone viewers light those surfaces wrongly, often solid black. Plain
 * float normals are what every viewer reads correctly.
 */
function floatNormals(normals: Int16Array): Float32Array {
  const out = new Float32Array(normals.length);
  for (let i = 0; i < normals.length; i++) out[i] = Math.max(normals[i]! / 32767, -1);
  return out;
}

/**
 * A mirroring transform (negative determinant — common for mirrored IFC
 * instances) flips triangle winding once it's baked into the vertices.
 * Three.js compensates for a mirrored *object* at draw time, but baked
 * geometry has no object transform left to compensate for, so front faces
 * would point inward and render dark/culled. Reverse each triangle instead.
 */
function flipWinding(geometry: THREE.BufferGeometry) {
  const index = geometry.getIndex();
  if (index) {
    const a = index.array;
    for (let i = 0; i + 2 < a.length; i += 3) {
      const t = a[i + 1]!;
      a[i + 1] = a[i + 2]!;
      a[i + 2] = t;
    }
    index.needsUpdate = true;
    return;
  }
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name) as THREE.BufferAttribute;
    const size = attr.itemSize;
    const a = attr.array;
    for (let v = 0; v + 2 < attr.count; v += 3) {
      for (let k = 0; k < size; k++) {
        const i1 = (v + 1) * size + k;
        const i2 = (v + 2) * size + k;
        const t = a[i1]!;
        a[i1] = a[i2]!;
        a[i2] = t;
      }
    }
    attr.needsUpdate = true;
  }
}

// --- Build (pure; runs in the export worker) --------------------------------

/**
 * Rebuilds, clips and merges a gathered payload into an exporter-ready
 * group. Pure three.js — no fragments, no DOM — so it runs in a Worker.
 *
 * Building geometry is merged into one mesh per distinct material. The
 * first live-geometry share of a small house was 207 meshes with 207
 * materials (a fresh material per part, even identical ones); a real
 * building is thousands of each, i.e. thousands of draw calls in AR Quick
 * Look / Scene Viewer and a larger file. Per-element identity isn't needed
 * in a shared route model, so parts that look the same become one mesh.
 */
export function buildExportScene(
  payload: ExportPayload,
  clipBands: ClipBand[] | null,
): ExportGroupResult {
  const group = new THREE.Group();
  const stats: ExportStats = {
    items: payload.items,
    itemsSkipped: payload.itemsSkipped,
    partsRebuilt: 0,
    piecesKept: 0,
    meshes: 0,
  };

  const byStyle = new Map<
    string,
    { style: StyleData | null; geometries: THREE.BufferGeometry[] }
  >();
  for (const part of payload.parts) {
    try {
      const geometry = rebuildPartGeometry(part);
      if (!geometry) continue;
      stats.partsRebuilt++;
      const key = styleKey(part.style);
      let bucket = byStyle.get(key);
      if (!bucket) {
        bucket = { style: part.style, geometries: [] };
        byStyle.set(key, bucket);
      }
      for (const piece of clipGeometryToBands(geometry, clipBands)) {
        bucket.geometries.push(piece);
        stats.piecesKept++;
      }
    } catch (err) {
      console.warn("Share export: skipping an item part that couldn't be rebuilt", err);
    }
  }
  for (const { style, geometries } of byStyle.values()) {
    const material = materialFor(style);
    for (const geometry of mergeForExport(geometries)) {
      group.add(new THREE.Mesh(geometry, material));
      stats.meshes++;
    }
  }

  // The route tube is clipped by the same bands live too: applyStoreyFilter
  // sets `renderer.clippingPlanes` globally, which — unlike
  // `material.clippingPlanes` — applies to every material rendered, tube
  // included, not just fragments' own materials.
  for (const tube of payload.tubes) {
    try {
      const geometry = rebuildPartGeometry(tube);
      if (!geometry) continue;
      const material = materialFor(tube.style);
      for (const piece of clipGeometryToBands(geometry, clipBands)) {
        const mesh = new THREE.Mesh(piece, material);
        mesh.name = "route-tube";
        group.add(mesh);
      }
    } catch (err) {
      console.warn("Share export: skipping a mesh that couldn't be rebuilt", err);
    }
  }

  // No baked lights: glTF/USDZ export silently drops HemisphereLight
  // entirely (no ambient-light equivalent in the format) and doesn't
  // reliably preserve a DirectionalLight's aim either — every mainstream
  // glTF/USDZ viewer (AR Quick Look, Android Scene Viewer, model-viewer)
  // already applies its own default environment lighting to arbitrary
  // content, which is what actually makes this render correctly on a
  // phone; relying on lights this export can't reliably carry just adds
  // risk (see route-share-scene.ts's buildRouteShareScene for the same call).
  return { group, hasBuildingGeometry: stats.piecesKept > 0, stats };
}

function styleKey(style: StyleData | null): string {
  if (!style) return "default";
  const [r, g, b] = style.color.map((c) => Math.round(c * 1e4));
  return `${r},${g},${b}|${Math.round(style.opacity * 1e3)}|${style.transparent ? 1 : 0}|${style.side}`;
}

function materialFor(style: StyleData | null): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: style ? new THREE.Color(...style.color) : new THREE.Color(0x808080),
    opacity: style?.opacity ?? 1,
    transparent: style?.transparent ?? false,
    side: style?.side ?? THREE.FrontSide,
  });
}

/**
 * Merges same-material geometries into as few as possible. Every input is
 * normalised to exactly position + normal + Uint32 index first, since
 * mergeGeometries needs identical attribute sets and indexing. Falls back to
 * the inputs unmerged if three refuses the merge, so this can only reduce
 * mesh count, never drop geometry.
 */
function mergeForExport(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
  if (geometries.length <= 1) return geometries;
  const normalised = geometries.map((geometry) => {
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", geometry.getAttribute("position"));
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    out.setAttribute("normal", geometry.getAttribute("normal"));
    const count = (geometry.getAttribute("position") as THREE.BufferAttribute).count;
    const index = geometry.getIndex();
    const indices = new Uint32Array(index ? index.count : count);
    for (let i = 0; i < indices.length; i++) indices[i] = index ? index.getX(i) : i;
    out.setIndex(new THREE.BufferAttribute(indices, 1));
    return out;
  });
  const merged = mergeGeometries(normalised, false);
  return merged ? [merged] : geometries;
}

function rebuildPartGeometry(part: ExportPart): THREE.BufferGeometry | null {
  if (!part.positions || part.positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(Float32Array.from(part.positions), 3),
  );

  if (part.normals && part.normals.length > 0) {
    const normals =
      part.normals instanceof Int16Array
        ? floatNormals(part.normals)
        : Float32Array.from(part.normals);
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  } else {
    geometry.computeVertexNormals();
  }

  if (part.indices && part.indices.length > 0) {
    // Already a proper integer typed array (Uint8/16/32Array) straight from
    // fragments — no Float32-index bug risk here the way the old raw-array
    // extraction path had. Copied, since flipWinding may rewrite it in place.
    geometry.setIndex(new THREE.BufferAttribute(part.indices.slice(), 1));
  }

  const worldMatrix = new THREE.Matrix4().fromArray(part.matrix);
  geometry.applyMatrix4(worldMatrix);
  if (worldMatrix.determinant() < 0) flipWinding(geometry);
  return geometry;
}

// --- Storey clip bands ---
//
// The live viewer isolates one storey with `renderer.clippingPlanes` /
// `material.clippingPlanes` (see applyStoreyFilter in that-open-runtime.ts)
// — a GPU fragment-level clip with no capping: geometry past the plane
// just isn't drawn, the object reads as an open/hollow cross-section, not a
// sealed cut face. `model.visibleItems` (what scopes the export to begin
// with) marks an item visible if ANY part of it renders, so an item that
// merely *straddles* a band — e.g. a wall spanning two storeys — was
// being exported whole, unclipped, even though the live view only shows
// the slice inside the band. These functions replicate that same
// no-capping clip on the exported geometry so the two match.

const CLIP_PLANE_NORMAL_MIN = new THREE.Vector3(0, 1, 0);
const CLIP_PLANE_NORMAL_MAX = new THREE.Vector3(0, -1, 0);

/**
 * Clips a geometry against every band and keeps whatever survives any of
 * them — `null` bands means "keep everything" (returned unchanged). One
 * that spans two *kept* bands with an *excluded* gap between (e.g. a shaft
 * running through floor 1 and floor 5 on a route that skips floors 2-4)
 * correctly comes back as two separate pieces, one per band, with nothing
 * invented in the gap — each independent call to clipGeometryToBand already
 * culls whatever's outside its own band, so no dedup/merge step is needed
 * here beyond collecting the non-null results.
 */
function clipGeometryToBands(
  geometry: THREE.BufferGeometry,
  clipBands: ClipBand[] | null,
): THREE.BufferGeometry[] {
  if (!clipBands) return [geometry];
  const pieces: THREE.BufferGeometry[] = [];
  for (const band of clipBands) {
    const piece = clipGeometryToBand(geometry, band);
    if (piece) pieces.push(piece);
  }
  return pieces;
}

/**
 * Clips a geometry to `clipBand` (returns a new geometry; the input is
 * left untouched). Returns the same geometry unchanged when it's already
 * fully inside the band (the common case — most items live on one storey
 * and never approach the clip planes), null when it's fully outside
 * (culled entirely), and a new geometry with recomputed normals when it
 * actually straddles a plane and needs real clipping.
 */
function clipGeometryToBand(
  source: THREE.BufferGeometry,
  clipBand: ClipBand,
): THREE.BufferGeometry | null {
  const positionAttr = source.getAttribute("position") as THREE.BufferAttribute;
  const positions = positionAttr.array as Float32Array;
  if (positions.length === 0) return null;

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minY >= clipBand.minY && maxY <= clipBand.maxY) return source;
  if (maxY < clipBand.minY || minY > clipBand.maxY) return null;

  const indexAttr = source.getIndex();
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

  return geometry;
}

/** Sutherland-Hodgman polygon clip applied per-triangle, against each plane in sequence — no capping (see clipGeometryToBand's doc comment). */
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

/**
 * The live route tube as an ExportPart. Exported opaque whatever the live
 * material says (the viewer draws it at 0.85 opacity): transparent surfaces
 * are depth-sorted per object in AR viewers and regularly draw in the wrong
 * order against glass and each other, and the proxy path's tube is opaque
 * already — so both paths now look the same.
 */
function plainMeshPart(mesh: THREE.Mesh): ExportPart | null {
  const src = mesh.geometry;
  const positionAttr = src.getAttribute("position");
  if (!hasBackingArray(positionAttr) || positionAttr.count === 0) return null;
  const normalAttr = src.getAttribute("normal");
  const index = src.getIndex();
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const color = (material as { color?: unknown } | undefined)?.color;
  return {
    positions: extractAttribute(positionAttr, 3),
    ...(hasBackingArray(normalAttr) ? { normals: extractAttribute(normalAttr, 3) } : {}),
    ...(index && hasBackingArray(index)
      ? { indices: cloneIndexAttribute(index).array as Uint8Array | Uint16Array | Uint32Array }
      : {}),
    matrix: Array.from(mesh.matrixWorld.elements),
    style: {
      color: color instanceof THREE.Color ? [color.r, color.g, color.b] : [0.5, 0.5, 0.5],
      opacity: 1,
      transparent: false,
      side: (material as { side?: THREE.Side } | undefined)?.side ?? THREE.FrontSide,
    },
  };
}
