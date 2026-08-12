import type { ConnectivityGraph, StoreyBand } from "@/types/graph";

/** Storey bands for the demo graph (top → bottom visually = high elevation first). */
export const demoStoreyBands: StoreyBand[] = [
  { id: "st-l2", label: "Level 2", elevation: 8.4 },
  { id: "st-l1", label: "Level 1", elevation: 4.2 },
  { id: "st-l0", label: "Level 0", elevation: 0 },
];

/**
 * Small multi-storey portal graph for the Cytoscape workspace
 * (shaped like the IFC Graph View mock: rooms + stairwells per level).
 */
export const demoGraph: ConnectivityGraph = {
  schema_version: "1.0",
  model_id: "demo-graph",
  nodes: [
    // Level 2
    {
      id: "space:r301",
      kind: "space",
      global_id: "r301",
      name: "Stairwell",
      code: "R301",
      storey_global_id: "st-l2",
      category: "core",
    },
    {
      id: "space:r302",
      kind: "space",
      global_id: "r302",
      name: "Office A",
      code: "R302",
      storey_global_id: "st-l2",
      category: "office",
    },
    {
      id: "space:r303",
      kind: "space",
      global_id: "r303",
      name: "Office B",
      code: "R303",
      storey_global_id: "st-l2",
      category: "office",
    },
    {
      id: "space:r304",
      kind: "space",
      global_id: "r304",
      name: "Lounge",
      code: "R304",
      storey_global_id: "st-l2",
      category: "amenity",
    },
    {
      id: "space:r305",
      kind: "space",
      global_id: "r305",
      name: "Roof Garden",
      code: "R305",
      storey_global_id: "st-l2",
      category: "amenity",
    },
    { id: "door:d2a", kind: "door", global_id: "d2a", name: "D-2A", storey_global_id: "st-l2" },
    { id: "door:d2b", kind: "door", global_id: "d2b", name: "D-2B", storey_global_id: "st-l2" },
    { id: "door:d2c", kind: "door", global_id: "d2c", name: "D-2C", storey_global_id: "st-l2" },
    { id: "door:d2d", kind: "door", global_id: "d2d", name: "D-2D", storey_global_id: "st-l2" },

    // Level 1
    {
      id: "space:r201",
      kind: "space",
      global_id: "r201",
      name: "Stairwell",
      code: "R201",
      storey_global_id: "st-l1",
      category: "core",
    },
    {
      id: "space:r202",
      kind: "space",
      global_id: "r202",
      name: "Office C",
      code: "R202",
      storey_global_id: "st-l1",
      category: "office",
    },
    {
      id: "space:r203",
      kind: "space",
      global_id: "r203",
      name: "Lounge B",
      code: "R203",
      storey_global_id: "st-l1",
      category: "amenity",
    },
    {
      id: "space:r204",
      kind: "space",
      global_id: "r204",
      name: "Server Room",
      code: "R204",
      storey_global_id: "st-l1",
      category: "service",
    },
    { id: "door:d1a", kind: "door", global_id: "d1a", name: "D-1A", storey_global_id: "st-l1" },
    { id: "door:d1b", kind: "door", global_id: "d1b", name: "D-1B", storey_global_id: "st-l1" },
    { id: "door:d1c", kind: "door", global_id: "d1c", name: "D-1C", storey_global_id: "st-l1" },

    // Level 0
    {
      id: "space:r101",
      kind: "space",
      global_id: "r101",
      name: "Main Lobby",
      code: "R101",
      storey_global_id: "st-l0",
      category: "public",
    },
    {
      id: "space:r103",
      kind: "space",
      global_id: "r103",
      name: "Office A",
      code: "R103",
      storey_global_id: "st-l0",
      category: "office",
    },
    {
      id: "space:r104",
      kind: "space",
      global_id: "r104",
      name: "Stairwell",
      code: "R104",
      storey_global_id: "st-l0",
      category: "core",
    },
    { id: "door:d0a", kind: "door", global_id: "d0a", name: "D-0A", storey_global_id: "st-l0" },
    { id: "door:d0b", kind: "door", global_id: "d0b", name: "D-0B", storey_global_id: "st-l0" },

    // Vertical hubs (one node each)
    {
      id: "stair:core-a",
      kind: "stair",
      global_id: "stair-a",
      name: "Stair Core A",
      storey_global_id: null,
      category: "core",
    },
  ],
  edges: [
    // L2 horizontal
    { id: "e-l2-1", kind: "space_door", source: "space:r301", target: "door:d2a", method: "ifc_rel_space_boundary" },
    { id: "e-l2-2", kind: "space_door", source: "space:r302", target: "door:d2a", method: "ifc_rel_space_boundary" },
    { id: "e-l2-3", kind: "space_door", source: "space:r302", target: "door:d2b", method: "ifc_rel_space_boundary" },
    { id: "e-l2-4", kind: "space_door", source: "space:r303", target: "door:d2b", method: "ifc_rel_space_boundary" },
    { id: "e-l2-5", kind: "space_door", source: "space:r303", target: "door:d2c", method: "ifc_rel_space_boundary" },
    { id: "e-l2-6", kind: "space_door", source: "space:r304", target: "door:d2c", method: "ifc_rel_space_boundary" },
    { id: "e-l2-7", kind: "space_door", source: "space:r304", target: "door:d2d", method: "ifc_rel_space_boundary" },
    { id: "e-l2-8", kind: "space_door", source: "space:r305", target: "door:d2d", method: "ifc_rel_space_boundary" },

    // L1 horizontal
    { id: "e-l1-1", kind: "space_door", source: "space:r201", target: "door:d1a", method: "ifc_rel_space_boundary" },
    { id: "e-l1-2", kind: "space_door", source: "space:r202", target: "door:d1a", method: "ifc_rel_space_boundary" },
    { id: "e-l1-3", kind: "space_door", source: "space:r202", target: "door:d1b", method: "ifc_rel_space_boundary" },
    { id: "e-l1-4", kind: "space_door", source: "space:r203", target: "door:d1b", method: "ifc_rel_space_boundary" },
    { id: "e-l1-5", kind: "space_door", source: "space:r203", target: "door:d1c", method: "ifc_rel_space_boundary" },
    { id: "e-l1-6", kind: "space_door", source: "space:r204", target: "door:d1c", method: "ifc_rel_space_boundary" },

    // L0 horizontal
    { id: "e-l0-1", kind: "space_door", source: "space:r101", target: "door:d0a", method: "ifc_rel_space_boundary" },
    { id: "e-l0-2", kind: "space_door", source: "space:r103", target: "door:d0a", method: "ifc_rel_space_boundary" },
    { id: "e-l0-3", kind: "space_door", source: "space:r103", target: "door:d0b", method: "ifc_rel_space_boundary" },
    { id: "e-l0-4", kind: "space_door", source: "space:r104", target: "door:d0b", method: "ifc_rel_space_boundary" },

    // Vertical via single stair node (cleaner portal model)
    {
      id: "e-v-l2",
      kind: "vertical",
      source: "space:r301",
      target: "stair:core-a",
      global_id: "stair-a",
      method: "vertical_storey_link",
    },
    {
      id: "e-v-l1",
      kind: "vertical",
      source: "space:r201",
      target: "stair:core-a",
      global_id: "stair-a",
      method: "vertical_storey_link",
    },
    {
      id: "e-v-l0",
      kind: "vertical",
      source: "space:r104",
      target: "stair:core-a",
      global_id: "stair-a",
      method: "vertical_storey_link",
    },
  ],
};

export const demoDefaultOrigin = "space:r103";
export const demoDefaultDestination = "space:r203";
