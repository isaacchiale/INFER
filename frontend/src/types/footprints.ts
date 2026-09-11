/** Footprints document from POST/GET /models/{id}/footprints */

export type Point2D = { x: number; y: number };

export type SpaceFootprint = {
  global_id: string;
  name: string;
  storey_global_id: string | null;
  /** Exterior ring. */
  polygon: Point2D[];
  /** Inner rings (voids). Optional for older footprints.json. */
  holes?: Point2D[][];
  incomplete: boolean;
  method:
    | "ifc_mesh_xy_outline"
    | "ifc_mesh_xy_hull"
    | "ifc_placement_bbox"
    | "unavailable";
};

export type DoorPortal = {
  global_id: string;
  name: string;
  storey_global_id: string | null;
  point: Point2D | null;
  /** Long axis of the leaf in plan (two endpoints), when known. */
  segment: Point2D[];
  /** Plan hull of the door (thin rectangle). Empty/omitted when unmeasured. */
  polygon?: Point2D[];
  /** Unit XY through the wall (door facing). */
  normal?: Point2D | null;
  /**
   * Raw IfcDoorTypeOperationEnum value (e.g. "SINGLE_SWING_LEFT",
   * "SLIDING_TO_RIGHT"), when the source IFC sets it. Null/omitted when
   * absent or NOTDEFINED — never guessed, so treat null as "unknown", not
   * "swing".
   */
  operation_type?: string | null;
  incomplete: boolean;
  method: "ifc_mesh_xy_centroid" | "ifc_object_placement" | "unavailable";
};

export type OpeningPortal = {
  global_id: string;
  name: string;
  storey_global_id: string | null;
  point: Point2D | null;
  segment: Point2D[];
  incomplete: boolean;
  method: "ifc_mesh_xy_centroid" | "ifc_object_placement" | "unavailable";
  filled_by_door_global_id?: string | null;
  filled_by_window_global_id?: string | null;
  /** Element voided via IfcRelVoidsElement. */
  host_global_id?: string | null;
  /** False for furniture recesses (cabinets, counters), which are openings too. */
  host_is_wall?: boolean;
  /** Plan hull of the void. A doorway is long and thin; a wall-profile void is large both ways. */
  polygon?: Point2D[];
  /** Lowest / highest Z of the void, metres. */
  sill_z?: number | null;
  head_z?: number | null;
};

export type StairFootprint = {
  global_id: string;
  name: string;
  storey_global_id: string | null;
  polygon: Point2D[];
  incomplete: boolean;
  method: "ifc_mesh_xy_hull" | "ifc_placement_bbox" | "unavailable";
};

export type WallFootprint = {
  global_id: string;
  name: string;
  storey_global_id: string | null;
  polygon: Point2D[];
  incomplete: boolean;
  method: "ifc_mesh_xy_hull" | "ifc_placement_bbox" | "unavailable";
};

export type FurnitureFootprint = {
  global_id: string;
  name: string;
  storey_global_id: string | null;
  polygon: Point2D[];
  incomplete: boolean;
  method: "ifc_mesh_xy_hull" | "ifc_placement_bbox" | "unavailable";
};

export type FootprintsDocument = {
  schema_version: "1.0";
  model_id: string;
  built_at?: string;
  coordinate_system: "ifc_world_xy_metres";
  storeys: Array<{ global_id: string; name: string; elevation: number | null }>;
  spaces: SpaceFootprint[];
  doors: DoorPortal[];
  /** Optional for older footprints.json built before opening heal. */
  openings?: OpeningPortal[];
  /** Optional for older footprints.json built before stair overlay. */
  stairs?: StairFootprint[];
  /** Optional for older footprints.json built before wall-strip heal. */
  walls?: WallFootprint[];
  /** Optional for older footprints.json built before furniture obstacle extraction. */
  furniture?: FurnitureFootprint[];
};
