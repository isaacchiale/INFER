import type { Object3D } from "three";
import { USDZExporter } from "three/addons/exporters/USDZExporter.js";

/**
 * Export a Three.js object graph to a USDZ Blob (Apple AR Quick Look).
 *
 * No material/geometry normalization here on purpose: every caller in this
 * app builds its export scene through either buildExportGroup
 * (live-scene-export.ts) or buildRouteShareScene (route-share-scene.ts),
 * both of which only ever construct fresh, standard THREE.MeshStandardMaterial
 * instances — never fragments' own materials directly. That's what actually
 * fixed the earlier crashes here (undefined .map, a material whose
 * constructor couldn't be called with zero arguments, a material with no
 * .color at all) — normalizing/substituting materials reactively in this
 * function was the wrong layer; the fix belongs where the export scene is
 * built, not patched afterward.
 */
export async function exportUSDZ(object: Object3D): Promise<Blob> {
  const bytes = await new USDZExporter().parseAsync(object);
  return new Blob([bytes], { type: "model/vnd.usdz+zip" });
}
