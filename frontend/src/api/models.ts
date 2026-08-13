import type { ConnectivityGraph, RouteResult } from "@/types/graph";

const apiBase = "/api";

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const json = JSON.parse(text) as { detail?: string };
    if (json.detail) return json.detail;
  } catch {
    /* plain text */
  }
  return text || `Request failed (${response.status})`;
}

export interface ModelMetadata {
  model_id: string;
  original_filename: string;
  size_bytes: number;
  created_at: string;
  extract_status: "none" | "ready" | "failed";
}

export interface EntitiesExtract {
  schema_version: "1.0";
  model_id: string;
  extracted_at?: string;
  storeys: Array<{ global_id: string; name: string; elevation: number | null }>;
  spaces: Array<{ global_id: string; name: string; storey_global_id: string | null }>;
  doors: Array<{ global_id: string; name: string; storey_global_id: string | null }>;
  stairs: Array<{ global_id: string; name: string }>;
  lifts: Array<{ global_id: string; name: string }>;
  exit_candidates: Array<{ global_id: string; name: string; reason: string }>;
}

export async function uploadModel(file: File): Promise<ModelMetadata> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${apiBase}/models`, { method: "POST", body: form });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as ModelMetadata;
}

export async function extractModel(modelId: string): Promise<EntitiesExtract> {
  const response = await fetch(`${apiBase}/models/${modelId}/extract`, { method: "POST" });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as EntitiesExtract;
}

export async function getModelEntities(modelId: string): Promise<EntitiesExtract> {
  const response = await fetch(`${apiBase}/models/${modelId}/entities`);
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as EntitiesExtract;
}

export async function buildModelGraph(modelId: string): Promise<ConnectivityGraph> {
  const response = await fetch(`${apiBase}/models/${modelId}/graph`, { method: "POST" });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as ConnectivityGraph;
}

export async function getModelGraph(modelId: string): Promise<ConnectivityGraph> {
  const response = await fetch(`${apiBase}/models/${modelId}/graph`);
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as ConnectivityGraph;
}

export async function computeModelRoute(
  modelId: string,
  body: {
    origin_node_id: string;
    destination_node_id: string;
    blocked_node_ids?: string[];
    blocked_edge_ids?: string[];
  },
): Promise<RouteResult> {
  const response = await fetch(`${apiBase}/models/${modelId}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as RouteResult;
}
