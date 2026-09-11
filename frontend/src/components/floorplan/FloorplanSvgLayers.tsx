import { memo } from "react";
import { buildDoorGlyph } from "@/lib/door-symbol";
import type { Point2 } from "@/lib/floorplan-camera";
import type { DoorPortal, SpaceFootprint, StairFootprint, WallFootprint } from "@/types/footprints";
import type { NavmeshPortal, NavmeshRegion, StoreyNavmesh } from "@/lib/navmesh";

/**
 * Navmesh portal kind colours — picked from the Okabe–Ito colorblind-safe
 * set. The old palette (orange door / yellow heal / green space / red exit)
 * put both a red↔green pair and an orange↔yellow pair in the same legend,
 * the two classic confusable pairs under red-green color blindness. Blocked
 * stays gray with its own slash mark, which doesn't rely on hue at all.
 */
export const PORTAL_COLORS = {
  door: "#0072B2", // blue
  doorHeal: "#eab308", // yellow
  spacePortal: "#CC79A7", // reddish purple
  exit: "#ef4444", // red — safe on its own once nothing else in the set is green
  blocked: "#94a3b8", // gray
} as const;

/** Typical tread depth (metres) — world-space, same units as the footprint geometry. */
const STAIR_TREAD_SPACING_M = 0.28;

export type FloorplanPalette = {
  wall: string;
  wallStroke: string;
  label: string;
  canvasBg: string;
};

export type PlanLayer = "spaces" | "walls" | "doors" | "stairs" | "route";

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
 * the footprint's own bounding box since there's no per-tread geometry to
 * draw from. No up/down arrow: which way a given stair actually goes isn't
 * derivable from this footprint alone, so this doesn't claim a direction.
 */
function stairTreadLinesD(polygon: Point2[], treadSpacing: number): string {
  if (polygon.length < 3) return "";
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w < 1e-6 || h < 1e-6) return "";
  const segments: string[] = [];
  if (w >= h) {
    const count = Math.max(2, Math.round(w / treadSpacing));
    for (let i = 1; i < count; i++) {
      const x = minX + (w * i) / count;
      segments.push(`M${x} ${minY} L${x} ${maxY}`);
    }
  } else {
    const count = Math.max(2, Math.round(h / treadSpacing));
    for (let i = 1; i < count; i++) {
      const y = minY + (h * i) / count;
      segments.push(`M${minX} ${y} L${maxX} ${y}`);
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
  color = "#2563eb",
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
  spaces: SpaceFootprint[];
  stairs: StairFootprint[];
  doors: DoorPortal[];
  storeyNavmesh: StoreyNavmesh | null;
  pathD: string;
  navmeshStart: Point2 | null;
  navmeshEnd: Point2 | null;
  isExitRoute: boolean;
  blockedPortalIds: Set<string>;
  doorsByGlobalId: Map<string, DoorPortal>;
  palette: FloorplanPalette;
  selectedSpaces: SpaceFootprint[];
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
  spaces,
  stairs,
  doors,
  storeyNavmesh,
  pathD,
  navmeshStart,
  navmeshEnd,
  isExitRoute,
  blockedPortalIds,
  doorsByGlobalId,
  palette,
  selectedSpaces,
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
                return (
                  <g key={s.global_id}>
                    <path
                      d={spacePathD(s.polygon, s.holes)}
                      fill="rgba(148,163,184,0.35)"
                      fillRule="evenodd"
                      stroke="#64748b"
                      strokeWidth={roomStroke}
                    >
                      <title>{s.name || s.global_id}</title>
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
            ? stairs.map((s) => (
                <g key={`stair:${s.global_id}`}>
                  <path
                    d={polygonPathD(s.polygon)}
                    fill="none"
                    stroke="#7c3aed"
                    strokeWidth={roomStroke * 1.4}
                  >
                    <title>{s.name ? `Stair: ${s.name}` : "Stair"}</title>
                  </path>
                  <path
                    d={stairTreadLinesD(s.polygon, STAIR_TREAD_SPACING_M)}
                    fill="none"
                    stroke="#7c3aed"
                    strokeWidth={roomStroke * 0.8}
                    className="pointer-events-none"
                  />
                </g>
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
                          stroke="#f59e0b"
                          strokeWidth={doorGlyphStroke}
                          strokeDasharray={`${markerBase * 0.0025} ${markerBase * 0.002}`}
                        />
                      ))}
                      {glyph.leaves.map((leaf, i) => (
                        <path
                          key={`leaf:${i}`}
                          d={leaf}
                          fill="none"
                          stroke="#f59e0b"
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
                      fill="#f59e0b"
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
                    fill="#f59e0b"
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
          {storeyNavmesh?.regions.map((r: NavmeshRegion) => {
            const c = polygonCentroid(r.polygon);
            return (
              <g key={r.spaceId}>
                <path
                  d={spacePathD(r.polygon, r.holes)}
                  fill="rgba(148,163,184,0.35)"
                  fillRule="evenodd"
                  stroke="#64748b"
                  strokeWidth={roomStroke}
                >
                  <title>{r.name}</title>
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
          {storeyNavmesh?.portals.map((p: NavmeshPortal) => {
            const blocked = blockedPortalIds.has(p.id);
            const door = p.doorGlobalId ? doorsByGlobalId.get(p.doorGlobalId) : null;
            const glyph =
              door && door.segment.length === 2 && door.normal
                ? buildDoorGlyph(
                    [door.segment[0]!, door.segment[1]!],
                    door.normal,
                    door.operation_type,
                  )
                : null;
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
                    {blocked
                      ? "Blocked — click to unblock"
                      : `${
                          p.kind === "exit"
                            ? "Exit"
                            : p.kind === "space"
                              ? "Space portal"
                              : p.inferred
                                ? "Door heal"
                                : "IFC door"
                        } — click to block`}
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
                  />
                ) : null}
              </g>
            );
          })}
        </>
      )}

      {layers.route && pathD ? (
        <path
          d={pathD}
          fill="none"
          stroke="#93c5fd"
          strokeWidth={routeHalo}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.85}
        />
      ) : null}
      {layers.route && pathD ? (
        <path
          d={pathD}
          fill="none"
          stroke="#1d4ed8"
          strokeWidth={routeStroke}
          strokeLinecap="round"
          strokeLinejoin="round"
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
          color={isExitRoute ? "#ef4444" : "#2563eb"}
        />
      ) : null}

      {selectedSpaces.map((space) => (
        <path
          key={`sel:${space.global_id}`}
          d={spacePathD(space.polygon, space.holes)}
          fill="rgba(37,99,235,0.28)"
          fillRule="evenodd"
          stroke="#2563eb"
          strokeWidth={selectedStroke}
        >
          <title>Selected: {space.name || space.global_id}</title>
        </path>
      ))}
    </>
  );
}

export const FloorplanSvgLayers = memo(FloorplanSvgLayersImpl);
