/**
 * Whole-storey walkability grid: every navmesh region, door strip, wall and
 * furniture footprint on a storey painted once into typed arrays, so a click
 * route is a single A* over array lookups instead of a door graph whose edges
 * each need their own local walk.
 *
 * Regions only connect through portals. Two rooms whose polygons touch with no
 * door between them stay separate, because a step between different regions
 * is only allowed inside a portal's gate cells (or across a space↔space
 * opening). Blocking a portal closes its gate for that search only.
 * Blocking a space (same what-if overlay) forbids occupying that region's
 * cells without removing the room from the mesh.
 */

import {
  buildVerticalConnectors,
  regionAtPoint,
  storeyElevationLookup,
  verticalHopCost,
  type NavmeshPortal,
  type StoreyNavmesh,
} from "@/lib/navmesh";
import { occupancyRings, pointInPolygon, pointInSpace } from "@/lib/geometric-path";
import type { FootprintsDocument, Point2D } from "@/types/footprints";
import type { ConnectivityGraph } from "@/types/graph";

export type GridRouteOpts = {
  blockedPortalIds?: ReadonlySet<string>;
  blockedSpaceIds?: ReadonlySet<string>;
  blockedConnectorIds?: ReadonlySet<string>;
};

/** Portal-closed bits plus region indices that must not be occupied this search. */
type StepBlock = { portals: Uint8Array | null; regions: Set<number> | null };

export type GridPortal = {
  id: string;
  kind: NavmeshPortal["kind"];
  /** Region index on each side; `b` is -1 for an exit (outside isn't a region). */
  a: number;
  b: number;
  /** Cell containing the portal point — carved walkable, the target for exit searches. */
  cell: number;
  point: Point2D;
};

export type StoreyGrid = {
  storeyId: string;
  minX: number;
  minY: number;
  /** Cell edge length in metres. */
  cell: number;
  cols: number;
  rows: number;
  /** Region index → navmesh region spaceId. */
  regionIds: string[];
  /** Per cell: region index, {@link BLOCKED}, or {@link GATE_ONLY} (door strip carved through a wall). */
  region: Int16Array;
  /** Per cell: index into {@link gateGroups} for the portals whose gates cover it, or -1. */
  gate: Int16Array;
  /** Portal-index sets. Overlapping gates (one door joining 3 rooms, doors side by side) share a merged set. */
  gateGroups: number[][];
  /** Per cell: metres to the nearest wall / furniture / closed region boundary. */
  clear: Float32Array;
  portals: GridPortal[];
  /** `lo|hi` region-index pairs joined by a space↔space opening → portal indices. */
  openPairs: Map<string, number[]>;
};

const BLOCKED = -1;
const GATE_ONLY = -2;

const GRID_CELL_M = 0.2;
/** Coarsen the cell size past this so one huge storey can't allocate an unbounded grid. */
const MAX_GRID_CELLS = 800_000;
const DOOR_GATE_WIDTH_M = 0.9;
const SPACE_GATE_WIDTH_M = 1.2;
const MIN_GATE_WIDTH_M = 0.6;
const MAX_GATE_WIDTH_M = 2.4;
/** How far from a portal point to look for the region cells its gate must reach. */
const GATE_SEARCH_M = 2;
/** Pins further than this from any cell of their own region can't be placed on the grid. */
const PIN_SNAP_M = 1;
/** Steps closer than 1 m to a wall cost extra: 1 m → ×1, 0.5 m → ×2, 0 m → ×3. */
const WALL_CLEAR_M = 1;
const WALL_PENALTY = 2;
/** String-pull and fillets must stay this far from walls — A* already prefers
 * 1 m, but a taut shortcut was allowed to scrape the inner corner (0 m). */
const PULL_CLEAR_M = 0.4;
const DOORWAY_VOID_MAX_THICKNESS_M = 1;

const DC = [1, -1, 0, 0, 1, 1, -1, -1];
const DR = [0, 0, 1, -1, 1, -1, 1, -1];
const STEP_LEN = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function ringDist(px: number, py: number, ring: Point2D[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    best = Math.min(best, segDist(px, py, a.x, a.y, b.x, b.y));
  }
  return best;
}

function ringBounds(ring: Point2D[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

type GridFrame = Pick<StoreyGrid, "minX" | "minY" | "cell" | "cols" | "rows">;

function cellAt(g: GridFrame, x: number, y: number): number {
  const c = Math.floor((x - g.minX) / g.cell);
  const r = Math.floor((y - g.minY) / g.cell);
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return -1;
  return r * g.cols + c;
}

function cellCentre(g: GridFrame, idx: number): Point2D {
  const c = idx % g.cols;
  const r = (idx - c) / g.cols;
  return { x: g.minX + (c + 0.5) * g.cell, y: g.minY + (r + 0.5) * g.cell };
}

/** Calls `fn` for every cell whose centre falls within `pad` of the ring's bounding box. */
function forCellsNear(
  g: GridFrame,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  pad: number,
  fn: (idx: number, x: number, y: number) => void,
): void {
  const c0 = Math.max(0, Math.floor((bounds.minX - pad - g.minX) / g.cell));
  const c1 = Math.min(g.cols - 1, Math.floor((bounds.maxX + pad - g.minX) / g.cell));
  const r0 = Math.max(0, Math.floor((bounds.minY - pad - g.minY) / g.cell));
  const r1 = Math.min(g.rows - 1, Math.floor((bounds.maxY + pad - g.minY) / g.cell));
  for (let r = r0; r <= r1; r++) {
    const y = g.minY + (r + 0.5) * g.cell;
    for (let c = c0; c <= c1; c++) {
      fn(r * g.cols + c, g.minX + (c + 0.5) * g.cell, y);
    }
  }
}

/** Solid footprint cells, thickened by half a cell so thin walls never leave a diagonal gap. */
function forObstacleCells(g: GridFrame, ring: Point2D[], fn: (idx: number) => void): void {
  if (ring.length < 3) return;
  const half = g.cell * 0.5;
  forCellsNear(g, ringBounds(ring), half, (idx, x, y) => {
    if (pointInPolygon(x, y, ring) || ringDist(x, y, ring) <= half) fn(idx);
  });
}

function gateWidth(portal: NavmeshPortal, footprints: FootprintsDocument): number {
  if (portal.kind === "space") return SPACE_GATE_WIDTH_M;
  const door = portal.doorGlobalId
    ? footprints.doors.find((d) => d.global_id === portal.doorGlobalId)
    : null;
  const seg = door?.segment;
  if (seg && seg.length >= 2) {
    const w = Math.hypot(seg[1]!.x - seg[0]!.x, seg[1]!.y - seg[0]!.y);
    if (Number.isFinite(w) && w > 0) {
      return Math.max(MIN_GATE_WIDTH_M, Math.min(MAX_GATE_WIDTH_M, w));
    }
  }
  return DOOR_GATE_WIDTH_M;
}

function nearestRegionCell(grid: StoreyGrid, p: Point2D, regionIdx: number, radiusM: number): number {
  const c0 = Math.floor((p.x - grid.minX) / grid.cell);
  const r0 = Math.floor((p.y - grid.minY) / grid.cell);
  const rad = Math.ceil(radiusM / grid.cell);
  let best = -1;
  let bestD = Infinity;
  for (let r = r0 - rad; r <= r0 + rad; r++) {
    if (r < 0 || r >= grid.rows) continue;
    for (let c = c0 - rad; c <= c0 + rad; c++) {
      if (c < 0 || c >= grid.cols) continue;
      const idx = r * grid.cols + c;
      if (grid.region[idx] !== regionIdx) continue;
      const q = cellCentre(grid, idx);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    }
  }
  return bestD <= radiusM ? best : -1;
}

/** Gate-group index for a sorted portal-index set, created on first use. */
function gateGroupFor(grid: StoreyGrid, groupByKey: Map<string, number>, portals: number[]): number {
  const key = portals.join(",");
  let g = groupByKey.get(key);
  if (g == null) {
    g = grid.gateGroups.length;
    grid.gateGroups.push(portals);
    groupByKey.set(key, g);
  }
  return g;
}

function carveCapsule(
  grid: StoreyGrid,
  groupByKey: Map<string, number>,
  portalIdx: number,
  a: Point2D,
  b: Point2D,
  radius: number,
): void {
  const bounds = {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
  forCellsNear(grid, bounds, radius, (idx, x, y) => {
    if (segDist(x, y, a.x, a.y, b.x, b.y) > radius) return;
    if (grid.region[idx] === BLOCKED) grid.region[idx] = GATE_ONLY;
    const cur = grid.gate[idx]!;
    if (cur === -1) {
      grid.gate[idx] = gateGroupFor(grid, groupByKey, [portalIdx]);
      return;
    }
    const members = grid.gateGroups[cur]!;
    if (members.includes(portalIdx)) return;
    grid.gate[idx] = gateGroupFor(grid, groupByKey, [...members, portalIdx].sort((x, y) => x - y));
  });
}

function portalJoins(portal: GridPortal, r: number): boolean {
  return r === GATE_ONLY || r === portal.a || (portal.b >= 0 && r === portal.b);
}

/** Some open portal in gate group `g` joins both region labels. */
function gateAllows(
  grid: StoreyGrid,
  g: number,
  ru: number,
  rv: number,
  blocked: Uint8Array | null,
): boolean {
  if (g < 0) return false;
  for (const p of grid.gateGroups[g]!) {
    if (blocked?.[p]) continue;
    const portal = grid.portals[p]!;
    if (portalJoins(portal, ru) && portalJoins(portal, rv)) return true;
  }
  return false;
}

/** Two gate-only cells connect when an open portal covers both. */
function gatesShareOpenPortal(grid: StoreyGrid, gu: number, gv: number, blocked: Uint8Array | null): boolean {
  if (gu < 0 || gv < 0) return false;
  if (gu === gv) return grid.gateGroups[gu]!.some((p) => !blocked?.[p]);
  const other = grid.gateGroups[gv]!;
  return grid.gateGroups[gu]!.some((p) => !blocked?.[p] && other.includes(p));
}

/** Whether a walker may step from cell `u` to the adjacent cell `v`. */
function canStep(grid: StoreyGrid, u: number, v: number, block: StepBlock | null): boolean {
  const ru = grid.region[u]!;
  const rv = grid.region[v]!;
  if (ru === BLOCKED || rv === BLOCKED) return false;
  const closed = block?.regions;
  if (closed && ((ru >= 0 && closed.has(ru)) || (rv >= 0 && closed.has(rv)))) return false;
  const blocked = block?.portals ?? null;
  if (ru === rv && ru >= 0) return true;
  const gu = grid.gate[u]!;
  const gv = grid.gate[v]!;
  if (ru === GATE_ONLY && rv === GATE_ONLY) return gatesShareOpenPortal(grid, gu, gv, blocked);
  if (ru === GATE_ONLY || rv === GATE_ONLY) {
    return gateAllows(grid, ru === GATE_ONLY ? gu : gv, ru, rv, blocked);
  }
  if (gateAllows(grid, gu, ru, rv, blocked)) return true;
  if (gv !== gu && gateAllows(grid, gv, ru, rv, blocked)) return true;
  const open = grid.openPairs.get(pairKey(ru, rv));
  return !!open?.some((p) => !blocked?.[p]);
}

/** Two-pass chamfer distance transform: metres to the nearest wall or closed boundary. */
function computeClearance(grid: StoreyGrid): void {
  const { cols, rows } = grid;
  const n = cols * rows;
  const d = new Float32Array(n);
  for (let idx = 0; idx < n; idx++) {
    if (grid.region[idx] === BLOCKED) {
      d[idx] = 0;
      continue;
    }
    d[idx] = Infinity;
    const c = idx % cols;
    const r = (idx - c) / cols;
    for (let k = 0; k < 4; k++) {
      const nc = c + DC[k]!;
      const nr = r + DR[k]!;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) {
        d[idx] = 0.5;
        break;
      }
      if (!canStep(grid, idx, nr * cols + nc, null)) {
        d[idx] = 0.5;
        break;
      }
    }
  }
  const S = Math.SQRT2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      let v = d[idx]!;
      if (c > 0) v = Math.min(v, d[idx - 1]! + 1);
      if (r > 0) {
        v = Math.min(v, d[idx - cols]! + 1);
        if (c > 0) v = Math.min(v, d[idx - cols - 1]! + S);
        if (c < cols - 1) v = Math.min(v, d[idx - cols + 1]! + S);
      }
      d[idx] = v;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const idx = r * cols + c;
      let v = d[idx]!;
      if (c < cols - 1) v = Math.min(v, d[idx + 1]! + 1);
      if (r < rows - 1) {
        v = Math.min(v, d[idx + cols]! + 1);
        if (c < cols - 1) v = Math.min(v, d[idx + cols + 1]! + S);
        if (c > 0) v = Math.min(v, d[idx + cols - 1]! + S);
      }
      d[idx] = v;
    }
  }
  for (let idx = 0; idx < n; idx++) grid.clear[idx] = d[idx]! * grid.cell;
}

/** Paint one storey's navmesh regions, walls, furniture and portal gates into a grid. */
export function buildStoreyGrid(mesh: StoreyNavmesh, footprints: FootprintsDocument): StoreyGrid {
  let bMinX = Infinity;
  let bMinY = Infinity;
  let bMaxX = -Infinity;
  let bMaxY = -Infinity;
  for (const region of mesh.regions) {
    const b = ringBounds(region.polygon);
    bMinX = Math.min(bMinX, b.minX);
    bMinY = Math.min(bMinY, b.minY);
    bMaxX = Math.max(bMaxX, b.maxX);
    bMaxY = Math.max(bMaxY, b.maxY);
  }
  for (const p of mesh.portals) {
    bMinX = Math.min(bMinX, p.point.x);
    bMinY = Math.min(bMinY, p.point.y);
    bMaxX = Math.max(bMaxX, p.point.x);
    bMaxY = Math.max(bMaxY, p.point.y);
  }
  if (!Number.isFinite(bMinX)) {
    bMinX = bMinY = 0;
    bMaxX = bMaxY = 1;
  }
  const w = bMaxX - bMinX;
  const h = bMaxY - bMinY;
  const cell = Math.max(GRID_CELL_M, Math.sqrt(((w + 1) * (h + 1)) / MAX_GRID_CELLS));
  const margin = 2 * cell + 1;
  const minX = bMinX - margin;
  const minY = bMinY - margin;
  const cols = Math.max(2, Math.ceil((w + 2 * margin) / cell));
  const rows = Math.max(2, Math.ceil((h + 2 * margin) / cell));
  const n = cols * rows;

  const grid: StoreyGrid = {
    storeyId: mesh.storeyId,
    minX,
    minY,
    cell,
    cols,
    rows,
    regionIds: mesh.regions.map((r) => r.spaceId),
    region: new Int16Array(n).fill(BLOCKED),
    gate: new Int16Array(n).fill(-1),
    gateGroups: [],
    clear: new Float32Array(n),
    portals: [],
    openPairs: new Map(),
  };

  mesh.regions.forEach((region, i) => {
    if (region.polygon.length < 3) return;
    forCellsNear(grid, ringBounds(region.polygon), 0, (idx, x, y) => {
      if (grid.region[idx] !== BLOCKED) return;
      if (pointInSpace(x, y, region.polygon, region.holes)) grid.region[idx] = i;
    });
  });

  // Wall hulls fill their own doorways; thin wall voids re-open cells a region already claims.
  const voidMask = new Uint8Array(n);
  for (const opening of footprints.openings ?? []) {
    if (!opening.host_is_wall || opening.filled_by_window_global_id) continue;
    const poly = opening.polygon ?? [];
    if (poly.length < 3) continue;
    const b = ringBounds(poly);
    if (Math.min(b.maxX - b.minX, b.maxY - b.minY) > DOORWAY_VOID_MAX_THICKNESS_M) continue;
    forObstacleCells(grid, poly, (idx) => {
      voidMask[idx] = 1;
    });
  }
  for (const wall of footprints.walls ?? []) {
    if (wall.incomplete || wall.storey_global_id !== mesh.storeyId) continue;
    forObstacleCells(grid, wall.polygon, (idx) => {
      if (voidMask[idx] && grid.region[idx]! >= 0) return;
      grid.region[idx] = BLOCKED;
    });
  }

  const regionIndex = new Map(grid.regionIds.map((id, i) => [id, i]));
  const groupByKey = new Map<string, number>();
  mesh.portals.forEach((portal) => {
    const a = regionIndex.get(portal.spaceA) ?? -1;
    const b = portal.spaceB ? (regionIndex.get(portal.spaceB) ?? -1) : -1;
    if (a < 0) return;
    const pi = grid.portals.length;
    grid.portals.push({
      id: portal.id,
      kind: portal.kind,
      a,
      b,
      cell: cellAt(grid, portal.point.x, portal.point.y),
      point: portal.point,
    });
    const radius = gateWidth(portal, footprints) / 2;
    carveCapsule(grid, groupByKey, pi, portal.point, portal.point, radius);
    for (const side of b >= 0 ? [a, b] : [a]) {
      const near = nearestRegionCell(grid, portal.point, side, GATE_SEARCH_M);
      if (near >= 0) carveCapsule(grid, groupByKey, pi, portal.point, cellCentre(grid, near), radius);
    }
    if (portal.kind === "space" && b >= 0) {
      const key = pairKey(a, b);
      const list = grid.openPairs.get(key) ?? [];
      list.push(pi);
      grid.openPairs.set(key, list);
    }
  });

  // Painted after gates so a desk parked in a doorway really does block it.
  for (const item of footprints.furniture ?? []) {
    if (item.incomplete || item.storey_global_id !== mesh.storeyId) continue;
    for (const ring of occupancyRings(item)) {
      forObstacleCells(grid, ring, (idx) => {
        grid.region[idx] = BLOCKED;
      });
    }
  }

  computeClearance(grid);
  return grid;
}

/** Grids for every mesh, in the same order. Plain typed arrays + Maps, so it survives a worker hop. */
export function buildStoreyGrids(
  meshes: readonly StoreyNavmesh[],
  footprints: FootprintsDocument,
): StoreyGrid[] {
  return meshes.map((m) => buildStoreyGrid(m, footprints));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

class IndexHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.vals.length;
  }

  clear(): void {
    this.keys.length = 0;
    this.vals.length = 0;
  }

  push(key: number, val: number): void {
    const keys = this.keys;
    const vals = this.vals;
    let i = vals.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent]! <= key) break;
      keys[i] = keys[parent]!;
      vals[i] = vals[parent]!;
      i = parent;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** Pops the smallest key's value. Caller checks `size` first. */
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0]!;
    const lastKey = keys.pop()!;
    const lastVal = vals.pop()!;
    const n = vals.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const child = r < n && keys[r]! < keys[l]! ? r : l;
        if (keys[child]! >= lastKey) break;
        keys[i] = keys[child]!;
        vals[i] = vals[child]!;
        i = child;
      }
      keys[i] = lastKey;
      vals[i] = lastVal;
    }
    return top;
  }
}

type Scratch = {
  g: Float64Array;
  parent: Int32Array;
  seen: Uint32Array;
  done: Uint32Array;
  gen: number;
  heap: IndexHeap;
};

/** Search buffers reused across clicks on the same grid (a stamp marks which entries are live). */
const scratchByGrid = new WeakMap<StoreyGrid, Scratch>();

function scratchFor(grid: StoreyGrid): Scratch {
  let s = scratchByGrid.get(grid);
  if (!s) {
    const n = grid.cols * grid.rows;
    s = {
      g: new Float64Array(n),
      parent: new Int32Array(n),
      seen: new Uint32Array(n),
      done: new Uint32Array(n),
      gen: 0,
      heap: new IndexHeap(),
    };
    scratchByGrid.set(grid, s);
  }
  s.gen++;
  if (s.gen === 0xffffffff) {
    s.seen.fill(0);
    s.done.fill(0);
    s.gen = 1;
  }
  s.heap.clear();
  return s;
}

function stepPenalty(grid: StoreyGrid, idx: number): number {
  const c = grid.clear[idx]!;
  return c >= WALL_CLEAR_M ? 1 : 1 + WALL_PENALTY * (1 - c / WALL_CLEAR_M);
}

/**
 * Best-first search from `source`. `h` = 0 gives Dijkstra. `onSettle` returns
 * true to stop. Leaves parents in the scratch so callers can trace paths back.
 */
function search(
  grid: StoreyGrid,
  source: number,
  block: StepBlock | null,
  h: (idx: number) => number,
  onSettle: (idx: number) => boolean,
): Scratch {
  const s = scratchFor(grid);
  const { g, parent, seen, done, gen, heap } = s;
  const { cols, rows } = grid;
  g[source] = 0;
  parent[source] = -1;
  seen[source] = gen;
  heap.push(h(source), source);
  while (heap.size) {
    const u = heap.pop();
    if (done[u] === gen) continue;
    done[u] = gen;
    if (onSettle(u)) break;
    const c = u % cols;
    const r = (u - c) / cols;
    const penU = stepPenalty(grid, u);
    for (let k = 0; k < 8; k++) {
      const nc = c + DC[k]!;
      const nr = r + DR[k]!;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const v = nr * cols + nc;
      if (done[v] === gen) continue;
      if (!canStep(grid, u, v, block)) continue;
      if (k >= 4) {
        // No corner-cutting past a wall or a closed boundary.
        const o1 = r * cols + nc;
        const o2 = nr * cols + c;
        if (!canStep(grid, u, o1, block) || !canStep(grid, o1, v, block)) continue;
        if (!canStep(grid, u, o2, block) || !canStep(grid, o2, v, block)) continue;
      }
      const cost = STEP_LEN[k]! * grid.cell * 0.5 * (penU + stepPenalty(grid, v));
      const tentative = g[u]! + cost;
      if (seen[v] === gen && tentative >= g[v]!) continue;
      seen[v] = gen;
      g[v] = tentative;
      parent[v] = u;
      heap.push(tentative + h(v), v);
    }
  }
  return s;
}

function tracePath(s: Scratch, target: number): number[] {
  const out: number[] = [];
  for (let cur = target; cur !== -1; cur = s.parent[cur]!) out.push(cur);
  return out.reverse();
}

function blockedMask(grid: StoreyGrid, blockedPortalIds?: ReadonlySet<string>): Uint8Array | null {
  if (!blockedPortalIds?.size) return null;
  const mask = new Uint8Array(grid.portals.length);
  let any = false;
  grid.portals.forEach((p, i) => {
    if (blockedPortalIds.has(p.id)) {
      mask[i] = 1;
      any = true;
    }
  });
  return any ? mask : null;
}

function blockedRegionSet(grid: StoreyGrid, blockedSpaceIds?: ReadonlySet<string>): Set<number> | null {
  if (!blockedSpaceIds?.size) return null;
  const closed = new Set<number>();
  grid.regionIds.forEach((id, i) => {
    if (blockedSpaceIds.has(id)) closed.add(i);
  });
  return closed.size ? closed : null;
}

function stepBlock(grid: StoreyGrid, opts: GridRouteOpts = {}): StepBlock | null {
  const portals = blockedMask(grid, opts.blockedPortalIds);
  const regions = blockedRegionSet(grid, opts.blockedSpaceIds);
  if (!portals && !regions) return null;
  return { portals, regions };
}

function hazardCacheKey(opts: GridRouteOpts = {}): string {
  const p = opts.blockedPortalIds?.size ? [...opts.blockedPortalIds].sort().join("\0") : "";
  const s = opts.blockedSpaceIds?.size ? [...opts.blockedSpaceIds].sort().join("\0") : "";
  return s ? `${p}#s:${s}` : p;
}

/** Straight segment stays on steppable cells no closer to walls than `minClear`. */
function segmentClear(
  grid: StoreyGrid,
  a: Point2D,
  b: Point2D,
  minClear: number,
  block: StepBlock | null,
): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const samples = Math.max(1, Math.ceil(len / (grid.cell * 0.5)));
  let prev = cellAt(grid, a.x, a.y);
  if (prev < 0) return false;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const idx = cellAt(grid, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    if (idx === prev) continue;
    if (idx < 0 || grid.clear[idx]! < minClear) return false;
    const pc = prev % grid.cols;
    const pr = (prev - pc) / grid.cols;
    const ic = idx % grid.cols;
    const ir = (idx - ic) / grid.cols;
    if (Math.abs(pc - ic) > 1 || Math.abs(pr - ir) > 1) return false;
    if (!canStep(grid, prev, idx, block)) return false;
    if (pc !== ic && pr !== ir) {
      const o1 = pr * grid.cols + ic;
      const o2 = ir * grid.cols + pc;
      if (!canStep(grid, prev, o1, block) || !canStep(grid, o1, idx, block)) return false;
      if (!canStep(grid, prev, o2, block) || !canStep(grid, o2, idx, block)) return false;
    }
    prev = idx;
  }
  return true;
}

/** Straight chord may cost a bit more than the cell walk before we keep the wiggles. */
const SIMPLIFY_COST_TOLERANCE = 1.15;

/** Scrape-weighted length of the straight segment `a`→`b` (same weights as A*). */
function segmentScrapeCost(grid: StoreyGrid, a: Point2D, b: Point2D): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const samples = Math.max(1, Math.ceil(len / (grid.cell * 0.5)));
  let cost = 0;
  for (let i = 0; i < samples; i++) {
    const t = (i + 0.5) / samples;
    const idx = cellAt(grid, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    const pen = idx >= 0 ? stepPenalty(grid, idx) : 1 + WALL_PENALTY;
    cost += (len / samples) * pen;
  }
  return cost;
}

/** Scrape-weighted length of the cell walk from `lo` to `hi` inclusive. */
function cellsScrapeCost(grid: StoreyGrid, cells: number[], lo: number, hi: number): number {
  let cost = 0;
  for (let i = lo; i < hi; i++) {
    const a = cellCentre(grid, cells[i]!);
    const b = cellCentre(grid, cells[i + 1]!);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    cost +=
      len * 0.5 * (stepPenalty(grid, cells[i]!) + stepPenalty(grid, cells[i + 1]!));
  }
  return cost;
}

/** Biggest circular fillet on a string-pull corner (metres). */
const MAX_BEND_RADIUS_M = 2.2;
/** Ignore heading changes smaller than this — they are already "straight". */
const MIN_TURN_RAD = (18 * Math.PI) / 180;
/** Keep this much clearance after the fillet cuts toward the inner wall. */
const FILLET_CLEAR_KEEP_M = PULL_CLEAR_M;
/** Each corner may eat at most this fraction of the outgoing edge. */
const FILLET_EDGE_FRACTION = 0.42;

/** Fill `from`→`to` so the Catmull-Rom display tube cannot bow off the chord. */
function appendResampled(out: Point2D[], from: Point2D, to: Point2D, spacing: number): void {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(len / Math.max(spacing, 1e-6)));
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
}

/** Walk a pin toward higher clearance so taut corners sit ~PULL_CLEAR_M off the wall. */
function nudgeClear(grid: StoreyGrid, p: Point2D, block: StepBlock | null): Point2D {
  let idx = cellAt(grid, p.x, p.y);
  if (idx < 0) return p;
  for (let step = 0; step < 12; step++) {
    if (grid.clear[idx]! >= PULL_CLEAR_M) return cellCentre(grid, idx);
    let best = -1;
    let bestC = grid.clear[idx]!;
    const c = idx % grid.cols;
    const r = (idx - c) / grid.cols;
    for (let k = 0; k < 8; k++) {
      const nc = c + DC[k]!;
      const nr = r + DR[k]!;
      if (nc < 0 || nc >= grid.cols || nr < 0 || nr >= grid.rows) continue;
      const v = nr * grid.cols + nc;
      if (!canStep(grid, idx, v, block)) continue;
      if (grid.clear[v]! > bestC) {
        bestC = grid.clear[v]!;
        best = v;
      }
    }
    if (best < 0) break;
    idx = best;
  }
  return cellCentre(grid, idx);
}

function samplesWalkable(grid: StoreyGrid, samples: Point2D[], block: StepBlock | null): boolean {
  for (let i = 1; i < samples.length; i++) {
    if (!segmentClear(grid, samples[i - 1]!, samples[i]!, PULL_CLEAR_M, block)) return false;
  }
  return true;
}

/**
 * Circular fillet at `b` for the turn `a`→`b`→`c`, or null if the corner is
 * already shallow / too tight against a wall / not walkable.
 */
function cornerFillet(
  grid: StoreyGrid,
  block: StepBlock | null,
  a: Point2D,
  b: Point2D,
  c: Point2D,
  incomingLeft: number,
  outgoingLeft: number,
): { t1: Point2D; t2: Point2D; samples: Point2D[] } | null {
  const inx = b.x - a.x;
  const iny = b.y - a.y;
  const outx = c.x - b.x;
  const outy = c.y - b.y;
  const inLen = Math.hypot(inx, iny);
  const outLen = Math.hypot(outx, outy);
  if (inLen < 1e-6 || outLen < 1e-6) return null;
  const uix = inx / inLen;
  const uiy = iny / inLen;
  const uox = outx / outLen;
  const uoy = outy / outLen;
  const dot = Math.max(-1, Math.min(1, uix * uox + uiy * uoy));
  const delta = Math.acos(dot);
  if (delta < MIN_TURN_RAD || delta > Math.PI - 0.08) return null;
  const half = delta / 2;
  const tanHalf = Math.tan(half);
  const cosHalf = Math.cos(half);
  if (tanHalf < 1e-6 || cosHalf < 1e-6) return null;

  const idx = cellAt(grid, b.x, b.y);
  const clear = idx >= 0 ? grid.clear[idx]! : 0;
  const inset = 1 / cosHalf - 1;
  const rWall = inset > 1e-6 ? Math.max(0, clear - FILLET_CLEAR_KEEP_M) / inset : MAX_BEND_RADIUS_M;
  const maxL = Math.min(incomingLeft, outgoingLeft, inLen * FILLET_EDGE_FRACTION, outLen * FILLET_EDGE_FRACTION);
  let R = Math.min(MAX_BEND_RADIUS_M, rWall, maxL / tanHalf);
  if (R < grid.cell) return null;

  const build = (radius: number) => {
    const L = radius * tanHalf;
    const cross = uix * uoy - uiy * uox;
    const nx = cross >= 0 ? -uiy : uiy;
    const ny = cross >= 0 ? uix : -uix;
    const t1 = { x: b.x - uix * L, y: b.y - uiy * L };
    const t2 = { x: b.x + uox * L, y: b.y + uoy * L };
    const cx = t1.x + nx * radius;
    const cy = t1.y + ny * radius;
    let a1 = Math.atan2(t1.y - cy, t1.x - cx);
    const a2 = Math.atan2(t2.y - cy, t2.x - cx);
    let sweep = a2 - a1;
    if (cross >= 0) {
      while (sweep <= 0) sweep += Math.PI * 2;
      if (sweep > Math.PI + 1e-3) return null;
    } else {
      while (sweep >= 0) sweep -= Math.PI * 2;
      if (sweep < -Math.PI - 1e-3) return null;
    }
    const steps = Math.max(2, Math.ceil((Math.abs(sweep) * radius) / grid.cell));
    const samples: Point2D[] = [t1];
    for (let s = 1; s < steps; s++) {
      const ang = a1 + (sweep * s) / steps;
      samples.push({ x: cx + Math.cos(ang) * radius, y: cy + Math.sin(ang) * radius });
    }
    samples.push(t2);
    return { t1, t2, samples };
  };

  for (const radius of [R, R * 0.55]) {
    if (radius < grid.cell) break;
    const fillet = build(radius);
    if (fillet && samplesWalkable(grid, fillet.samples, block)) return fillet;
  }
  return null;
}

/**
 * Greedy string-pull: fewest straight runs that stay walkable and do not
 * raise scrape-weighted cost (same 1 m / 0.5 m / 0 m multipliers as A*).
 */
function stringPullCells(grid: StoreyGrid, cells: number[], block: StepBlock | null): Point2D[] {
  const pts = cells.map((c) => cellCentre(grid, c));
  if (pts.length <= 2) return pts;
  const out: Point2D[] = [pts[0]!];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1) {
      if (!segmentClear(grid, pts[i]!, pts[j]!, PULL_CLEAR_M, block)) {
        j--;
        continue;
      }
      const straight = segmentScrapeCost(grid, pts[i]!, pts[j]!);
      const raw = cellsScrapeCost(grid, cells, i, j);
      if (straight <= raw * SIMPLIFY_COST_TOLERANCE) break;
      j--;
    }
    out.push(pts[j]!);
    i = j;
  }
  if (out.length <= 2) return out;
  return [
    out[0]!,
    ...out.slice(1, -1).map((p) => nudgeClear(grid, p, block)),
    out[out.length - 1]!,
  ];
}

/**
 * Round string-pull corners with clearance-limited circular fillets, then
 * resample so Catmull-Rom cannot bow off the walkable line.
 */
function filletAndResample(grid: StoreyGrid, pts: Point2D[], block: StepBlock | null): Point2D[] {
  if (pts.length === 0) return pts;
  if (pts.length <= 2) {
    const out = [pts[0]!];
    if (pts[1]) appendResampled(out, pts[0]!, pts[1]!, grid.cell);
    return out;
  }
  const out: Point2D[] = [pts[0]!];
  let cursor = pts[0]!;
  for (let i = 1; i < pts.length - 1; i++) {
    const b = pts[i]!;
    const incomingLeft = Math.hypot(b.x - cursor.x, b.y - cursor.y);
    const outgoingLeft = Math.hypot(pts[i + 1]!.x - b.x, pts[i + 1]!.y - b.y);
    const fillet = cornerFillet(grid, block, pts[i - 1]!, b, pts[i + 1]!, incomingLeft, outgoingLeft);
    if (fillet && incomingLeft + 1e-6 >= Math.hypot(b.x - fillet.t1.x, b.y - fillet.t1.y)) {
      appendResampled(out, cursor, fillet.t1, grid.cell);
      for (let s = 1; s < fillet.samples.length; s++) out.push(fillet.samples[s]!);
      cursor = fillet.t2;
    } else {
      appendResampled(out, cursor, b, grid.cell);
      cursor = b;
    }
  }
  appendResampled(out, cursor, pts[pts.length - 1]!, grid.cell);
  return out;
}

function smoothCells(grid: StoreyGrid, cells: number[], block: StepBlock | null): Point2D[] {
  return filletAndResample(grid, stringPullCells(grid, cells, block), block);
}

function regionSequence(grid: StoreyGrid, cells: number[]): string[] {
  const out: string[] = [];
  for (const c of cells) {
    const r = grid.region[c]!;
    if (r < 0) continue;
    const id = grid.regionIds[r]!;
    if (out[out.length - 1] !== id) out.push(id);
  }
  return out;
}

/** Region indices reachable from `from` through open (unblocked) portals. */
function reachableRegions(grid: StoreyGrid, from: number, block: StepBlock | null): Set<number> {
  const closed = block?.regions;
  if (closed?.has(from)) return new Set([from]);
  const adj = new Map<number, number[]>();
  grid.portals.forEach((p, i) => {
    if (block?.portals?.[i] || p.b < 0) return;
    if (closed?.has(p.a) || closed?.has(p.b)) return;
    (adj.get(p.a) ?? adj.set(p.a, []).get(p.a)!).push(p.b);
    (adj.get(p.b) ?? adj.set(p.b, []).get(p.b)!).push(p.a);
  });
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    for (const next of adj.get(stack.pop()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
}

/** Grid cell for a pin: its own cell if it's in the right region, else the nearest one that is. */
function pinCell(
  grid: StoreyGrid,
  mesh: StoreyNavmesh,
  p: Point2D,
): { cell: number; region: number } | null {
  const region = regionAtPoint(mesh, p);
  if (!region) return null;
  const regionIdx = grid.regionIds.indexOf(region.spaceId);
  if (regionIdx < 0) return null;
  const own = cellAt(grid, p.x, p.y);
  if (own >= 0 && grid.region[own] === regionIdx) return { cell: own, region: regionIdx };
  const near = nearestRegionCell(grid, p, regionIdx, PIN_SNAP_M);
  return near >= 0 ? { cell: near, region: regionIdx } : null;
}

function withPins(points: Point2D[], start: Point2D, end: Point2D): Point2D[] {
  if (points.length < 2) return [start, end];
  return [start, ...points.slice(1, -1), end];
}

/** Click-to-click route on one storey: a single A* over the storey grid. */
export function findGridPath(
  grid: StoreyGrid,
  mesh: StoreyNavmesh,
  start: Point2D,
  end: Point2D,
  opts: GridRouteOpts = {},
): { found: boolean; points: Point2D[]; note: string; graphNodeIds: string[] } {
  const s = pinCell(grid, mesh, start);
  const t = pinCell(grid, mesh, end);
  if (!s || !t) {
    return { found: false, points: [], note: "Pick points inside walkable regions", graphNodeIds: [] };
  }
  const block = stepBlock(grid, opts);
  if (block?.regions?.has(s.region) || block?.regions?.has(t.region)) {
    return { found: false, points: [], note: "Region is blocked", graphNodeIds: [] };
  }
  if (s.region !== t.region && !reachableRegions(grid, s.region, block).has(t.region)) {
    return { found: false, points: [], note: "No portal path between regions", graphNodeIds: [] };
  }
  const goal = cellCentre(grid, t.cell);
  let reached = false;
  const sc = search(
    grid,
    s.cell,
    block,
    (idx) => {
      const p = cellCentre(grid, idx);
      return Math.hypot(p.x - goal.x, p.y - goal.y);
    },
    (idx) => (reached = idx === t.cell),
  );
  if (!reached) {
    return { found: false, points: [], note: "No walkable path", graphNodeIds: [] };
  }
  const cells = tracePath(sc, t.cell);
  const graphNodeIds = regionSequence(grid, cells);
  return {
    found: true,
    points: withPins(smoothCells(grid, cells, block), start, end),
    note: graphNodeIds.length > 1 ? `${graphNodeIds.length - 1} hops` : "Same-region path",
    graphNodeIds,
  };
}

/** Dijkstra from `start` to the nearest open exit portal on this storey. */
export function findGridNearestExitPath(
  grid: StoreyGrid,
  mesh: StoreyNavmesh,
  start: Point2D,
  opts: GridRouteOpts = {},
): { found: boolean; points: Point2D[]; note: string; exitPortalId?: string; graphNodeIds: string[] } {
  const s = pinCell(grid, mesh, start);
  if (!s) {
    return { found: false, points: [], note: "Pick a point inside a walkable region", graphNodeIds: [] };
  }
  const block = stepBlock(grid, opts);
  if (block?.regions?.has(s.region)) {
    return { found: false, points: [], note: "Region is blocked", graphNodeIds: [] };
  }
  const exitByCell = new Map<number, number>();
  grid.portals.forEach((p, i) => {
    if (p.kind !== "exit" || block?.portals?.[i] || p.cell < 0 || grid.region[p.cell] === BLOCKED) return;
    if (block?.regions?.has(p.a)) return;
    exitByCell.set(p.cell, i);
  });
  if (!exitByCell.size) {
    return { found: false, points: [], note: "No exit portal on this storey", graphNodeIds: [] };
  }
  let hit = -1;
  const sc = search(grid, s.cell, block, () => 0, (idx) => {
    if (!exitByCell.has(idx)) return false;
    hit = idx;
    return true;
  });
  if (hit < 0) {
    return { found: false, points: [], note: "No reachable exit", graphNodeIds: [] };
  }
  const exit = grid.portals[exitByCell.get(hit)!]!;
  const cells = tracePath(sc, hit);
  const graphNodeIds = regionSequence(grid, cells);
  return {
    found: true,
    points: withPins(smoothCells(grid, cells, block), start, exit.point),
    note: `${Math.max(graphNodeIds.length - 1, 0)} hops to exit`,
    exitPortalId: exit.id,
    graphNodeIds,
  };
}

// ---------------------------------------------------------------------------
// Multi-storey
// ---------------------------------------------------------------------------

type Reach = { cost: number; cells: number[] };

/** One Dijkstra from `source`, stopping once every target cell is settled. */
function reachTargets(
  grid: StoreyGrid,
  source: number,
  targets: readonly number[],
  block: StepBlock | null,
): Map<number, Reach> {
  const pending = new Set(targets.filter((t) => t >= 0 && t !== source));
  const out = new Map<number, Reach>();
  if (targets.includes(source)) out.set(source, { cost: 0, cells: [source] });
  if (!pending.size) return out;
  const settled: number[] = [];
  const sc = search(grid, source, block, () => 0, (idx) => {
    if (!pending.has(idx)) return false;
    pending.delete(idx);
    settled.push(idx);
    return pending.size === 0;
  });
  for (const t of settled) out.set(t, { cost: sc.g[t]!, cells: tracePath(sc, t) });
  return out;
}

/** Landing-to-landing reaches, reused across clicks while the grid and blocked set don't change. */
const landingReachCache = new WeakMap<StoreyGrid, Map<string, Map<number, Reach>>>();

function cachedLandingReach(
  grid: StoreyGrid,
  source: number,
  targets: readonly number[],
  block: StepBlock | null,
  blockedKey: string,
): Map<number, Reach> {
  let byKey = landingReachCache.get(grid);
  if (!byKey) {
    byKey = new Map();
    landingReachCache.set(grid, byKey);
  }
  const key = `${blockedKey}#${source}`;
  let hit = byKey.get(key);
  if (!hit) {
    hit = reachTargets(grid, source, targets, block);
    byKey.set(key, hit);
  }
  return hit;
}

type Landing = { key: string; linkId: string; storeyId: string; cell: number; point: Point2D };

function collectLandings(
  grids: readonly StoreyGrid[],
  graph: ConnectivityGraph,
  footprints: FootprintsDocument,
  opts: GridRouteOpts = {},
): {
  landings: Map<string, Landing>;
  landingsByStorey: Map<string, Landing[]>;
  verticalNext: Map<string, Landing[]>;
  elevations: ReadonlyMap<string, number>;
} {
  const gridById = new Map(grids.map((g) => [g.storeyId, g]));
  const landings = new Map<string, Landing>();
  const landingsByStorey = new Map<string, Landing[]>();
  const landingsByLink = new Map<string, Landing[]>();
  for (const [linkId, connectors] of buildVerticalConnectors(graph, footprints)) {
    for (const c of connectors) {
      const key = `${linkId}@${c.storeyId}`;
      if (opts.blockedConnectorIds?.has(key)) continue;
      if (opts.blockedSpaceIds?.has(c.spaceId)) continue;
      const grid = gridById.get(c.storeyId);
      if (!grid) continue;
      const regionIdx = grid.regionIds.indexOf(c.spaceId);
      if (regionIdx < 0) continue;
      const own = cellAt(grid, c.point.x, c.point.y);
      const cell =
        own >= 0 && grid.region[own] === regionIdx
          ? own
          : nearestRegionCell(grid, c.point, regionIdx, GATE_SEARCH_M * 5);
      if (cell < 0) continue;
      const landing: Landing = { key, linkId, storeyId: c.storeyId, cell, point: cellCentre(grid, cell) };
      landings.set(key, landing);
      (landingsByStorey.get(c.storeyId) ?? landingsByStorey.set(c.storeyId, []).get(c.storeyId)!).push(
        landing,
      );
      (landingsByLink.get(linkId) ?? landingsByLink.set(linkId, []).get(linkId)!).push(landing);
    }
  }
  const elevations = storeyElevationLookup(footprints);
  const verticalNext = new Map<string, Landing[]>();
  for (const list of landingsByLink.values()) {
    const sorted = [...list].sort(
      (a, b) => (elevations.get(a.storeyId) ?? 0) - (elevations.get(b.storeyId) ?? 0),
    );
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      (verticalNext.get(a.key) ?? verticalNext.set(a.key, []).get(a.key)!).push(b);
      (verticalNext.get(b.key) ?? verticalNext.set(b.key, []).get(b.key)!).push(a);
    }
  }
  return { landings, landingsByStorey, verticalNext, elevations };
}

/**
 * Cross-storey route: per-storey grid Dijkstras between pins and stair/lift
 * landings, joined by vertical hops costed by storey elevation difference.
 */
export function findGridMultiStoreyPath(
  grids: readonly StoreyGrid[],
  meshes: readonly StoreyNavmesh[],
  graph: ConnectivityGraph,
  footprints: FootprintsDocument,
  start: { storeyId: string; point: Point2D },
  end: { storeyId: string; point: Point2D },
  opts: GridRouteOpts = {},
): {
  found: boolean;
  note: string;
  segments: { storeyId: string; points: Point2D[] }[];
  graphNodeIds: string[];
} {
  const fail = (note: string) => ({ found: false, note, segments: [], graphNodeIds: [] });
  const gridById = new Map(grids.map((g) => [g.storeyId, g]));
  const meshById = new Map(meshes.map((m) => [m.storeyId, m]));
  const startGrid = gridById.get(start.storeyId);
  const endGrid = gridById.get(end.storeyId);
  const startMesh = meshById.get(start.storeyId);
  const endMesh = meshById.get(end.storeyId);
  if (!startGrid || !endGrid || !startMesh || !endMesh) return fail("Unknown storey");

  if (start.storeyId === end.storeyId) {
    const r = findGridPath(startGrid, startMesh, start.point, end.point, opts);
    return {
      found: r.found,
      note: r.note,
      segments: r.found ? [{ storeyId: start.storeyId, points: r.points }] : [],
      graphNodeIds: r.graphNodeIds,
    };
  }

  const s = pinCell(startGrid, startMesh, start.point);
  const t = pinCell(endGrid, endMesh, end.point);
  if (!s || !t) return fail("Pick points inside walkable regions");
  if (stepBlock(startGrid, opts)?.regions?.has(s.region) || stepBlock(endGrid, opts)?.regions?.has(t.region)) {
    return fail("Region is blocked");
  }

  const { landings, landingsByStorey, verticalNext, elevations } = collectLandings(
    grids,
    graph,
    footprints,
    opts,
  );

  const blockedByStorey = new Map<string, StepBlock | null>();
  const blockedFor = (grid: StoreyGrid) => {
    if (!blockedByStorey.has(grid.storeyId)) {
      blockedByStorey.set(grid.storeyId, stepBlock(grid, opts));
    }
    return blockedByStorey.get(grid.storeyId)!;
  };
  const blockedKey = hazardCacheKey(opts);

  const startLandingCells = (landingsByStorey.get(start.storeyId) ?? []).map((l) => l.cell);
  const endLandingCells = (landingsByStorey.get(end.storeyId) ?? []).map((l) => l.cell);
  const fromStart = reachTargets(startGrid, s.cell, startLandingCells, blockedFor(startGrid));
  const toEnd = reachTargets(endGrid, t.cell, endLandingCells, blockedFor(endGrid));

  // Small Dijkstra over pins + landings. Edge kinds: walk on one storey (cells kept for the drawing) or vertical hop.
  type Step = { prev: string; storeyId: string | null; cells: number[] | null; reversed: boolean };
  const best = new Map<string, number>([["__start", 0]]);
  const came = new Map<string, Step>();
  const done = new Set<string>();
  const heap = new IndexHeap();
  const keys: string[] = ["__start"];
  const keyIndex = new Map<string, number>([["__start", 0]]);
  const idxOf = (key: string) => {
    let i = keyIndex.get(key);
    if (i == null) {
      i = keys.length;
      keys.push(key);
      keyIndex.set(key, i);
    }
    return i;
  };
  const relax = (from: string, to: string, cost: number, step: Omit<Step, "prev">) => {
    const g = best.get(from)! + cost;
    if (g >= (best.get(to) ?? Infinity)) return;
    best.set(to, g);
    came.set(to, { prev: from, ...step });
    heap.push(g, idxOf(to));
  };

  heap.push(0, 0);
  let found = false;
  while (heap.size) {
    const key = keys[heap.pop()]!;
    if (done.has(key)) continue;
    done.add(key);
    if (key === "__end") {
      found = true;
      break;
    }
    if (key === "__start") {
      for (const l of landingsByStorey.get(start.storeyId) ?? []) {
        const r = fromStart.get(l.cell);
        if (r) relax(key, l.key, r.cost, { storeyId: start.storeyId, cells: r.cells, reversed: false });
      }
      continue;
    }
    const landing = landings.get(key)!;
    for (const next of verticalNext.get(key) ?? []) {
      relax(key, next.key, verticalHopCost(elevations, landing.storeyId, next.storeyId), {
        storeyId: null,
        cells: null,
        reversed: false,
      });
    }
    const grid = gridById.get(landing.storeyId)!;
    if (landing.storeyId === end.storeyId) {
      const r = toEnd.get(landing.cell);
      if (r) relax(key, "__end", r.cost, { storeyId: end.storeyId, cells: r.cells, reversed: true });
    }
    const peers = (landingsByStorey.get(landing.storeyId) ?? []).filter((l) => l.key !== key);
    if (peers.length) {
      const reach = cachedLandingReach(
        grid,
        landing.cell,
        peers.map((l) => l.cell),
        blockedFor(grid),
        blockedKey,
      );
      for (const peer of peers) {
        const r = reach.get(peer.cell);
        if (r) relax(key, peer.key, r.cost, { storeyId: landing.storeyId, cells: r.cells, reversed: false });
      }
    }
  }
  if (!found) return fail("No multi-storey path found");

  const chain: { key: string; step: Step }[] = [];
  for (let cur = "__end"; cur !== "__start"; ) {
    const step = came.get(cur)!;
    chain.push({ key: cur, step });
    cur = step.prev;
  }
  chain.reverse();

  const segments: { storeyId: string; points: Point2D[] }[] = [];
  const graphNodeIds: string[] = [];
  const pushNode = (id: string) => {
    if (graphNodeIds[graphNodeIds.length - 1] !== id) graphNodeIds.push(id);
  };
  for (const { key, step } of chain) {
    if (step.storeyId == null) {
      pushNode(landings.get(key)!.linkId);
      continue;
    }
    const grid = gridById.get(step.storeyId)!;
    const cells = step.reversed ? [...step.cells!].reverse() : step.cells!;
    let pts = smoothCells(grid, cells, blockedFor(grid));
    if (step.prev === "__start") pts = [start.point, ...pts.slice(1)];
    if (key === "__end") pts = [...pts.slice(0, -1), end.point];
    for (const id of regionSequence(grid, cells)) pushNode(id);
    const last = segments[segments.length - 1];
    if (last && last.storeyId === step.storeyId) last.points.push(...pts.slice(1));
    else segments.push({ storeyId: step.storeyId, points: pts });
  }

  return {
    found: segments.length > 0,
    note: `${chain.length} hops across ${new Set(segments.map((x) => x.storeyId)).size} storeys`,
    segments,
    graphNodeIds,
  };
}

type GridExit = { key: string; storeyId: string; cell: number; point: Point2D; portalId: string };

/**
 * Nearest exterior exit from `start`, any storey. Same-floor exits still win
 * when they're cheaper; otherwise the search walks stairs/lifts like
 * {@link findGridMultiStoreyPath}.
 */
export function findGridNearestExitPathBuilding(
  grids: readonly StoreyGrid[],
  meshes: readonly StoreyNavmesh[],
  graph: ConnectivityGraph,
  footprints: FootprintsDocument,
  start: { storeyId: string; point: Point2D },
  opts: GridRouteOpts = {},
): {
  found: boolean;
  note: string;
  segments: { storeyId: string; points: Point2D[] }[];
  graphNodeIds: string[];
  exitPortalId?: string;
  end: Point2D | null;
  endStoreyId: string | null;
} {
  const fail = (note: string) => ({
    found: false,
    note,
    segments: [],
    graphNodeIds: [],
    end: null,
    endStoreyId: null,
  });
  const gridById = new Map(grids.map((g) => [g.storeyId, g]));
  const meshById = new Map(meshes.map((m) => [m.storeyId, m]));
  const startGrid = gridById.get(start.storeyId);
  const startMesh = meshById.get(start.storeyId);
  if (!startGrid || !startMesh) return fail("Unknown storey");

  const s = pinCell(startGrid, startMesh, start.point);
  if (!s) return fail("Pick a point inside a walkable region");
  if (stepBlock(startGrid, opts)?.regions?.has(s.region)) return fail("Region is blocked");

  const blockedByStorey = new Map<string, StepBlock | null>();
  const blockedFor = (grid: StoreyGrid) => {
    if (!blockedByStorey.has(grid.storeyId)) {
      blockedByStorey.set(grid.storeyId, stepBlock(grid, opts));
    }
    return blockedByStorey.get(grid.storeyId)!;
  };
  const blockedKey = hazardCacheKey(opts);

  const exitsByStorey = new Map<string, GridExit[]>();
  for (const grid of grids) {
    const block = blockedFor(grid);
    const list: GridExit[] = [];
    grid.portals.forEach((p, i) => {
      if (p.kind !== "exit" || block?.portals?.[i]) return;
      if (p.cell < 0 || grid.region[p.cell] === BLOCKED) return;
      if (block?.regions?.has(p.a)) return;
      list.push({
        key: `__exit:${p.id}`,
        storeyId: grid.storeyId,
        cell: p.cell,
        point: p.point,
        portalId: p.id,
      });
    });
    if (list.length) exitsByStorey.set(grid.storeyId, list);
  }
  if (![...exitsByStorey.values()].some((list) => list.length)) {
    return fail("No exit portal in the building");
  }

  const { landings, landingsByStorey, verticalNext, elevations } = collectLandings(
    grids,
    graph,
    footprints,
    opts,
  );

  type Step = { prev: string; storeyId: string | null; cells: number[] | null; reversed: boolean };
  const best = new Map<string, number>([["__start", 0]]);
  const came = new Map<string, Step>();
  const done = new Set<string>();
  const heap = new IndexHeap();
  const keys: string[] = ["__start"];
  const keyIndex = new Map<string, number>([["__start", 0]]);
  const idxOf = (key: string) => {
    let i = keyIndex.get(key);
    if (i == null) {
      i = keys.length;
      keys.push(key);
      keyIndex.set(key, i);
    }
    return i;
  };
  const relax = (from: string, to: string, cost: number, step: Omit<Step, "prev">) => {
    const g = best.get(from)! + cost;
    if (g >= (best.get(to) ?? Infinity)) return;
    best.set(to, g);
    came.set(to, { prev: from, ...step });
    heap.push(g, idxOf(to));
  };

  const walkToExits = (fromKey: string, storeyId: string, sourceCell: number) => {
    const grid = gridById.get(storeyId);
    const exits = exitsByStorey.get(storeyId);
    if (!grid || !exits?.length) return;
    const reach = reachTargets(
      grid,
      sourceCell,
      exits.map((e) => e.cell),
      blockedFor(grid),
    );
    for (const exit of exits) {
      const r = reach.get(exit.cell);
      if (r) relax(fromKey, exit.key, r.cost, { storeyId, cells: r.cells, reversed: false });
    }
  };

  heap.push(0, 0);
  let hitExit: GridExit | null = null;
  const exitByKey = new Map<string, GridExit>();
  for (const list of exitsByStorey.values()) for (const e of list) exitByKey.set(e.key, e);

  while (heap.size) {
    const key = keys[heap.pop()]!;
    if (done.has(key)) continue;
    done.add(key);
    const exit = exitByKey.get(key);
    if (exit) {
      hitExit = exit;
      break;
    }
    if (key === "__start") {
      walkToExits(key, start.storeyId, s.cell);
      const fromStart = reachTargets(
        startGrid,
        s.cell,
        (landingsByStorey.get(start.storeyId) ?? []).map((l) => l.cell),
        blockedFor(startGrid),
      );
      for (const l of landingsByStorey.get(start.storeyId) ?? []) {
        const r = fromStart.get(l.cell);
        if (r) relax(key, l.key, r.cost, { storeyId: start.storeyId, cells: r.cells, reversed: false });
      }
      continue;
    }
    const landing = landings.get(key);
    if (!landing) continue;
    for (const next of verticalNext.get(key) ?? []) {
      relax(key, next.key, verticalHopCost(elevations, landing.storeyId, next.storeyId), {
        storeyId: null,
        cells: null,
        reversed: false,
      });
    }
    walkToExits(key, landing.storeyId, landing.cell);
    const peers = (landingsByStorey.get(landing.storeyId) ?? []).filter((l) => l.key !== key);
    if (peers.length) {
      const grid = gridById.get(landing.storeyId)!;
      const reach = cachedLandingReach(
        grid,
        landing.cell,
        peers.map((l) => l.cell),
        blockedFor(grid),
        blockedKey,
      );
      for (const peer of peers) {
        const r = reach.get(peer.cell);
        if (r) relax(key, peer.key, r.cost, { storeyId: landing.storeyId, cells: r.cells, reversed: false });
      }
    }
  }
  if (!hitExit) return fail("No reachable exit");

  const chain: { key: string; step: Step }[] = [];
  for (let cur = hitExit.key; cur !== "__start"; ) {
    const step = came.get(cur)!;
    chain.push({ key: cur, step });
    cur = step.prev;
  }
  chain.reverse();

  const segments: { storeyId: string; points: Point2D[] }[] = [];
  const graphNodeIds: string[] = [];
  const pushNode = (id: string) => {
    if (graphNodeIds[graphNodeIds.length - 1] !== id) graphNodeIds.push(id);
  };
  for (const { key, step } of chain) {
    if (step.storeyId == null) {
      pushNode(landings.get(key)!.linkId);
      continue;
    }
    const grid = gridById.get(step.storeyId)!;
    const cells = step.cells!;
    let pts = smoothCells(grid, cells, blockedFor(grid));
    if (step.prev === "__start") pts = [start.point, ...pts.slice(1)];
    if (exitByKey.has(key)) pts = [...pts.slice(0, -1), hitExit.point];
    for (const id of regionSequence(grid, cells)) pushNode(id);
    const last = segments[segments.length - 1];
    if (last && last.storeyId === step.storeyId) last.points.push(...pts.slice(1));
    else segments.push({ storeyId: step.storeyId, points: pts });
  }

  const storeyCount = new Set(segments.map((x) => x.storeyId)).size;
  return {
    found: segments.length > 0,
    note:
      storeyCount > 1
        ? `${chain.length} hops to exit across ${storeyCount} storeys`
        : `${Math.max(graphNodeIds.length - 1, 0)} hops to exit`,
    segments,
    graphNodeIds,
    exitPortalId: hitExit.portalId,
    end: hitExit.point,
    endStoreyId: hitExit.storeyId,
  };
}
