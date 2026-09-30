import type { AnimationClip, Object3D } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

/**
 * Export a Three.js object graph to a binary GLB Blob.
 *
 * No `maxTextureSize` cap: fragments' MaterialDefinition (color, opacity,
 * transparent, renderedFaces) carries no texture map, and neither the proxy
 * scene nor the route tube uses one, so a cap would be a no-op today and
 * only a silent fidelity ceiling if textures are ever added.
 */
export function exportGLB(object: Object3D, animations: AnimationClip[] = []): Promise<Blob> {
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
      { binary: true, animations },
    );
  });
}
