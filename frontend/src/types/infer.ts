// INFER domain types — Indoor Navigation and Facility Environment Reasoning

export type DataProvenance = "verified" | "inferred" | "user-confirmed" | "needs-review";

export type Severity = "critical" | "major" | "minor" | "info";

export interface Building {
  id: string;
  name: string;
  projectId: string;
  address: string;
  schema: string;
  sourceFormat: string;
  storeyCount: number;
  spaceCount: number;
  doorCount: number;
  verticalTransitionCount: number;
  probableExitCount: number;
  readinessScore: number;
  lastProcessed: string;
  georeferencing: {
    status: "verified" | "inferred" | "missing";
    crs: string;
    note: string;
  };
}

export interface Storey {
  id: string;
  name: string;
  shortName: string;
  elevation: number;
  spaceCount: number;
  readiness: number;
}

export interface Space {
  id: string;
  name: string;
  code: string;
  ifcClass: string;
  guid: string;
  storeyId: string;
  category: "office" | "circulation" | "core" | "service" | "public" | "amenity";
  area: number;
  occupancy: number;
  provenance: DataProvenance;
  connectedSpaceIds: string[];
}

export type TransitionKind = "door" | "stair" | "lift" | "ramp" | "opening" | "exit";

export interface Transition {
  id: string;
  name: string;
  kind: TransitionKind;
  ifcClass: string;
  guid: string;
  storeyId: string;
  fromSpaceId?: string;
  toSpaceId?: string;
  clearWidthMm?: number;
  stepFree: boolean;
  operational: "operational" | "unknown" | "out-of-service";
  provenance: DataProvenance;
}

export type AgentProfileId =
  | "visitor"
  | "staff"
  | "wheelchair"
  | "facilities"
  | "responder";

export type RouteMode = "fastest" | "accessible" | "lowest-risk" | "emergency-exit" | "responder";

export type RouteRestriction =
  | "avoid-stairs"
  | "avoid-lifts"
  | "avoid-restricted"
  | "prefer-sheltered"
  | "avoid-hazards";

export interface RouteStep {
  id: string;
  instruction: string;
  detail?: string;
  distance?: number;
  storeyId: string;
  transitionKind?: TransitionKind;
  provenance: DataProvenance;
}

export interface RouteEvidence {
  id: string;
  label: string;
  value: string;
  provenance: DataProvenance;
  note?: string;
}

export interface RouteAlternative {
  id: string;
  label: string;
  distance: number;
  duration: number;
  rejected: boolean;
  reason: string;
}

export interface Route {
  id: string;
  label: string;
  mode: RouteMode;
  profile: AgentProfileId;
  originId: string;
  destinationId: string;
  distance: number;
  duration: number;
  storeysTraversed: string[];
  doorsCrossed: number;
  verticalTransition: string;
  status: "valid" | "degraded" | "blocked";
  confidence: number;
  warnings: string[];
  steps: RouteStep[];
  evidence: RouteEvidence[];
  alternatives: RouteAlternative[];
  rationale: string;
}

export type ScenarioConditionKind =
  | "door-unavailable"
  | "corridor-blocked"
  | "stair-unavailable"
  | "lift-unavailable"
  | "restricted-zone"
  | "hazard-zone"
  | "construction-closure";

export interface ScenarioCondition {
  id: string;
  kind: ScenarioConditionKind;
  entityLabel: string;
  entityGuid?: string;
  storeyId: string;
  location: string;
  severity: Severity;
  startTime: string;
  status: "active" | "scheduled" | "cleared";
}

export interface Scenario {
  id: string;
  name: string;
  conditions: ScenarioCondition[];
}

export interface HazardZone {
  id: string;
  label: string;
  storeyId: string;
  severity: Severity;
  polygon: [number, number][];
  active: boolean;
}

export interface Evidence {
  id: string;
  kind: "ifc-fact" | "deterministic" | "ai-inference" | "human-approved";
  label: string;
  detail: string;
}

export interface ValidationIssue {
  id: string;
  title: string;
  category: "connectivity" | "classification" | "accessibility" | "geometry" | "metadata";
  entityLabel: string;
  entityClass: string;
  guid: string;
  storeyId: string;
  severity: Severity;
  confidence: number;
  provenance: DataProvenance;
  status: "open" | "accepted" | "rejected" | "deferred";
  summary: string;
  relatedEntities: string[];
  evidence: Evidence[];
  proposedAction: string;
}

export type ProcessingStageStatus = "pending" | "running" | "complete" | "warning" | "failed";

export interface ProcessingStage {
  id: string;
  name: string;
  status: ProcessingStageStatus;
  timestamp?: string;
  detail?: string;
}

export interface ModelProcessingStatus {
  modelId: string;
  label: string;
  stages: ProcessingStage[];
  progress: number;
}

export type LayerId =
  | "architecture"
  | "spaces"
  | "doors"
  | "vertical"
  | "graph"
  | "navmesh"
  | "routes"
  | "hazards"
  | "issues"
  | "assets";

export interface LayerState {
  id: LayerId;
  label: string;
  visible: boolean;
  provenance?: DataProvenance;
}
