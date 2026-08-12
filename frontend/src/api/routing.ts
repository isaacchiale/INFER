import type { RouteComputeRequest, RouteResult } from "@/types/graph";

const apiBase = "/api";

export async function computeRoute(body: RouteComputeRequest): Promise<RouteResult> {
  const response = await fetch(`${apiBase}/route/compute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Route compute failed (${response.status})`);
  }

  return (await response.json()) as RouteResult;
}
