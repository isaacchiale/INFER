/** Footprints document from POST/GET /models/{id}/footprints */

export type Point2D = { x: number; y: number };

export type SpaceFootprint = {
  global_id: string;
  name: string;
  storey_global_id: string | null;
  polygon: Point2D[];
  incomplete: boolean;
  method: "ifc_mesh_xy_hull" | "ifc_placement_bbox" | "unavailable";
};

export type DoorPortal = {
  global_id: string;
  name: string;
  storey_global_id: string | null;
  point: Point2D | null;
  segment: Point2D[];
  incomplete: boolean;
  method: "ifc_mesh_xy_centroid" | "ifc_object_placement" | "unavailable";
};

export type FootprintsDocument = {
  schema_version: "1.0";
  model_id: string;
  built_at?: string;
  coordinate_system: "ifc_world_xy_metres";
  storeys: Array<{ global_id: string; name: string; elevation: number | null }>;
  spaces: SpaceFootprint[];
  doors: DoorPortal[];
};
