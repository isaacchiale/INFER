export type GraphNodeKind = "space" | "door" | "stair" | "lift";
export type GraphEdgeKind = "space_door" | "vertical" | "space_space";
export type GraphVariant = "ifc" | "geometry" | "topologic";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  global_id: string;
  name: string;
  storey_global_id: string | null;
  /**
   * Geometry variant: space contains other same-storey spaces
   * (candidate to remove or reduce to residual). Flagged only — not removed yet.
   */
  nested_parent?: boolean;
  /** Optional short code for labels (FE demo). */
  code?: string;
  /** Optional category for colouring (FE demo). */
  category?: string;
}

export interface GraphEdge {
  id: string;
  kind: GraphEdgeKind;
  source: string;
  target: string;
  global_id?: string | null;
  method:
    | "ifc_rel_space_boundary"
    | "same_storey_fallback"
    | "vertical_storey_link"
    | "geom_door_space"
    | "geom_stair_space"
    | "topologicpy_adjacency";
  bidirectional?: boolean;
  /** True when not authored via IfcRelSpaceBoundary — draw green in the viewer. */
  inferred?: boolean;
}

export interface ConnectivityGraph {
  schema_version: "1.0";
  model_id: string;
  variant?: GraphVariant;
  built_at?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface RouteComputeRequest {
  origin_node_id: string;
  destination_node_id: string;
  blocked_node_ids?: string[];
  blocked_edge_ids?: string[];
  graph?: ConnectivityGraph;
  graph_variant?: GraphVariant;
}

export interface RouteResult {
  found: boolean;
  origin_node_id: string;
  destination_node_id: string;
  node_ids: string[];
  edge_ids: string[];
  hops: number;
  blocked_node_ids: string[];
  blocked_edge_ids: string[];
  message: string;
}

export interface StoreyBand {
  id: string;
  label: string;
  elevation: number;
}
