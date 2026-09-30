import * as THREE from "three";

/**
 * Small chevrons gliding along the route tube toward the destination — the
 * direction cue the removed start/end spheres were meant to give, as motion
 * instead of extra static geometry. Exported as a real animation clip, so
 * it plays inside AR Quick Look (USDZ time samples) and Scene Viewer /
 * model-viewer (glTF animation) with no app or script.
 *
 * Conveyor loop: every chevron travels exactly one spacing per cycle, so
 * the frame at the end of the clip is identical to the frame at the start
 * and the loop has no visible jump. The first chevron grows in at the route
 * start and the last shrinks out at the end, so nothing pops.
 */

/** Walking pace, m/s. */
const SPEED_M_S = 1.0;
/** Distance between consecutive chevrons, metres. */
const SPACING_M = 2.5;
/** Keyframes per chevron per loop; linear interpolation in between. */
const SAMPLES = 24;
/** Per tube, so a very long route doesn't turn into a swarm. */
const MAX_PER_TUBE = 24;
/** Pale blue, so it reads on the blue tube without shouting. */
const ARROW_COLOR = 0xdbeafe;

export type RouteTubePath = {
  curve: THREE.Curve<THREE.Vector3>;
  radius: number;
  /** Local → export-space transform of the tube (identity if already baked). */
  matrix?: THREE.Matrix4;
};

/** Cycle length shared by every chevron on every tube. */
export const ROUTE_ARROW_LOOP_S = SPACING_M / SPEED_M_S;

/** Flat "V" lying in the XZ plane, pointing +Z, sized to the tube radius. */
function chevronGeometry(radius: number): THREE.BufferGeometry {
  const w = radius * 1.1; // half-width
  const l = radius * 0.9; // tip-to-arm length
  const t = radius * 0.35; // arm thickness along travel
  const shape = new THREE.Shape();
  shape.moveTo(0, l);
  shape.lineTo(w, 0);
  shape.lineTo(w, -t);
  shape.lineTo(0, l - t);
  shape.lineTo(-w, -t);
  shape.lineTo(-w, 0);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: radius * 0.12,
    bevelEnabled: false,
  });
  // Shape is drawn in XY pointing +Y; lay it flat pointing +Z, centred on
  // its thickness so it straddles the tube's top surface.
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, radius * 0.06, 0);
  return geometry;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Orientation that points the chevron's +Z along `tangent`, kept upright. */
function orientAlong(tangent: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const flat = new THREE.Vector3(tangent.x, 0, tangent.z);
  // Near-vertical travel (a ramp/stair segment): keep the last heading.
  if (flat.lengthSq() < 1e-6) return out;
  flat.normalize();
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), flat, UP);
  // lookAt aims -Z at the target; the chevron points +Z.
  out.setFromRotationMatrix(m).multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI));
  return out;
}

/**
 * Null when no tube is long enough to carry a chevron. Node names are
 * unique and stable ("route-arrow-<tube>-<n>"): both exporters bind the
 * clip's tracks to nodes by name.
 */
export function buildRouteArrows(
  tubes: RouteTubePath[],
): { group: THREE.Group; clip: THREE.AnimationClip } | null {
  const group = new THREE.Group();
  group.name = "route-arrows";
  const tracks: THREE.KeyframeTrack[] = [];
  const material = new THREE.MeshStandardMaterial({
    color: ARROW_COLOR,
    roughness: 0.4,
    metalness: 0,
  });
  const times = Array.from({ length: SAMPLES + 1 }, (_, k) => (k / SAMPLES) * ROUTE_ARROW_LOOP_S);

  tubes.forEach((tube, tubeIndex) => {
    const matrix = tube.matrix ?? new THREE.Matrix4();
    const scale = new THREE.Vector3().setFromMatrixScale(matrix);
    const worldRadius = tube.radius * Math.max(scale.x, scale.y, scale.z);
    const localLength = tube.curve.getLength();
    const length = localLength * Math.max(scale.x, scale.y, scale.z);
    const count = Math.min(MAX_PER_TUBE, Math.floor(length / SPACING_M));
    if (count < 1) return;
    // Centre the run of chevrons on the tube; leftover length splits evenly.
    const lead = (length - count * SPACING_M) / 2;
    const geometry = chevronGeometry(worldRadius);
    const point = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const q = new THREE.Quaternion();

    for (let n = 0; n < count; n++) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `route-arrow-${tubeIndex}-${n}`;
      const positions: number[] = [];
      const quaternions: number[] = [];
      const scales: number[] = [];
      for (let k = 0; k <= SAMPLES; k++) {
        const s = lead + (n + k / SAMPLES) * SPACING_M; // metres along the tube
        const u = Math.min(1, Math.max(0, s / length));
        tube.curve.getPointAt(u, point).applyMatrix4(matrix);
        tube.curve.getTangentAt(u, tangent).transformDirection(matrix);
        // Ride on top of the tube, not inside it.
        positions.push(point.x, point.y + worldRadius, point.z);
        orientAlong(tangent, q);
        quaternions.push(q.x, q.y, q.z, q.w);
        // Grow in over the first chevron's cycle, shrink out over the last.
        const f = k / SAMPLES;
        const size = n === 0 && count > 1 ? f : n === count - 1 && count > 1 ? 1 - f : 1;
        const c = count === 1 ? Math.sin(Math.PI * f) : size;
        const v = Math.max(c, 1e-3);
        scales.push(v, v, v);
      }
      mesh.position.fromArray(positions, 0);
      mesh.quaternion.fromArray(quaternions, 0);
      mesh.scale.setScalar(scales[0]!);
      group.add(mesh);
      tracks.push(
        new THREE.VectorKeyframeTrack(`${mesh.name}.position`, times, positions),
        new THREE.QuaternionKeyframeTrack(`${mesh.name}.quaternion`, times, quaternions),
        new THREE.VectorKeyframeTrack(`${mesh.name}.scale`, times, scales),
      );
    }
  });

  if (!group.children.length) return null;
  return { group, clip: new THREE.AnimationClip("route-arrows", ROUTE_ARROW_LOOP_S, tracks) };
}

/**
 * Every route tube (TubeGeometry mesh) under `roots`, with its world
 * transform. Matched by geometry `type` rather than instanceof, which breaks
 * across duplicate three.js copies (see that-open-runtime.ts's isMatrix4 note).
 */
export function collectRouteTubes(roots: THREE.Object3D[]): RouteTubePath[] {
  const tubes: RouteTubePath[] = [];
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || mesh.geometry?.type !== "TubeGeometry") return;
      const { path, radius } = (mesh.geometry as THREE.TubeGeometry).parameters;
      tubes.push({ curve: path, radius, matrix: mesh.matrixWorld.clone() });
    });
  }
  return tubes;
}
