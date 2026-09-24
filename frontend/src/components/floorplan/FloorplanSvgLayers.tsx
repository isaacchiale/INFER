import { memo, useId, useMemo } from "react";
import { buildDoorGlyph } from "@/lib/door-symbol";
import { renderEvacuationHeatTextureDataUrl, type HeatSample } from "@/lib/evacuation-heat-texture";
import { smoothPolylinePathD, type Point2 } from "@/lib/floorplan-camera";
import type {
  DoorPortal,
  FurnitureFootprint,
  SpaceFootprint,
  StairFootprint,
  WallFootprint,
} from "@/types/footprints";
import type { EvacuationLoadResult, NavmeshPortal, NavmeshRegion, StoreyNavmesh } from "@/lib/navmesh";

/**
 * Navmesh portal kind colours — Okabe–Ito roles via `styles.css` tokens.
 * Blue is reserved for routes; IFC doors are orange; space heal is green.
 */
export const PORTAL_COLORS = {
  door: "var(--portal-door)", // muted amber — IFC door
  doorHeal: "var(--portal-door-heal)", // pink — door heal
  spacePortal: "var(--portal-space)", // green — space heal
  exit: "var(--hazard)", // red — same "danger" token the rest of the app uses
  blocked: "var(--portal-blocked)", // gray
} as const;

/**
 * Sequential heat scale for the evacuation-load overlay — the familiar
 * traffic-light progression (green -> yellow/orange -> red -> a genuinely
 * dark red), not a single hue varying only in lightness/chroma. A one-hue
 * scale was tried first specifically to dodge the classic red/green
 * colorblind-confusable pair (see PORTAL_COLORS' comment for that pair
 * elsewhere in this file) and to avoid green misleadingly reading as
 * "safe" on a scale with no safe state — but in practice, shades of one
 * color were too hard to tell apart at a glance, which defeats the point
 * of a heatmap. Reverted to multi-hue; the CVD risk is mitigated by every
 * stop also changing lightness (not hue alone) and by the exact
 * distance/load number always being one hover or one look at the "Worst
 * bottlenecks" panel away, never color-only. --warning and --hazard are
 * reused directly (not duplicated) as the middle/high anchors, so this
 * scale's meaning always matches those tokens' meaning elsewhere in the
 * app.
 */
const EVACUATION_HEAT_STOPS: [number, string][] = [
  [0, "var(--evac-heat-low)"],
  [0.33, "var(--warning)"],
  [0.66, "var(--hazard)"],
  [1, "var(--evac-heat-max)"],
];

export function evacuationHeatColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  let lo = EVACUATION_HEAT_STOPS[0]!;
  let hi = EVACUATION_HEAT_STOPS[EVACUATION_HEAT_STOPS.length - 1]!;
  for (let i = 0; i < EVACUATION_HEAT_STOPS.length - 1; i++) {
    const a = EVACUATION_HEAT_STOPS[i]!;
    const b = EVACUATION_HEAT_STOPS[i + 1]!;
    if (clamped >= a[0] && clamped <= b[0]) {
      lo = a;
      hi = b;
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const localT = (clamped - lo[0]) / span;
  const hiPct = Math.round(localT * 100);
  // Native browser-side OKLCH blend between the two active token stops —
  // no manual RGB math, and it stays in sync if either token is retuned.
  return `color-mix(in oklch, ${hi[1]} ${hiPct}%, ${lo[1]})`;
}

/** Fixed regardless of theme, like doors' amber — furniture obstacles need
 * to read distinctly from both wall poché shades (light and dark). */
const FURNITURE_FILL = "var(--furniture-fill)"; // teal
const FURNITURE_STROKE = "var(--furniture-stroke)"; // teal, darker

/** Typical tread depth (metres) — world-space, same units as the footprint geometry. */
const STAIR_TREAD_SPACING_M = 0.28;

export type FloorplanPalette = {
  wall: string;
  wallStroke: string;
  label: string;
  canvasBg: string;
};

export type PlanLayer = "spaces" | "walls" | "doors" | "stairs" | "furniture" | "route";

function polygonPathD(polygon: Point2[]): string {
  return polygon.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ") + " Z";
}

/** Exterior + holes as one SVG path (evenodd voids). */
function spacePathD(exterior: Point2[], holes?: Point2[][]): string {
  let d = polygonPathD(exterior);
  for (const hole of holes ?? []) {
    if (hole.length >= 3) d += " " + polygonPathD(hole);
  }
  return d;
}

function polygonCentroid(polygon: Point2[]): Point2 {
  let x = 0;
  let y = 0;
  for (const p of polygon) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(polygon.length, 1);
  return { x: x / n, y: y / n };
}

/** Shoelace area — a rough size estimate for the evacuation heatmap's blob
 * radius (see evacuationHeatTexture below), not a measurement anyone reads
 * directly, so holes/precision don't matter here the way they would for
 * the real footprint pipeline. */
function polygonAreaForBlobSizing(polygon: Point2[]): number {
  if (polygon.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Scale a polygon about its own centroid — used to pad a door's thin hull
 * so it fully erases the wall stroke it's meant to punch a gap through. */
function scalePolygon(polygon: Point2[], factor: number): Point2[] {
  const c = polygonCentroid(polygon);
  return polygon.map((p) => ({
    x: c.x + (p.x - c.x) * factor,
    y: c.y + (p.y - c.y) * factor,
  }));
}

/**
 * Evenly-spaced tread lines across a stair's plan footprint, perpendicular
 * to its longer (run) axis — the standard plan symbol, approximated from
 * the footprint's own geometry since there's no per-tread data to draw from.
 *
 * Uses the polygon's principal axes (not an axis-aligned bbox) so a rotated
 * stair gets treads across its true run. Callers should still clip to the
 * polygon: the OBB can slightly overshoot a non-rectangular footprint.
 */
function stairTreadLinesD(polygon: Point2[], treadSpacing: number): string {
  if (polygon.length < 3) return "";
  let cx = 0;
  let cy = 0;
  for (const p of polygon) {
    cx += p.x;
    cy += p.y;
  }
  cx /= polygon.length;
  cy /= polygon.length;

  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const p of polygon) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  // Largest-eigenvalue eigenvector of the 2×2 covariance — major (run) axis.
  const det = Math.sqrt(Math.max(0, (xx - yy) * (xx - yy) + 4 * xy * xy));
  let ux = 2 * xy;
  let uy = yy - xx + det;
  if (Math.abs(ux) + Math.abs(uy) < 1e-12) {
    ux = 1;
    uy = 0;
  }
  const ul = Math.hypot(ux, uy) || 1;
  ux /= ul;
  uy /= ul;
  // Minor (across-tread) axis.
  const vx = -uy;
  const vy = ux;

  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of polygon) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const u = dx * ux + dy * uy;
    const v = dx * vx + dy * vy;
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  const run = uMax - uMin;
  const across = vMax - vMin;
  if (run < 1e-6 || across < 1e-6) return "";

  const segments: string[] = [];
  // Treads run perpendicular to the longer axis (along the flight).
  if (run >= across) {
    const count = Math.max(2, Math.round(run / treadSpacing));
    for (let i = 1; i < count; i++) {
      const u = uMin + (run * i) / count;
      const x0 = cx + ux * u + vx * vMin;
      const y0 = cy + uy * u + vy * vMin;
      const x1 = cx + ux * u + vx * vMax;
      const y1 = cy + uy * u + vy * vMax;
      segments.push(`M${x0} ${y0} L${x1} ${y1}`);
    }
  } else {
    const count = Math.max(2, Math.round(across / treadSpacing));
    for (let i = 1; i < count; i++) {
      const v = vMin + (across * i) / count;
      const x0 = cx + ux * uMin + vx * v;
      const y0 = cy + uy * uMin + vy * v;
      const x1 = cx + ux * uMax + vx * v;
      const y1 = cy + uy * uMax + vy * v;
      segments.push(`M${x0} ${y0} L${x1} ${y1}`);
    }
  }
  return segments.join(" ");
}

/**
 * Google-Maps-style location pin (tip at 0,0; body in −Y for screen-up after
 * counter-flip). Classic teardrop + white disc.
 */
function mapPinPath(scale: number): string {
  const s = scale;
  // Tip → bulb: cubic teardrop matching Material / Maps proportions.
  return [
    `M 0 0`,
    `C ${-0.28 * s} ${-0.42 * s} ${-0.52 * s} ${-0.95 * s} ${-0.52 * s} ${-1.35 * s}`,
    `C ${-0.52 * s} ${-1.72 * s} ${-0.29 * s} ${-2.0 * s} 0 ${-2.0 * s}`,
    `C ${0.29 * s} ${-2.0 * s} ${0.52 * s} ${-1.72 * s} ${0.52 * s} ${-1.35 * s}`,
    `C ${0.52 * s} ${-0.95 * s} ${0.28 * s} ${-0.42 * s} 0 0`,
    `Z`,
  ].join(" ");
}

export function MapPin({
  x,
  y,
  scale,
  strokeW,
  label,
  color = "var(--route-normal)",
}: {
  x: number;
  y: number;
  scale: number;
  strokeW: number;
  label: string;
  color?: string;
}) {
  const discY = -scale * 1.35;
  const discR = scale * 0.28;
  // Outer translate stays in world XY; inner scale is rewritten by applyCameraDom
  // to 1/zoom (and Y-flip) so the pin stays constant on screen while zooming.
  return (
    <g transform={`translate(${x} ${y})`} className="infer-screen-fixed">
      <g className="infer-screen-fixed-scale" data-yflip="1" transform="scale(1,-1)">
        <ellipse
          cx={0}
          cy={scale * 0.06}
          rx={scale * 0.22}
          ry={scale * 0.08}
          fill="rgba(15,23,42,0.28)"
        />
        <path
          d={mapPinPath(scale)}
          fill={color}
          stroke="#ffffff"
          strokeWidth={strokeW}
          strokeLinejoin="round"
        >
          <title>{label}</title>
        </path>
        <circle cx={0} cy={discY} r={discR} fill="#ffffff" />
        <circle cx={0} cy={discY} r={discR * 0.45} fill={color} />
      </g>
    </g>
  );
}

export type FloorplanSvgLayersProps = {
  planDisplayMode: "ifc" | "navmesh";
  layers: Record<PlanLayer, boolean>;
  walls: WallFootprint[];
  furniture: FurnitureFootprint[];
  spaces: SpaceFootprint[];
  /** Node ids ("space:<gid>", "door:<gid>", ...) currently excluded from the model. */
  excludedNodeIds: ReadonlySet<string>;
  stairs: StairFootprint[];
  doors: DoorPortal[];
  storeyNavmesh: StoreyNavmesh | null;
  pathPoints: Point2[];
  navmeshStart: Point2 | null;
  navmeshEnd: Point2 | null;
  isExitRoute: boolean;
  blockedPortalIds: Set<string>;
  /** Evacuation-bottleneck overlay. When set, room fills and stairNodes (stairs aren't part of storeyNavmesh.portals at all) render via the continuous heatmap texture — see evacuationHeatTexture. Portal/stair markers themselves always keep their plain kind color/size. Null/omitted leaves the normal navmesh look with no heatmap. */
  evacuationLoad?: EvacuationLoadResult | null;
  doorsByGlobalId: Map<string, DoorPortal>;
  palette: FloorplanPalette;
  selectedSpaces: SpaceFootprint[];
  /** Portal ids currently in graph/floorplan selection (blue outline). */
  selectedPortalIds: ReadonlySet<string>;
  roomStroke: number;
  markerBase: number;
  doorR: number;
  doorStroke: number;
  doorGlyphStroke: number;
  portalR: number;
  pinScale: number;
  routeHalo: number;
  routeStroke: number;
  selectedStroke: number;
};

/**
 * Everything on the plan except the camera dot and miss-pick flash, which
 * FloorplanViewer renders directly in its own JSX instead of through here.
 * `viewerCameraPose` (and therefore the camera dot) updates up to 20 Hz
 * during Fly navigation and would re-render this component too if it were
 * a prop — since none of the props above change on those ticks, wrapping
 * this in memo() means a camera-pose-only re-render of FloorplanViewer
 * skips re-running every wall/space/door/stair/navmesh-region/portal/
 * selection `.map()` here entirely.
 */
function FloorplanSvgLayersImpl({
  planDisplayMode,
  layers,
  walls,
  furniture,
  spaces,
  excludedNodeIds,
  stairs,
  doors,
  storeyNavmesh,
  pathPoints,
  navmeshStart,
  navmeshEnd,
  isExitRoute,
  blockedPortalIds,
  evacuationLoad,
  doorsByGlobalId,
  palette,
  selectedSpaces,
  selectedPortalIds,
  roomStroke,
  markerBase,
  doorR,
  doorStroke,
  doorGlyphStroke,
  portalR,
  pinScale,
  routeHalo,
  routeStroke,
  selectedStroke,
}: FloorplanSvgLayersProps) {
  // Scoped so two mounted instances (however unlikely today) never collide
  // on the same clipPath id — url(#id) resolves to the first DOM match.
  // useId()'s colons are valid in a url(#...) fragment reference, but
  // stripped anyway to sidestep any doubt rather than rely on that.
  const heatClipId = `evac-heat-clip-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const stairClipPrefix = `stair-tread-clip-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const routeD = smoothPolylinePathD(pathPoints);
  const portalLoad = evacuationLoad?.portalLoad ?? null;
  const stairNodes = evacuationLoad?.stairNodes ?? [];
  const regionDistanceToExit = evacuationLoad?.regionDistanceToExit ?? null;
  const unreachableSpaceIds = evacuationLoad?.unreachableSpaceIds ?? null;
  const unreachableSet = unreachableSpaceIds ? new Set(unreachableSpaceIds) : null;

  // Continuous heatmap texture, combining two distinct signals into one
  // field instead of showing the second (door/stair traffic) as separate
  // glowing dot markers on top:
  //  - room samples (centroid + vertices, so the blob roughly follows each
  //    room's real footprint instead of reading as one circle per room) at
  //    that room's own distance-to-exit heat (unreachable = hottest);
  //  - a sample at every portal/stair point, at that node's own share of
  //    evacuation traffic — so a heavily-congested door reads as a dark red
  //    hot pocket bleeding into its surrounding room, "the high-traffic
  //    road", the same way a WiFi survey heatmap shows a dead zone as a
  //    patch of the field rather than a separate marker glued on top.
  // Each signal is normalized against its own max independently (a busy
  // door can hit full intensity even in a building where no room happens to
  // be far from an exit, and vice versa) — see evacuation-heat-texture.ts
  // for the render technique and why a flat per-polygon fill doesn't read
  // as a real heatmap. Recomputed only when the load data, the regions, or
  // the theme (via `palette`, itself a function of theme) actually change,
  // not on every pan/zoom-only re-render.
  const evacuationHeatTexture = useMemo(() => {
    if (!storeyNavmesh || !evacuationLoad) return null;
    const distMap = evacuationLoad.regionDistanceToExit;
    const unreachableIds = evacuationLoad.unreachableSpaceIds;
    const loadMap = evacuationLoad.portalLoad;
    const hasRoomData = !!(distMap && distMap.size) || !!(unreachableIds && unreachableIds.length);
    const hasTrafficData = !!(loadMap && loadMap.size);
    if (!hasRoomData && !hasTrafficData) return null;

    let maxDist = 0;
    if (distMap) for (const v of distMap.values()) if (v > maxDist) maxDist = v;
    const unreachable = unreachableIds ? new Set(unreachableIds) : null;
    let maxLoad = 0;
    if (loadMap) for (const v of loadMap.values()) if (v > maxLoad) maxLoad = v;

    const samples: HeatSample[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const addSample = (x: number, y: number, value: number) => {
      samples.push({ x, y, value });
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };

    for (const r of storeyNavmesh.regions) {
      const isUnreachable = unreachable?.has(r.spaceId) ?? false;
      const distance = distMap?.get(r.spaceId);
      if (!isUnreachable && distance == null) continue;
      const value = isUnreachable ? 1 : maxDist > 0 ? distance! / maxDist : 0;
      for (const p of [polygonCentroid(r.polygon), ...r.polygon]) addSample(p.x, p.y, value);
    }
    if (maxLoad > 0) {
      for (const p of storeyNavmesh.portals) {
        const load = loadMap?.get(p.id) ?? 0;
        if (load > 0) addSample(p.point.x, p.point.y, load / maxLoad);
      }
      for (const s of evacuationLoad.stairNodes) {
        const load = loadMap?.get(s.id) ?? 0;
        if (load > 0) addSample(s.point.x, s.point.y, load / maxLoad);
      }
    }
    if (samples.length === 0 || !Number.isFinite(minX)) return null;

    const bounds = { minX, minY, maxX, maxY };
    // Blob radius sized off a *typical room's* footprint (median sqrt-area
    // across this storey's regions), not the overall bounding-box span —
    // a long, thin building (a 100m corridor wing 5m wide, say) has a huge
    // span but the same small rooms as any other building, and sizing off
    // span alone would give a blob more than double the corridor's own
    // width, blurring away every room-to-room distinction along its length
    // instead of just smoothing within/between adjacent rooms. Clamped so
    // one huge open room (a warehouse floor) doesn't blow the radius out
    // either.
    const roomSpans = storeyNavmesh.regions
      .map((r) => Math.sqrt(polygonAreaForBlobSizing(r.polygon)))
      .filter((s) => s > 0)
      .sort((a, b) => a - b);
    const medianRoomSpan = roomSpans.length ? roomSpans[Math.floor(roomSpans.length / 2)]! : 4;
    const blobRadius = Math.max(1.5, Math.min(medianRoomSpan * 0.4, 8));
    const dataUrl = renderEvacuationHeatTextureDataUrl(samples, bounds, { blobRadius });
    return dataUrl ? { dataUrl, bounds } : null;
  }, [storeyNavmesh, evacuationLoad, palette]);

  return (
    <>
      {planDisplayMode === "ifc" ? (
        <>
          {layers.walls
            ? walls.map((w) => (
                <path
                  key={`wall:${w.global_id}`}
                  d={polygonPathD(w.polygon)}
                  fill={palette.wall}
                  stroke={palette.wallStroke}
                  strokeWidth={roomStroke}
                >
                  <title>{w.name ? `Wall: ${w.name}` : "Wall"}</title>
                </path>
              ))
            : null}
          {layers.walls && layers.doors
            ? doors.map((d) => {
                // Punches a visual gap in the wall poché at each door
                // opening — walls are a convex hull with no real
                // subtraction, so this just paints the canvas colour back
                // over the wall line where the doorway actually is.
                if (!d.polygon || d.polygon.length < 3) return null;
                return (
                  <path
                    key={`wallgap:${d.global_id}`}
                    d={polygonPathD(scalePolygon(d.polygon, 1.6))}
                    fill={palette.canvasBg}
                    stroke="none"
                  />
                );
              })
            : null}
          {layers.spaces
            ? spaces.map((s) => {
                const c = polygonCentroid(s.polygon);
                const excluded = excludedNodeIds.has(`space:${s.global_id}`);
                return (
                  <g key={s.global_id}>
                    <path
                      d={spacePathD(s.polygon, s.holes)}
                      fill={excluded ? "rgba(148,163,184,0.12)" : "rgba(148,163,184,0.35)"}
                      fillRule="evenodd"
                      stroke="#64748b"
                      strokeWidth={roomStroke}
                      strokeDasharray={excluded ? `${roomStroke * 3} ${roomStroke * 2}` : undefined}
                      opacity={excluded ? 0.6 : 1}
                    >
                      <title>
                        {(s.name || s.global_id) +
                          (excluded ? " (excluded — right-click to restore)" : "")}
                      </title>
                    </path>
                    {s.name ? (
                      <g transform={`translate(${c.x} ${c.y})`}>
                        <text
                          transform="scale(1,-1)"
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fontSize={markerBase * 0.013}
                          fill={palette.label}
                          opacity={0.85}
                          className="pointer-events-none select-none"
                        >
                          {s.name}
                        </text>
                      </g>
                    ) : null}
                  </g>
                );
              })
            : null}
          {layers.stairs
            ? stairs.map((s) => {
                const clipId = `${stairClipPrefix}-${s.global_id}`;
                return (
                  <g key={`stair:${s.global_id}`}>
                    <defs>
                      <clipPath id={clipId}>
                        <path d={polygonPathD(s.polygon)} />
                      </clipPath>
                    </defs>
                    <path
                      d={polygonPathD(s.polygon)}
                      fill="none"
                      stroke="var(--stair-glyph)"
                      strokeWidth={roomStroke * 1.4}
                    >
                      <title>{s.name ? `Stair: ${s.name}` : "Stair"}</title>
                    </path>
                    <path
                      d={stairTreadLinesD(s.polygon, STAIR_TREAD_SPACING_M)}
                      fill="none"
                      stroke="var(--stair-glyph)"
                      strokeWidth={roomStroke * 0.8}
                      clipPath={`url(#${clipId})`}
                      className="pointer-events-none"
                    />
                  </g>
                );
              })
            : null}
          {layers.furniture
            ? furniture.map((item) => (
                <path
                  key={`furniture:${item.global_id}`}
                  d={polygonPathD(item.polygon)}
                  fill={FURNITURE_FILL}
                  fillOpacity={0.55}
                  stroke={FURNITURE_STROKE}
                  strokeWidth={roomStroke}
                >
                  <title>{item.name ? `Furniture: ${item.name}` : "Furniture"}</title>
                </path>
              ))
            : null}
          {layers.doors
            ? doors.map((d) => {
                const glyph =
                  d.segment.length === 2 && d.normal
                    ? buildDoorGlyph([d.segment[0]!, d.segment[1]!], d.normal, d.operation_type)
                    : null;
                if (glyph) {
                  return (
                    <g key={d.global_id}>
                      {glyph.arcs.map((arc, i) => (
                        <path
                          key={`arc:${i}`}
                          d={arc}
                          fill="none"
                          stroke="var(--door-glyph)"
                          strokeWidth={doorGlyphStroke}
                          strokeDasharray={`${markerBase * 0.0025} ${markerBase * 0.002}`}
                        />
                      ))}
                      {glyph.leaves.map((leaf, i) => (
                        <path
                          key={`leaf:${i}`}
                          d={leaf}
                          fill="none"
                          stroke="var(--door-glyph)"
                          strokeWidth={doorGlyphStroke}
                          strokeLinecap="round"
                        />
                      ))}
                      <title>
                        {(d.name || d.global_id) + ` (${glyph.kind.replace("_", " ")})`}
                      </title>
                    </g>
                  );
                }
                const poly = d.polygon && d.polygon.length >= 3 ? d.polygon : null;
                if (poly) {
                  const dPath =
                    poly
                      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`)
                      .join(" ") + " Z";
                  return (
                    <path
                      key={d.global_id}
                      d={dPath}
                      fill="var(--door-glyph)"
                      fillOpacity={0.85}
                      stroke="none"
                    >
                      <title>{d.name || d.global_id}</title>
                    </path>
                  );
                }
                if (!d.point) return null;
                return (
                  <circle
                    key={d.global_id}
                    cx={d.point.x}
                    cy={d.point.y}
                    r={doorR}
                    fill="var(--door-glyph)"
                    stroke="none"
                  >
                    <title>{d.name || d.global_id}</title>
                  </circle>
                );
              })
            : null}
        </>
      ) : (
        <>
          {evacuationHeatTexture ? (
            <>
              <defs>
                <clipPath id={heatClipId}>
                  {storeyNavmesh?.regions.map((r: NavmeshRegion) => (
                    <path key={r.spaceId} d={spacePathD(r.polygon, r.holes)} fillRule="evenodd" />
                  ))}
                </clipPath>
              </defs>
              <image
                href={evacuationHeatTexture.dataUrl}
                x={evacuationHeatTexture.bounds.minX}
                y={evacuationHeatTexture.bounds.minY}
                width={evacuationHeatTexture.bounds.maxX - evacuationHeatTexture.bounds.minX}
                height={evacuationHeatTexture.bounds.maxY - evacuationHeatTexture.bounds.minY}
                clipPath={`url(#${heatClipId})`}
                preserveAspectRatio="none"
                className="pointer-events-none"
              />
            </>
          ) : null}
          {storeyNavmesh?.regions.map((r: NavmeshRegion) => {
            const c = polygonCentroid(r.polygon);
            // The heatmap itself is the <image> texture above (a real
            // continuous field — see evacuation-heat-texture.ts); a flat
            // per-polygon fill here reads as coloring shapes in, not a
            // heatmap, which is exactly the look this replaced. This path
            // is now just outline + label + hit-target, with a faint wash
            // only when there's no heat data to show (normal navmesh view).
            // Unreachable still gets its own dashed hazard stroke, since
            // the texture treats "unreachable" and "worst reachable" as the
            // same top-of-scale color — the stroke is what actually tells
            // them apart, same convention this file uses for excluded spaces.
            const isUnreachable = unreachableSet?.has(r.spaceId) ?? false;
            const distance = regionDistanceToExit?.get(r.spaceId);
            const title = isUnreachable
              ? `${r.name || r.spaceId} — no path to an exit`
              : distance != null
                ? `${r.name || r.spaceId} — ${distance.toFixed(1)} m to nearest exit`
                : r.name;
            return (
              <g key={r.spaceId}>
                <path
                  d={spacePathD(r.polygon, r.holes)}
                  fill={evacuationHeatTexture ? "transparent" : "rgba(148,163,184,0.35)"}
                  fillRule="evenodd"
                  stroke={isUnreachable ? "var(--hazard)" : "#64748b"}
                  strokeWidth={roomStroke}
                  strokeDasharray={isUnreachable ? `${roomStroke * 3} ${roomStroke * 2}` : undefined}
                >
                  <title>{title}</title>
                </path>
                {r.name ? (
                  <g transform={`translate(${c.x} ${c.y})`}>
                    <text
                      transform="scale(1,-1)"
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize={markerBase * 0.013}
                      fill={palette.label}
                      opacity={0.85}
                      className="pointer-events-none select-none"
                    >
                      {r.name}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
          {/* Furniture obstacles sit on top of regions so route pins aren't
              dropped onto desks that the grid treats as non-walkable. */}
          {layers.furniture
            ? furniture.map((item) => (
                <path
                  key={`furniture:${item.global_id}`}
                  d={polygonPathD(item.polygon)}
                  fill={FURNITURE_FILL}
                  fillOpacity={0.55}
                  stroke={FURNITURE_STROKE}
                  strokeWidth={roomStroke}
                  className="pointer-events-none"
                >
                  <title>{item.name ? `Furniture: ${item.name}` : "Furniture"}</title>
                </path>
              ))
            : null}
          {storeyNavmesh?.portals.map((p: NavmeshPortal) => {
            const blocked = blockedPortalIds.has(p.id);
            const selected = selectedPortalIds.has(p.id);
            const load = portalLoad?.get(p.id) ?? 0;
            const door = p.doorGlobalId ? doorsByGlobalId.get(p.doorGlobalId) : null;
            const glyph =
              door && door.segment.length === 2 && door.normal
                ? buildDoorGlyph(
                    [door.segment[0]!, door.segment[1]!],
                    door.normal,
                    door.operation_type,
                  )
                : null;
            const kindLabel =
              p.kind === "exit"
                ? "Exit"
                : p.kind === "space"
                  ? "Space portal"
                  : p.inferred
                    ? "Door heal"
                    : "IFC door";
            return (
              <g key={p.id}>
                {glyph ? (
                  <g className="pointer-events-none">
                    {glyph.arcs.map((arc, i) => (
                      <path
                        key={`arc:${i}`}
                        d={arc}
                        fill="none"
                        stroke={palette.wallStroke}
                        strokeWidth={doorStroke}
                      />
                    ))}
                    {glyph.leaves.map((leaf, i) => (
                      <path
                        key={`leaf:${i}`}
                        d={leaf}
                        fill="none"
                        stroke={palette.wallStroke}
                        strokeWidth={doorStroke}
                        strokeLinecap="round"
                      />
                    ))}
                  </g>
                ) : null}
                {/* Traffic is now shown by the heatmap texture itself (see
                    evacuationHeatTexture) — this marker always keeps its
                    plain kind color/size, evacuation mode or not, so it
                    reads as "what kind of portal" rather than competing
                    with the field underneath as a second heat encoding. */}
                {selected ? (
                  <circle
                    cx={p.point.x}
                    cy={p.point.y}
                    r={portalR * 1.45}
                    fill="none"
                    stroke="var(--selection)"
                    strokeWidth={selectedStroke}
                    className="pointer-events-none"
                  />
                ) : null}
                <circle
                  cx={p.point.x}
                  cy={p.point.y}
                  r={portalR}
                  fill={
                    blocked
                      ? PORTAL_COLORS.blocked
                      : p.kind === "exit"
                        ? PORTAL_COLORS.exit
                        : p.kind === "space"
                          ? PORTAL_COLORS.spacePortal
                          : p.inferred
                            ? PORTAL_COLORS.doorHeal
                            : PORTAL_COLORS.door
                  }
                  stroke="#0f172a"
                  strokeWidth={doorStroke * 0.4}
                >
                  <title>
                    {portalLoad
                      ? `${load} evacuation route${load === 1 ? "" : "s"} cross this portal`
                      : blocked
                        ? `${kindLabel} — blocked · double-click to unblock`
                        : `${kindLabel} — click to select · double-click to block`}
                    : {p.spaceA}
                    {p.spaceB ? ` ↔ ${p.spaceB}` : ""}
                  </title>
                </circle>
                {blocked ? (
                  <line
                    x1={p.point.x - portalR * 0.7}
                    y1={p.point.y - portalR * 0.7}
                    x2={p.point.x + portalR * 0.7}
                    y2={p.point.y + portalR * 0.7}
                    stroke="#0f172a"
                    strokeWidth={doorStroke * 0.6}
                    strokeLinecap="round"
                    className="pointer-events-none"
                  />
                ) : null}
              </g>
            );
          })}
          {stairNodes.map((s) => {
            // Square, not a circle — stairs aren't a StoreyNavmesh.portal at
            // all (see computeEvacuationLoad's doc comment on why they're
            // treated as exits here), so this needs to read as visually
            // distinct from a real door/exit portal, not just another dot.
            // Traffic through it is shown by the heatmap texture itself (see
            // evacuationHeatTexture) — plain size/color always, same as
            // portals above.
            const load = portalLoad?.get(s.id) ?? 0;
            const size = portalR * 1.6;
            return (
              <g key={s.id}>
                <rect
                  x={s.point.x - size / 2}
                  y={s.point.y - size / 2}
                  width={size}
                  height={size}
                  fill="var(--stair-glyph)"
                  stroke="#0f172a"
                  strokeWidth={doorStroke * 0.4}
                >
                  <title>
                    {`${load} evacuation route${load === 1 ? "" : "s"} reach this stair/lift landing`}
                  </title>
                </rect>
              </g>
            );
          })}
        </>
      )}

      {layers.route && routeD ? (
        <path
          d={routeD}
          fill="none"
          stroke={`color-mix(in oklch, var(${isExitRoute ? "--route-emergency" : "--route-normal"}) 55%, var(--background))`}
          strokeWidth={routeHalo}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.85}
        />
      ) : null}
      {layers.route && routeD ? (
        // Marching dashes instead of a solid line — the route overlay is a
        // real computed path with a real direction (start → end / toward
        // the exit), so it can show that honestly instead of the heat
        // markers guessing at flow direction they don't actually have.
        <path
          d={routeD}
          fill="none"
          stroke={isExitRoute ? "var(--route-emergency)" : "var(--route-normal)"}
          strokeWidth={routeStroke}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={`${routeStroke * 2.2} ${routeStroke * 2.2}`}
          className="route-flow"
          style={{ "--route-flow-distance": `${-routeStroke * 4.4}` } as React.CSSProperties}
        />
      ) : null}

      {navmeshStart ? (
        <MapPin
          x={navmeshStart.x}
          y={navmeshStart.y}
          scale={pinScale}
          strokeW={doorStroke * 0.45}
          label="Start"
        />
      ) : null}
      {navmeshEnd ? (
        <MapPin
          x={navmeshEnd.x}
          y={navmeshEnd.y}
          scale={pinScale}
          strokeW={doorStroke * 0.45}
          label={isExitRoute ? "Exit" : "End"}
          color={isExitRoute ? "var(--route-emergency)" : "var(--route-normal)"}
        />
      ) : null}

      {selectedSpaces.map((space) => (
        <path
          key={`sel:${space.global_id}`}
          d={spacePathD(space.polygon, space.holes)}
          fill="color-mix(in oklch, var(--selection) 32%, transparent)"
          fillRule="evenodd"
          stroke="var(--selection)"
          strokeWidth={selectedStroke}
        >
          <title>Selected: {space.name || space.global_id}</title>
        </path>
      ))}
    </>
  );
}

export const FloorplanSvgLayers = memo(FloorplanSvgLayersImpl);
