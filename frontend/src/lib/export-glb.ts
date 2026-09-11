import type { Object3D } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

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
      { binary: true },
    );
  });
}
