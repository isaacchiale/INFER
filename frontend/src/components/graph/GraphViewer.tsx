import { useEffect, useMemo, useRef, useState } from "react";
import type { Core, ElementDefinition } from "cytoscape";
import { demoDefaultDestination, demoDefaultOrigin, demoGraph, demoStoreyBands } from "@/data/demo-graph";
import { computeRoute } from "@/api/routing";
import type { ConnectivityGraph, RouteResult } from "@/types/graph";
import { cn } from "@/lib/utils";

const CATEGORY_COLORS: Record<string, string> = {
  core: "#ef4444",
  office: "#3b82f6",
  amenity: "#22c55e",
  service: "#eab308",
  public: "#94a3b8",
  circulation: "#64748b",
  default: "#60a5fa",
};

function categoryColor(category?: string, kind?: string): string {
  if (kind === "stair" || kind === "lift") return CATEGORY_COLORS.core;
  if (kind === "door") return "#cbd5e1";
  return CATEGORY_COLORS[category ?? ""] ?? CATEGORY_COLORS.default;
}

function buildElements(
  graph: ConnectivityGraph,
  pathNodeIds: Set<string>,
  pathEdgeIds: Set<string>,
): ElementDefinition[] {
  const bandHeight = 220;
  const bandGap = 28;
  const bands = [...demoStoreyBands].sort((a, b) => b.elevation - a.elevation);
  const bandIndex = new Map(bands.map((b, i) => [b.id, i]));

  const elements: ElementDefinition[] = [];

  // Invisible band anchors for labels (positions only)
  bands.forEach((band, i) => {
    elements.push({
      data: { id: `band:${band.id}`, label: band.label, band: true },
      position: { x: 24, y: i * (bandHeight + bandGap) + 28 },
      selectable: false,
      grabbable: false,
    });
  });

  const spacesByStorey = new Map<string, typeof graph.nodes>();
  for (const node of graph.nodes) {
    if (node.kind !== "space" || !node.storey_global_id) continue;
    const list = spacesByStorey.get(node.storey_global_id) ?? [];
    list.push(node);
    spacesByStorey.set(node.storey_global_id, list);
  }

  for (const node of graph.nodes) {
    if (node.kind === "space") {
      const storey = node.storey_global_id ?? "unknown";
      const idx = bandIndex.get(storey) ?? 0;
      const siblings = spacesByStorey.get(storey) ?? [];
      const order = Math.max(
        siblings.findIndex((n) => n.id === node.id),
        0,
      );
      const x = 120 + order * 150;
      const y = idx * (bandHeight + bandGap) + bandHeight / 2;
      elements.push({
        data: {
          id: node.id,
          label: `${node.code ?? node.name}\n${node.name}`,
          kind: node.kind,
          color: categoryColor(node.category, node.kind),
          onPath: pathNodeIds.has(node.id),
        },
        position: { x, y },
      });
    } else if (node.kind === "door") {
      const storey = node.storey_global_id ?? "unknown";
      const idx = bandIndex.get(storey) ?? 0;
      // Place doors between connected spaces roughly mid-band
      const incident = graph.edges.filter(
        (e) => e.source === node.id || e.target === node.id,
      );
      const spaceIds = incident.flatMap((e) =>
        [e.source, e.target].filter((id) => id.startsWith("space:")),
      );
      const xs = spaceIds.map((id) => {
        const siblings = spacesByStorey.get(storey) ?? [];
        const order = Math.max(
          siblings.findIndex((n) => n.id === id),
          0,
        );
        return 120 + order * 150;
      });
      const x = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 200;
      const y = idx * (bandHeight + bandGap) + bandHeight / 2;
      elements.push({
        data: {
          id: node.id,
          label: "",
          kind: node.kind,
          color: categoryColor(undefined, "door"),
          onPath: pathNodeIds.has(node.id),
        },
        position: { x, y },
      });
    } else if (node.kind === "stair" || node.kind === "lift") {
      // Park vertical hubs on the left spine between bands
      elements.push({
        data: {
          id: node.id,
          label: node.name,
          kind: node.kind,
          color: categoryColor(node.category, node.kind),
          onPath: pathNodeIds.has(node.id),
        },
        position: { x: 48, y: ((bands.length - 1) * (bandHeight + bandGap)) / 2 + bandHeight / 2 },
      });
    }
  }

  for (const edge of graph.edges) {
    const vertical = edge.kind === "vertical";
    elements.push({
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        vertical,
        onPath: pathEdgeIds.has(edge.id),
      },
    });
  }

  return elements;
}

export function GraphViewer({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const [origin, setOrigin] = useState(demoDefaultOrigin);
  const [destination, setDestination] = useState(demoDefaultDestination);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clickMode = useRef<"origin" | "destination">("origin");

  const spaceOptions = useMemo(
    () => demoGraph.nodes.filter((n) => n.kind === "space"),
    [],
  );

  const pathNodeIds = useMemo(() => new Set(route?.node_ids ?? []), [route]);
  const pathEdgeIds = useMemo(() => new Set(route?.edge_ids ?? []), [route]);

  const roomCount = spaceOptions.length;
  const linkCount = demoGraph.edges.length;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let cy: Core | null = null;

    void import("cytoscape").then((mod) => {
      if (cancelled || !hostRef.current) return;
      const cytoscape = mod.default;
      const instance = cytoscape({
      container: hostRef.current,
      elements: buildElements(demoGraph, pathNodeIds, pathEdgeIds),
      layout: { name: "preset" },
      style: [
        {
          selector: "node[band]",
          style: {
            label: "data(label)",
            "text-valign": "center",
            "text-halign": "left",
            "font-size": 12,
            "font-weight": 600,
            color: "#64748b",
            "background-opacity": 0,
            width: 1,
            height: 1,
            "text-margin-x": 8,
          },
        },
        {
          selector: "node[!band]",
          style: {
            label: "data(label)",
            "text-wrap": "wrap",
            "text-max-width": 90,
            "text-valign": "center",
            "text-halign": "center",
            "font-size": 10,
            color: "#0f172a",
            "background-color": "data(color)",
            "border-width": 2,
            "border-color": "#e2e8f0",
            width: 56,
            height: 56,
            "overlay-padding": 4,
          },
        },
        {
          selector: 'node[kind = "door"]',
          style: {
            width: 14,
            height: 14,
            label: "",
            "border-width": 1,
            "border-color": "#94a3b8",
          },
        },
        {
          selector: 'node[kind = "stair"], node[kind = "lift"]',
          style: {
            shape: "round-rectangle",
            width: 70,
            height: 36,
            "font-size": 9,
            color: "#fff",
          },
        },
        {
          selector: "node[onPath]",
          style: {
            "border-width": 4,
            "border-color": "#2563eb",
          },
        },
        {
          selector: "edge",
          style: {
            width: 2,
            "line-color": "#cbd5e1",
            "curve-style": "bezier",
            "target-arrow-shape": "none",
          },
        },
        {
          selector: "edge[?vertical]",
          style: {
            "line-style": "dashed",
            "line-color": "#f97316",
            width: 2,
          },
        },
        {
          selector: "edge[onPath]",
          style: {
            width: 5,
            "line-color": "#2563eb",
            "line-style": "solid",
            "z-index": 10,
          },
        },
      ],
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
    });

      if (cancelled) {
        instance.destroy();
        return;
      }

      cy = instance;
      cy.on("tap", "node[!band]", (evt) => {
        const id = evt.target.id() as string;
        if (!id.startsWith("space:")) return;
        if (clickMode.current === "origin") {
          setOrigin(id);
          clickMode.current = "destination";
        } else {
          setDestination(id);
          clickMode.current = "origin";
        }
      });

      cyRef.current = cy;
      cy.fit(undefined, 40);
    });

    return () => {
      cancelled = true;
      cy?.destroy();
      cyRef.current = null;
    };
    // Re-init when path sets change so styles/positions refresh simply for POC.
  }, [pathNodeIds, pathEdgeIds]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    void computeRoute({
      origin_node_id: origin,
      destination_node_id: destination,
      graph: demoGraph,
    })
      .then((result) => {
        if (!cancelled) setRoute(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRoute(null);
          setError(err instanceof Error ? err.message : "Route failed");
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [origin, destination]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-[#f8fafc] text-slate-800", className)}>
      <div className="relative min-h-0 flex-1">
        {/* Level band chrome behind cytoscape */}
        <div className="pointer-events-none absolute inset-3 z-0 flex flex-col gap-3">
          {demoStoreyBands.map((band) => (
            <div
              key={band.id}
              className="min-h-0 flex-1 rounded-xl border border-slate-200 bg-white/80 shadow-sm"
            >
              <div className="px-3 pt-2 text-xs font-semibold text-slate-500">{band.label}</div>
            </div>
          ))}
        </div>
        <div ref={hostRef} className="absolute inset-0 z-10" />
      </div>

      <div className="border-t border-slate-200 bg-white px-3 py-2 text-[12px]">
        <p className="mb-2 text-slate-500">Click nodes to set Start / Destination</p>
        <div className="mb-2 flex flex-wrap gap-3 text-slate-600">
          <span>
            Topology Size: <strong>{roomCount} Rooms</strong>
          </span>
          <span>
            Network Connections: <strong>{linkCount} Links</strong>
          </span>
          <span className={cn(route?.found && "text-blue-600")}>
            Shortest Path:{" "}
            <strong>{busy ? "…" : route?.found ? `${route.hops} Hops` : "None"}</strong>
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-0.5 text-[11px] text-slate-500">
            Start Room
            <select
              className="h-8 min-w-[140px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
            >
              {spaceOptions.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.code ?? n.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-0.5 text-[11px] text-slate-500">
            Target Room
            <select
              className="h-8 min-w-[140px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              {spaceOptions.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.code ?? n.name}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="text-[11px] text-red-600">{error}</p>}
          {!error && route && !route.found && (
            <p className="text-[11px] text-amber-600">{route.message}</p>
          )}
        </div>
      </div>
    </div>
  );
}
