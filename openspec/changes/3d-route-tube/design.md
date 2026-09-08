## Context

See proposal.md — Why. Today the temp FE already has:

- That Open / Fragments / Three.js in `frontend/src/viewer/that-open-runtime.ts`
- Geometric 2D polylines via `continuousPolylineForStorey` (floorplan overlay)
- IFC plan ↔ Three mapping in `viewer-camera-pose.ts` (Y-up: `(x, elev, -y)` plus optional coordination matrix)

This change adds a client-side path mesh only; no backend or footprints schema work.

## Goals / Non-Goals

**Goals:**

- Runtime blue `TubeGeometry` (or equivalent volumetric ribbon) on `world.scene.three`
- Same XY source as the floorplan overlay for the active storey
- Height = storey elevation + small epsilon; dispose/rebuild cleanly

**Non-Goals:**

- GLB export/import as source of truth
- Stairs / multi-floor continuous tube / chevrons (API may keep `{x,y,z}` points so stairs can plug in later)
- Changing geometric path algorithms

## Decisions

### 1. Runtime Three.js mesh, not GLB

- **Choice:** Build `CatmullRomCurve3` → `TubeGeometry` → `Mesh` in the existing scene; rebuild when inputs change.
- **Why:** Route updates often; GLB would be a frozen dump of the same mesh.
- **Alternatives:** Export GLB each time (heavier); fat `Line2` (not the reference look).

### 2. Data flow

```
route.node_ids + footprints + activeStorey
        → continuousPolylineForStorey (existing)
        → lift each (x,y) to Three (x, elev+ε, -y) [+ coordination undo/apply as needed]
        → pathGroup mesh on That Open scene
```

Prefer applying the same transform used for the floorplan camera blue dot so Trapelo-scale models stay aligned.

### 3. Hosting the mesh

- Own a `THREE.Group` (e.g. `routeTubeGroup`) on the runtime; `setRouteTube(points3d | null)` clears previous geometry/materials and adds a new mesh.
- Wire from React/store when route / storey / footprints / coordination matrix change — keep geometry code out of React render bodies.

### 4. Visual defaults (POC)

- Radius ~0.15–0.25 m; translucent blue + slight emissive; `depthWrite` tuned / small ε to reduce z-fighting with slabs.
- No chevrons in v1.

### 5. Single-storey elevation

- Use footprints storey `elevation` when present; if null, fall back to a documented heuristic (e.g. 0 or last known) and still apply ε — note incompleteness in UI only if needed.
- Stair hops: truncate at portal on that floor (matches floorplan); no ramp.

### 6. Optional later export

- If demo export is needed later, `GLTFExporter` from the live mesh — out of scope here.

## Risks / Trade-offs

- **[Risk] Tube XY drifts from floorplan on coordinated models** → Reuse the same plan↔Three helpers as the camera pose / floorplan dot; verify on a large-site IFC (e.g. Trapelo).
- **[Risk] Z-fighting with slabs** → Small height offset + material depth settings; tune ε empirically.
- **[Risk] Dense A\* polylines → heavy tubes** → Downsample / simplify points if needed (keep endpoints); CatmullRom helps visually.
- **[Trade-off] Single-storey only** → Incomplete story for multi-floor routes until stairs work lands; acceptable for v1 POC.

## Migration Plan

- Frontend-only; no data migration.
- Rollback: remove path group wiring; floorplan overlay unchanged.

## Open Questions

- Exact tube radius / colour tokens once seen in-building (tune during apply; not spec-blocking).
- Whether “all storeys” floorplan mode should hide the 3D tube or pick a primary storey (default: tube follows the same storey selection as the floorplan pane).
