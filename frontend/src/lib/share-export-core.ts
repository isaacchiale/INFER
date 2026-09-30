import * as THREE from "three";
import { exportGLB } from "@/lib/export-glb";
import { exportUSDZ } from "@/lib/export-usdz";
import {
  buildExportScene,
  type ClipBand,
  type ExportPayload,
  type ExportStats,
} from "@/lib/live-scene-export";

/**
 * Everything the Share export needs, as structured-clone-safe data, so the
 * expensive part — rebuilding, clipping and merging the building geometry,
 * then encoding both GLB and USDZ — runs in a Web Worker instead of
 * freezing the page (share-export.worker.ts / share-export-client.ts).
 * runShareExport is also the in-page fallback if a worker can't start.
 */
export type ShareExportInput = {
  /** Live IFC geometry, or null for the footprint proxy (everything in `extras`). */
  payload: ExportPayload | null;
  clipBands: ClipBand[] | null;
  /** Ready-made meshes added as-is: the proxy scene, the route arrows. */
  extras: SerializedMesh[];
  /** AnimationClip.toJSON() output, bound to `extras` by node name. */
  clips: unknown[];
};

export type ShareExportOutput = {
  /** False when the payload had no building geometry left — caller falls back to the proxy. */
  hasBuildingGeometry: boolean;
  glb: ArrayBuffer | null;
  usdz: ArrayBuffer | null;
  /** Why the USDZ is missing, when the GLB succeeded but it didn't. */
  usdzError: string | null;
  stats: ExportStats | null;
};

export type SerializedMesh = {
  name: string;
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint16Array | Uint32Array | null;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  material: {
    color: [number, number, number];
    opacity: number;
    transparent: boolean;
    side: THREE.Side;
    roughness: number;
    metalness: number;
  };
};

/**
 * Flattens every mesh under `root` into plain data. Each mesh keeps its own
 * world transform as position/quaternion/scale (not baked into vertices)
 * because animation tracks — the route arrows — target exactly those.
 */
export function serializeMeshes(root: THREE.Object3D): SerializedMesh[] {
  const out: SerializedMesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!position || position.count === 0) return;
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
    const index = geometry.getIndex();
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      THREE.MeshStandardMaterial | undefined;
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    mesh.matrixWorld.decompose(p, q, s);
    out.push({
      name: mesh.name,
      positions: Float32Array.from(position.array),
      normals: normal ? Float32Array.from(normal.array) : null,
      indices: index
        ? index.count > 65535
          ? Uint32Array.from(index.array)
          : Uint16Array.from(index.array)
        : null,
      position: [p.x, p.y, p.z],
      quaternion: [q.x, q.y, q.z, q.w],
      scale: [s.x, s.y, s.z],
      material: {
        color: material?.color
          ? [material.color.r, material.color.g, material.color.b]
          : [0.5, 0.5, 0.5],
        opacity: material?.opacity ?? 1,
        transparent: material?.transparent ?? false,
        side: material?.side ?? THREE.FrontSide,
        roughness: material?.roughness ?? 1,
        metalness: material?.metalness ?? 0,
      },
    });
  });
  return out;
}

function deserializeMesh(m: SerializedMesh, materials: Map<string, THREE.Material>): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  if (m.normals) geometry.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
  else geometry.computeVertexNormals();
  if (m.indices) geometry.setIndex(new THREE.BufferAttribute(m.indices, 1));
  // Identical materials share one instance, so the exporters write one
  // material, not one per mesh (every arrow chevron, every proxy wall).
  const key = JSON.stringify(m.material);
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(...m.material.color),
      opacity: m.material.opacity,
      transparent: m.material.transparent,
      side: m.material.side,
      roughness: m.material.roughness,
      metalness: m.material.metalness,
    });
    materials.set(key, material);
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = m.name;
  mesh.position.fromArray(m.position);
  mesh.quaternion.fromArray(m.quaternion);
  mesh.scale.fromArray(m.scale);
  return mesh;
}

export async function runShareExport(input: ShareExportInput): Promise<ShareExportOutput> {
  const root = new THREE.Group();
  let stats: ExportStats | null = null;
  if (input.payload) {
    const built = buildExportScene(input.payload, input.clipBands);
    stats = built.stats;
    if (!built.hasBuildingGeometry) {
      return { hasBuildingGeometry: false, glb: null, usdz: null, usdzError: null, stats };
    }
    root.add(built.group);
  }
  const materials = new Map<string, THREE.Material>();
  for (const m of input.extras) root.add(deserializeMesh(m, materials));
  const clips = input.clips.map((json) =>
    THREE.AnimationClip.parse(json as Parameters<typeof THREE.AnimationClip.parse>[0]),
  );

  const glb = await (await exportGLB(root, clips)).arrayBuffer();
  // A USDZ failure shouldn't sink the GLB share (the landing route falls
  // back to the GLB for everyone) — report it instead of throwing.
  let usdz: ArrayBuffer | null = null;
  let usdzError: string | null = null;
  try {
    usdz = await (await exportUSDZ(root, clips)).arrayBuffer();
  } catch (err) {
    usdzError = err instanceof Error ? err.message : String(err);
  }
  return { hasBuildingGeometry: true, glb, usdz, usdzError, stats };
}
