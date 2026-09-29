import type { Object3D } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

/**
 * Cap embedded texture resolution on export. Three's GLTFExporter has no
 * mesh-compression option (no Draco/meshopt path) short of pulling in a
 * separate encoder — but the real cost for a share of the live IFC geometry
 * is baked material textures, not this route's own geometry (a tube plus a
 * handful of room slabs), so bounding those is the lever actually worth
 * pulling without adding a new dependency to a phone-facing download.
 */
const MAX_TEXTURE_SIZE = 1024;

/** Export a Three.js object graph to a binary GLB Blob. */
export function exportGLB(object: Object3D): Promise<Blob> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      object,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(new Blob([result], { type: "model/gltf-binary" }));
        } else {
          reject(new Error("Expected binary GLB output"));
        }
      },
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
      { binary: true, maxTextureSize: MAX_TEXTURE_SIZE },
    );
  });
}
