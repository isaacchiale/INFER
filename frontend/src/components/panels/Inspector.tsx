import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";
import { useModelData, useViewport } from "@/state/infer-store";
import { toDisplayGraph } from "@/lib/graph-layout";
import { doorIdFromVizEdge } from "@/lib/navmesh";
import { toastExclusionToggle, exclusionNodeLabel } from "@/lib/exclusion-toast";
import { cn } from "@/lib/utils";
import type { EntitiesExtract } from "@/api/models";
import type { FootprintsDocument, SpaceFootprint } from "@/types/footprints";
import type { ConnectivityGraph } from "@/types/graph";

const TRAY_W = 300;
const SEARCH_CAP = 24;

type BrowseSection = "all" | "region" | "ifc_door" | "door_heal" | "space_heal" | "exit";

type SpaceItem = {
  kind: "space";
  rawId: string;
  globalId: string;
  footprint: SpaceFootprint | null;
  entity: EntitiesExtract["spaces"][number] | null;
};

type PortalItem = {
  kind: "portal";
  rawId: string;
  portalId: string;
  portalKind: "door" | "space" | "exit" | "vertical";
  inferred: boolean;
  doorName: string | null;
  doorGlobalId: string | null;
  spaceAName: string;
  spaceBName: string | null;
  storeyName: string | null;
};

type SelectableItem = SpaceItem | PortalItem;

type CatalogRow = {
  rawId: string;
  title: string;
  subtitle: string;
  kindLabel: string;
  removed: boolean;
};

function spaceLabel(footprints: FootprintsDocument | null, spaceId: string): string {
  const gid = spaceId.startsWith("space:") ? spaceId.slice("space:".length) : spaceId;
  const space = footprints?.spaces.find((s) => s.global_id === gid);
  return space?.name || gid;
}

function storeyNameForSpace(
  footprints: FootprintsDocument | null,
  spaceId: string,
): string | null {
  const gid = spaceId.startsWith("space:") ? spaceId.slice("space:".length) : spaceId;
  const space = footprints?.spaces.find((s) => s.global_id === gid);
  const storeyId = space?.storey_global_id;
  if (!storeyId) return null;
  return footprints?.storeys?.find((s) => s.global_id === storeyId)?.name ?? null;
}

function resolvePortalItem(
  rawId: string,
  footprints: FootprintsDocument | null,
  graph: ConnectivityGraph | null,
): PortalItem | null {
  if (!rawId.startsWith("portal:")) return null;
  const portalId = rawId.slice("portal:".length);

  const exitMatch = /^viz-exit:door:([^:]+):space:(.+)$/.exec(portalId);
  if (exitMatch) {
    const doorGid = exitMatch[1]!;
    const spaceId = `space:${exitMatch[2]!}`;
    const door = footprints?.doors.find((d) => d.global_id === doorGid) ?? null;
    return {
      kind: "portal",
      rawId,
      portalId,
      portalKind: "exit",
      inferred: false,
      doorName: door?.name || null,
      doorGlobalId: doorGid,
      spaceAName: spaceLabel(footprints, spaceId),
      spaceBName: null,
      storeyName: storeyNameForSpace(footprints, spaceId),
    };
  }

  if (!graph) return null;
  const edge = toDisplayGraph(graph).edges.find((e) => e.id === portalId);
  if (!edge) return null;

  if (edge.kind === "vertical") {
    return {
      kind: "portal",
      rawId,
      portalId,
      portalKind: "vertical",
      inferred: Boolean(edge.inferred),
      doorName: null,
      doorGlobalId: null,
      spaceAName: spaceLabel(footprints, edge.source),
      spaceBName: spaceLabel(footprints, edge.target),
      storeyName: storeyNameForSpace(footprints, edge.source),
    };
  }

  const portalKind: PortalItem["portalKind"] =
    edge.kind === "space_door" || edge.id.startsWith("viz-door:") || Boolean(edge.collapsed)
      ? "door"
      : "space";
  const doorNodeId = doorIdFromVizEdge(edge.id);
  const doorGid = doorNodeId?.slice("door:".length) ?? null;
  const door = doorGid ? (footprints?.doors.find((d) => d.global_id === doorGid) ?? null) : null;
  const inferred =
    Boolean(edge.inferred) ||
    edge.method === "geom_door_space" ||
    edge.method === "geom_opening_space" ||
    (portalKind === "door" && edge.method !== "ifc_rel_space_boundary");

  return {
    kind: "portal",
    rawId,
    portalId,
    portalKind,
    inferred,
    doorName: door?.name || null,
    doorGlobalId: doorGid,
    spaceAName: spaceLabel(footprints, edge.source),
    spaceBName: spaceLabel(footprints, edge.target),
    storeyName: storeyNameForSpace(footprints, edge.source),
  };
}

function portalTitle(item: PortalItem): string {
  if (item.doorName) return item.doorName;
  if (item.portalKind === "exit") return "Exit portal";
  if (item.portalKind === "space") return "Space portal";
  if (item.portalKind === "vertical") return "Vertical link";
  return "Door portal";
}

function portalKindLabel(item: PortalItem): string {
  if (item.portalKind === "exit") return "Exit";
  if (item.portalKind === "space") return "Space heal";
  if (item.portalKind === "vertical") return "Stair / lift";
  return item.inferred ? "Door heal" : "IFC door";
}

function portalBrowseSection(item: PortalItem): BrowseSection | "vertical" {
  if (item.portalKind === "exit") return "exit";
  if (item.portalKind === "space") return "space_heal";
  if (item.portalKind === "vertical") return "vertical";
  return item.inferred ? "door_heal" : "ifc_door";
}

function listExitPortalIds(graph: ConnectivityGraph | null): string[] {
  if (!graph) return [];
  const spacesByDoor = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "space_door") continue;
    const doorId = edge.source.startsWith("door:")
      ? edge.source
      : edge.target.startsWith("door:")
        ? edge.target
        : null;
    const spaceId = edge.source.startsWith("space:")
      ? edge.source
      : edge.target.startsWith("space:")
        ? edge.target
        : null;
    if (!doorId || !spaceId) continue;
    const list = spacesByDoor.get(doorId) ?? [];
    if (!list.includes(spaceId)) list.push(spaceId);
    spacesByDoor.set(doorId, list);
  }
  const out: string[] = [];
  for (const [doorId, spaces] of spacesByDoor) {
    if (spaces.length !== 1) continue;
    out.push(`viz-exit:${doorId}:${spaces[0]!}`);
  }
  return out;
}

function matchesQuery(q: string, ...parts: Array<string | null | undefined>): boolean {
  if (!q) return true;
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q);
}

function itemTitle(item: SelectableItem): string {
  if (item.kind === "space") {
    return item.footprint?.name || item.entity?.name || item.globalId;
  }
  return portalTitle(item);
}

function itemKindLabel(item: SelectableItem): string {
  return item.kind === "space" ? "Region" : portalKindLabel(item);
}

function itemStorey(item: SelectableItem, footprints: FootprintsDocument | null, entities: EntitiesExtract | null): string {
  if (item.kind === "portal") return item.storeyName ?? "Unknown level";
  const storeyId = item.footprint?.storey_global_id ?? item.entity?.storey_global_id ?? null;
  const storeys = footprints?.storeys ?? entities?.storeys ?? [];
  return storeys.find((s) => s.global_id === storeyId)?.name ?? "Unknown level";
}

function itemExcluded(
  item: SelectableItem,
  excludedNodeIds: ReadonlySet<string>,
  excludedEdgeIds: ReadonlySet<string>,
): boolean {
  if (item.kind === "space") {
    const nodeId = item.rawId.startsWith("space:") ? item.rawId : `space:${item.globalId}`;
    return excludedNodeIds.has(nodeId);
  }
  return excludedEdgeIds.has(item.portalId);
}

/**
 * Docked Control tray: search to add, a list of everything selected,
 * inline details on the expanded row, restore for removed items.
 */
export function Inspector() {
  const {
    footprintsDocument,
    entitiesExtract,
    connectivityGraph,
    excludedNodeIds,
    excludedEdgeIds,
    toggleExcludedNode,
    toggleExcludedEdge,
  } = useModelData();
  const {
    selectedElementIds,
    selectElement,
    setSelectedElementIds,
    focusedElementId,
    setFocusedElementId,
    controlPanelOpen,
    setControlPanelOpen,
  } = useViewport();

  const hasModel = Boolean(footprintsDocument || connectivityGraph);
  const expanded = controlPanelOpen;
  const [query, setQuery] = useState("");
  const [browseStoreyId, setBrowseStoreyId] = useState<string | "all">("all");
  const [browseSection, setBrowseSection] = useState<BrowseSection>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [removedOpen, setRemovedOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const prevLastSel = useRef("");
  const searchWrapRef = useRef<HTMLDivElement | null>(null);

  const storeys = useMemo(() => {
    const fromFp = footprintsDocument?.storeys ?? [];
    if (fromFp.length) return fromFp.map((s) => ({ id: s.global_id, name: s.name || s.global_id }));
    return (entitiesExtract?.storeys ?? []).map((s) => ({
      id: s.global_id,
      name: s.name || s.global_id,
    }));
  }, [footprintsDocument, entitiesExtract]);

  const display = useMemo(
    () => (connectivityGraph ? toDisplayGraph(connectivityGraph) : null),
    [connectivityGraph],
  );

  const selectedItems = useMemo(() => {
    const out: SelectableItem[] = [];
    for (const rawId of selectedElementIds) {
      if (rawId.startsWith("portal:")) {
        const portal = resolvePortalItem(rawId, footprintsDocument, connectivityGraph);
        if (portal) out.push(portal);
        continue;
      }
      const globalId = rawId.startsWith("space:") ? rawId.slice("space:".length) : rawId;
      const footprint = footprintsDocument?.spaces.find((s) => s.global_id === globalId) ?? null;
      const entity = entitiesExtract?.spaces.find((s) => s.global_id === globalId) ?? null;
      if (!footprint && !entity) continue;
      out.push({ kind: "space", rawId, globalId, footprint, entity });
    }
    return out;
  }, [selectedElementIds, footprintsDocument, entitiesExtract, connectivityGraph]);

  const liveSelectedCount = useMemo(
    () =>
      selectedItems.filter((item) => !itemExcluded(item, excludedNodeIds, excludedEdgeIds))
        .length,
    [selectedItems, excludedNodeIds, excludedEdgeIds],
  );

  const storeyFilter = browseStoreyId !== "all" ? browseStoreyId : null;

  const catalog = useMemo((): CatalogRow[] => {
    const q = query.trim().toLowerCase();
    const rows: CatalogRow[] = [];
    const wantRegions = browseSection === "all" || browseSection === "region";
    const wantPortals = browseSection !== "region";

    if (wantRegions) for (const s of footprintsDocument?.spaces ?? []) {
      if (s.incomplete || s.polygon.length < 3) continue;
      if (storeyFilter && s.storey_global_id != null && s.storey_global_id !== storeyFilter) continue;
      const rawId = `space:${s.global_id}`;
      const title = s.name || s.global_id;
      const storey =
        footprintsDocument?.storeys?.find((st) => st.global_id === s.storey_global_id)?.name ??
        "Unknown level";
      if (!matchesQuery(q, title, s.global_id, storey)) continue;
      rows.push({
        rawId,
        title,
        subtitle: storey,
        kindLabel: "Region",
        removed: excludedNodeIds.has(rawId),
      });
    }

    if (wantPortals) for (const edge of display?.edges ?? []) {
      const rawId = `portal:${edge.id}`;
      const item = resolvePortalItem(rawId, footprintsDocument, connectivityGraph);
      if (!item) continue;
      const section = portalBrowseSection(item);
      if (browseSection !== "all" && section !== browseSection) continue;
      if (storeyFilter && footprintsDocument) {
        const srcOk =
          !edge.source.startsWith("space:") ||
          footprintsDocument.spaces.some(
            (s) =>
              `space:${s.global_id}` === edge.source &&
              (s.storey_global_id == null || s.storey_global_id === storeyFilter),
          );
        const tgtOk =
          !edge.target.startsWith("space:") ||
          footprintsDocument.spaces.some(
            (s) =>
              `space:${s.global_id}` === edge.target &&
              (s.storey_global_id == null || s.storey_global_id === storeyFilter),
          );
        if (!srcOk && !tgtOk) continue;
      }
      const title = portalTitle(item);
      const subtitle = item.spaceBName
        ? `${item.spaceAName} ↔ ${item.spaceBName}`
        : item.spaceAName;
      if (!matchesQuery(q, title, subtitle, edge.id, portalKindLabel(item))) continue;
      rows.push({
        rawId,
        title,
        subtitle,
        kindLabel: portalKindLabel(item),
        removed: excludedEdgeIds.has(edge.id),
      });
    }

    if (browseSection === "all" || browseSection === "exit") for (const exitId of listExitPortalIds(connectivityGraph)) {
      const rawId = `portal:${exitId}`;
      if (rows.some((r) => r.rawId === rawId)) continue;
      const item = resolvePortalItem(rawId, footprintsDocument, connectivityGraph);
      if (!item) continue;
      if (storeyFilter) {
        const spaceMatch = /^viz-exit:door:[^:]+:space:(.+)$/.exec(exitId);
        const spaceGid = spaceMatch?.[1];
        if (spaceGid) {
          const sp = footprintsDocument?.spaces.find((s) => s.global_id === spaceGid);
          if (sp?.storey_global_id != null && sp.storey_global_id !== storeyFilter) continue;
        }
      }
      const title = portalTitle(item);
      const subtitle = `${item.spaceAName} → Exterior`;
      if (!matchesQuery(q, title, subtitle, exitId)) continue;
      rows.push({
        rawId,
        title,
        subtitle,
        kindLabel: "Exit",
        removed: excludedEdgeIds.has(exitId),
      });
    }

    rows.sort((a, b) => a.title.localeCompare(b.title));
    return rows.slice(0, SEARCH_CAP);
  }, [
    browseSection,
    query,
    footprintsDocument,
    display,
    connectivityGraph,
    excludedNodeIds,
    excludedEdgeIds,
    storeyFilter,
  ]);

  const removedRows = useMemo((): CatalogRow[] => {
    const rows: CatalogRow[] = [];
    for (const id of excludedNodeIds) {
      if (!id.startsWith("space:")) continue;
      const gid = id.slice("space:".length);
      const space = footprintsDocument?.spaces.find((s) => s.global_id === gid);
      rows.push({
        rawId: id,
        title: space?.name || gid,
        subtitle:
          footprintsDocument?.storeys?.find((st) => st.global_id === space?.storey_global_id)
            ?.name ?? "Removed space",
        kindLabel: "Region",
        removed: true,
      });
    }
    for (const id of excludedEdgeIds) {
      const rawId = `portal:${id}`;
      const item = resolvePortalItem(rawId, footprintsDocument, connectivityGraph);
      rows.push({
        rawId,
        title: item ? portalTitle(item) : id,
        subtitle: item
          ? item.spaceBName
            ? `${item.spaceAName} ↔ ${item.spaceBName}`
            : `${item.spaceAName} → Exterior`
          : "Removed connection",
        kindLabel: item ? portalKindLabel(item) : "Connection",
        removed: true,
      });
    }
    rows.sort((a, b) => a.title.localeCompare(b.title));
    return rows;
  }, [excludedNodeIds, excludedEdgeIds, footprintsDocument, connectivityGraph]);

  // Newest pick (plan / graph / search) becomes the expanded row. Only when
  // something is added — deselect must not jump expand/focus to another row.
  const prevSelLen = useRef(0);
  useEffect(() => {
    const last = selectedElementIds[selectedElementIds.length - 1] ?? "";
    if (selectedElementIds.length > prevSelLen.current && last) {
      setExpandedId(last);
    }
    if (!last) setExpandedId(null);
    prevSelLen.current = selectedElementIds.length;
    prevLastSel.current = last;
  }, [selectedElementIds]);

  // Drop stale expansion when an id leaves the selection — do not pick another.
  useEffect(() => {
    if (expandedId && !selectedElementIds.includes(expandedId)) {
      setExpandedId(null);
    }
  }, [selectedElementIds, expandedId]);

  // Push tray hover / expanded row into plan-graph focus. Only when those
  // change — so a plan click can clear focus without this writing it back.
  useEffect(() => {
    setFocusedElementId(hoverId ?? expandedId);
  }, [hoverId, expandedId, setFocusedElementId]);

  // Clicking empty / un-navigable plan clears focus — collapse the tray row too.
  const prevFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevFocusRef.current && focusedElementId === null) {
      setExpandedId(null);
      setHoverId(null);
    }
    prevFocusRef.current = focusedElementId;
  }, [focusedElementId]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!searchWrapRef.current?.contains(e.target as Node)) setSearchOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const selectRaw = (rawId: string) => {
    setSelectedElementIds((prev) => (prev.includes(rawId) ? prev : [...prev, rawId]));
    setExpandedId(rawId);
  };

  const addFromSearch = (rawId: string) => {
    selectRaw(rawId);
    setQuery("");
    setSearchOpen(false);
  };

  const toggleRow = (rawId: string) => {
    setExpandedId((cur) => (cur === rawId ? null : rawId));
  };

  const toggleRouting = (item: SelectableItem) => {
    if (item.kind === "space") {
      const nodeId = item.rawId.startsWith("space:") ? item.rawId : `space:${item.globalId}`;
      const wasExcluded = excludedNodeIds.has(nodeId);
      toggleExcludedNode(nodeId);
      toastExclusionToggle({
        label: exclusionNodeLabel(nodeId, itemTitle(item)),
        wasExcluded,
        kind: "node",
        onUndo: () => toggleExcludedNode(nodeId),
      });
      return;
    }
    const wasExcluded = excludedEdgeIds.has(item.portalId);
    toggleExcludedEdge(item.portalId);
    toastExclusionToggle({
      label: portalTitle(item),
      wasExcluded,
      kind: "edge",
      onUndo: () => toggleExcludedEdge(item.portalId),
    });
  };

  const restoreRaw = (rawId: string) => {
    if (rawId.startsWith("portal:")) {
      const edgeId = rawId.slice("portal:".length);
      if (!excludedEdgeIds.has(edgeId)) return;
      toggleExcludedEdge(edgeId);
      toastExclusionToggle({
        label: rawId,
        wasExcluded: true,
        kind: "edge",
        onUndo: () => toggleExcludedEdge(edgeId),
      });
      return;
    }
    if (!excludedNodeIds.has(rawId)) return;
    toggleExcludedNode(rawId);
    toastExclusionToggle({
      label: exclusionNodeLabel(rawId),
      wasExcluded: true,
      kind: "node",
      onUndo: () => toggleExcludedNode(rawId),
    });
  };

  const removeAllSelected = () => {
    for (const item of selectedItems) {
      if (itemExcluded(item, excludedNodeIds, excludedEdgeIds)) continue;
      toggleRouting(item);
    }
  };

  const clearSelection = () => {
    selectElement(null);
    setExpandedId(null);
  };

  if (!hasModel) return null;

  if (!expanded) {
    return (
      <aside
        aria-label="Control (collapsed)"
        className="flex h-full w-9 shrink-0 flex-col border-l-2 border-input bg-muted"
      >
        <button
          type="button"
          onClick={() => setControlPanelOpen(true)}
          className="flex h-full flex-col items-center gap-2 py-3 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Show control"
        >
          <SlidersHorizontal className="size-3.5" />
          <span
            className="text-[10px] font-medium tracking-wide"
            style={{ writingMode: "vertical-rl" }}
          >
            Control
          </span>
          {liveSelectedCount ? (
            <span className="rounded-full bg-background px-1 text-[10px] tabular-nums text-foreground">
              {liveSelectedCount}
            </span>
          ) : null}
        </button>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Control"
      style={{ width: TRAY_W }}
      className="flex h-full shrink-0 flex-col border-l-2 border-input bg-muted"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        <p className="min-w-0 flex-1 text-[13px] font-semibold text-foreground">Control</p>
        <button
          type="button"
          aria-label="Collapse control"
          onClick={() => setControlPanelOpen(false)}
          className="grid size-6 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Collapse"
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>

      <div ref={searchWrapRef} className="relative shrink-0 px-3 pb-2">
        <div className="mb-1.5 flex gap-1.5">
          <label className="min-w-0 flex-1">
            <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Level
            </span>
            <select
              aria-label="Search level"
              value={browseStoreyId}
              onChange={(e) =>
                setBrowseStoreyId(e.target.value === "all" ? "all" : e.target.value)
              }
              className="h-8 w-full rounded-[4px] border border-border bg-muted/40 px-1.5 text-[11px] text-foreground outline-none focus:border-ring focus:bg-background"
            >
              <option value="all">All levels</option>
              {storeys.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 flex-1">
            <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Category
            </span>
            <select
              aria-label="Search category"
              value={browseSection}
              onChange={(e) => setBrowseSection(e.target.value as BrowseSection)}
              className="h-8 w-full rounded-[4px] border border-border bg-muted/40 px-1.5 text-[11px] text-foreground outline-none focus:border-ring focus:bg-background"
            >
              <option value="all">All types</option>
              <option value="region">Region</option>
              <option value="ifc_door">IFC door</option>
              <option value="door_heal">Door heal</option>
              <option value="space_heal">Space heal</option>
              <option value="exit">Exit</option>
            </select>
          </label>
        </div>
        <label className="relative block">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70"
              aria-hidden
            />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              placeholder="Find space, door, exit…"
              className="h-8 w-full rounded-[4px] border border-border bg-muted/40 pl-7 pr-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-ring focus:bg-background"
            />
        </label>
        {searchOpen ? (
          <ul className="absolute left-3 right-3 z-20 mt-1 max-h-56 overflow-y-auto rounded-[5px] border border-border bg-popover py-1 shadow-md">
            {catalog.length === 0 ? (
              <li className="px-3 py-3 text-[12px] text-muted-foreground">No matches</li>
            ) : (
              catalog.map((row) => {
                const already = selectedElementIds.includes(row.rawId);
                return (
                  <li key={row.rawId}>
                    <button
                      type="button"
                      onClick={() => addFromSearch(row.rawId)}
                      className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-muted/70"
                    >
                      <span className="flex items-center gap-1.5 truncate text-[12px] font-medium text-foreground">
                        <span className="truncate">{row.title}</span>
                        <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
                          {row.kindLabel}
                        </span>
                        {already ? (
                          <span className="shrink-0 text-[10px] text-muted-foreground">In list</span>
                        ) : null}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">{row.subtitle}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5">
        <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
          {selectedItems.length
            ? `${selectedItems.length} selected`
            : "Nothing selected"}
        </p>
        {selectedItems.length ? (
          <>
            <button
              type="button"
              onClick={removeAllSelected}
              className="text-[11px] text-destructive transition-colors hover:underline"
            >
              Remove all
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground hover:underline"
            >
              Clear
            </button>
          </>
        ) : null}
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {selectedItems.length === 0 ? (
          <li className="px-2 py-8 text-center text-[12px] text-muted-foreground">
            Select on the plan or graph, or search above.
          </li>
        ) : (
          selectedItems.map((item) => {
            const open = expandedId === item.rawId;
            const focused = focusedElementId === item.rawId;
            const removed = itemExcluded(item, excludedNodeIds, excludedEdgeIds);
            return (
              <li
                key={item.rawId}
                onMouseEnter={() => setHoverId(item.rawId)}
                onMouseLeave={() => setHoverId(null)}
                className={cn(
                  "mb-0.5 rounded-[5px] border-l-2",
                  focused
                    ? "border-l-[var(--selection)] bg-[color-mix(in_oklch,var(--selection)_22%,transparent)]"
                    : "border-l-transparent hover:bg-muted/40",
                )}
              >
                <div className="flex items-start gap-0.5">
                  <button
                    type="button"
                    onClick={() => toggleRow(item.rawId)}
                    className="flex min-w-0 flex-1 items-start gap-1.5 px-2 py-1.5 text-left"
                  >
                    {open ? (
                      <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12px] font-medium text-foreground">
                          {itemTitle(item)}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {itemKindLabel(item)}
                        </span>
                        {removed ? (
                          <span className="shrink-0 text-[10px] text-destructive">Removed</span>
                        ) : null}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {itemStorey(item, footprintsDocument, entitiesExtract)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label="Deselect"
                    onClick={() => selectElement(item.rawId)}
                    className="mt-1 mr-1 grid size-6 shrink-0 place-items-center rounded-[4px] text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                {open ? (
                  <div className="px-3 pb-2 pl-8">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                      <dt className="text-muted-foreground">Level</dt>
                      <dd className="truncate text-right text-foreground">
                        {itemStorey(item, footprintsDocument, entitiesExtract)}
                      </dd>
                      <dt className="text-muted-foreground">Routing</dt>
                      <dd className="text-right text-foreground">{removed ? "Removed" : "Live"}</dd>
                      {item.kind === "portal" ? (
                        <>
                          <dt className="text-muted-foreground">From</dt>
                          <dd className="truncate text-right text-foreground">{item.spaceAName}</dd>
                          <dt className="text-muted-foreground">To</dt>
                          <dd className="truncate text-right text-foreground">
                            {item.spaceBName ?? "Exterior"}
                          </dd>
                        </>
                      ) : null}
                    </dl>
                    <button
                      type="button"
                      onClick={() => toggleRouting(item)}
                      className="mt-2 text-[12px] font-medium text-destructive hover:underline"
                    >
                      {removed
                        ? item.kind === "space"
                          ? "Restore space"
                          : "Restore connection"
                        : item.kind === "space"
                          ? "Remove space"
                          : "Remove connection"}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })
        )}
      </ul>

      <div className="shrink-0 border-t border-border">
        <button
          type="button"
          onClick={() => setRemovedOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          {removedOpen ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          Removed{removedRows.length ? ` (${removedRows.length})` : ""}
        </button>
        {removedOpen ? (
          <ul className="max-h-40 overflow-y-auto px-2 pb-2">
            {removedRows.length === 0 ? (
              <li className="px-2 py-3 text-[12px] text-muted-foreground">Nothing removed</li>
            ) : (
              removedRows.map((row) => {
                const focused = focusedElementId === row.rawId;
                return (
                <li
                  key={row.rawId}
                  onMouseEnter={() => setHoverId(row.rawId)}
                  onMouseLeave={() => setHoverId(null)}
                  className={cn(
                    "flex items-center gap-1 rounded-[4px] border-l-2 px-2 py-1",
                    focused
                      ? "border-l-[var(--selection)] bg-[color-mix(in_oklch,var(--selection)_22%,transparent)]"
                      : "border-l-transparent",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => selectRaw(row.rawId)}
                    className="min-w-0 flex-1 truncate text-left text-[12px] text-foreground hover:underline"
                    title="Select this removed entity"
                  >
                    {row.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => restoreRaw(row.rawId)}
                    className="shrink-0 text-[11px] text-foreground hover:underline"
                  >
                    Restore
                  </button>
                </li>
                );
              })
            )}
          </ul>
        ) : null}
      </div>
    </aside>
  );
}
