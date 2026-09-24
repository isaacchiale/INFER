import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useModelData, useViewport } from "@/state/infer-store";
import { toDisplayGraph } from "@/lib/graph-layout";
import { doorIdFromVizEdge } from "@/lib/navmesh";
import { toastExclusionToggle, exclusionNodeLabel } from "@/lib/exclusion-toast";
import { cn } from "@/lib/utils";
import type { EntitiesExtract } from "@/api/models";
import type { FootprintsDocument, SpaceFootprint } from "@/types/footprints";
import type { ConnectivityGraph } from "@/types/graph";

const METHOD_LABEL: Record<string, string> = {
  ifc_mesh_xy_outline: "Mesh outline",
  ifc_mesh_xy_hull: "Mesh hull",
  ifc_placement_bbox: "Placement bounding box",
  unavailable: "Unavailable",
};

const BROWSE_W = 260;
const DETAILS_W = 300;
const RAIL_W = 36;
const MINI_W = 168;
const MARGIN = 16;
/** Cap browse list so the panel doesn't tower over the viewport. */
const BROWSE_LIST_MAX_H = 200;

type Pos = { left: number; top: number };
type BrowseSection = "spaces" | "connections" | "exits" | "removed";

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
type BrowseRow = {
  rawId: string;
  title: string;
  subtitle: string;
  removed: boolean;
  kind: "space" | "portal";
};

const SECTION_LABEL: Record<BrowseSection, string> = {
  spaces: "Spaces",
  connections: "Links",
  exits: "Exits",
  removed: "Removed",
};

function clampPos(left: number, top: number, width: number, height: number): Pos {
  const maxL = Math.max(MARGIN, window.innerWidth - width - MARGIN);
  const maxT = Math.max(MARGIN, window.innerHeight - height - MARGIN);
  return {
    left: Math.min(Math.max(MARGIN, left), maxL),
    top: Math.min(Math.max(MARGIN, top), maxT),
  };
}

function applyPos(el: HTMLElement, pos: Pos | null) {
  if (!pos) {
    el.style.left = "";
    el.style.top = "";
    el.style.right = "";
    el.style.bottom = "";
    return;
  }
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
}

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
  if (item.portalKind === "space") return "Space connection";
  if (item.portalKind === "vertical") return "Stair / lift";
  return item.inferred ? "Door (geometry heal)" : "Door (IFC)";
}

/** Exterior doors (exactly one linked space) — same ids as navmesh `viz-exit:…`. */
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

/**
 * Control panel: Browse inventory (spaces / connections / exits / removed) and
 * Details for the current selection — same floating card as the old Inspector.
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
  const { selectedElementIds, selectElement, controlPanelOpen, setControlPanelOpen } =
    useViewport();

  const hasModel = Boolean(footprintsDocument || connectivityGraph);
  const expanded = controlPanelOpen;
  const setExpanded = setControlPanelOpen;

  const [browseSection, setBrowseSection] = useState<BrowseSection>("spaces");
  const [browseStoreyId, setBrowseStoreyId] = useState<string | "all">("all");
  const [browseCollapsed, setBrowseCollapsed] = useState(true);
  const [query, setQuery] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [index, setIndex] = useState(0);
  /** null = parked at bottom-right until first drag / minimize. */
  const [pos, setPos] = useState<Pos | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const posRef = useRef<Pos | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const prevSelectionKey = useRef("");

  const storeys = useMemo(() => {
    const fromFp = footprintsDocument?.storeys ?? [];
    if (fromFp.length) return fromFp.map((s) => ({ id: s.global_id, name: s.name || s.global_id }));
    return (entitiesExtract?.storeys ?? []).map((s) => ({
      id: s.global_id,
      name: s.name || s.global_id,
    }));
  }, [footprintsDocument, entitiesExtract]);

  const panelWidth = expanded
    ? (browseCollapsed ? 0 : BROWSE_W) + DETAILS_W + RAIL_W
    : MINI_W;

  const allSelectable = useMemo(() => {
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

  const selectable = allSelectable;

  const selectionKey = allSelectable.map((s) => s.rawId).join("\0");

  // Plan/graph/browse selection → expand Control and jump Browse to the matching section.
  useEffect(() => {
    if (!selectionKey) {
      prevSelectionKey.current = "";
      return;
    }
    if (selectionKey === prevSelectionKey.current) return;
    prevSelectionKey.current = selectionKey;
    setExpanded(true);
    setShowRaw(false);
    const last = allSelectable[allSelectable.length - 1];
    if (last) {
      setIndex(allSelectable.length - 1);
      if (last.kind === "space") {
        const removed = excludedNodeIds.has(last.rawId);
        setBrowseSection(removed ? "removed" : "spaces");
      } else if (last.portalKind === "exit") {
        const removed = excludedEdgeIds.has(last.portalId);
        setBrowseSection(removed ? "removed" : "exits");
      } else {
        const removed = excludedEdgeIds.has(last.portalId);
        setBrowseSection(removed ? "removed" : "connections");
      }
    }
  }, [selectionKey, allSelectable, setExpanded, excludedNodeIds, excludedEdgeIds]);

  // Keep the active browse row in view when selection changes.
  useEffect(() => {
    if (!expanded || browseCollapsed || !selectionKey) return;
    const focusId =
      selectable[Math.min(index, Math.max(selectable.length - 1, 0))]?.rawId ??
      selectedElementIds[selectedElementIds.length - 1];
    if (!focusId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-browse-id="${CSS.escape(focusId)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [expanded, browseCollapsed, selectionKey, browseSection, index, selectable, selectedElementIds]);

  useEffect(() => {
    if (index >= selectable.length) setIndex(Math.max(0, selectable.length - 1));
  }, [index, selectable.length]);

  useEffect(() => {
    posRef.current = pos;
    const el = panelRef.current;
    if (el) applyPos(el, pos);
  }, [pos]);

  // Remount / expand↔minimize: re-apply saved left/top.
  useEffect(() => {
    const el = panelRef.current;
    if (el) applyPos(el, posRef.current);
  }, [expanded, browseCollapsed]);

  const display = useMemo(
    () => (connectivityGraph ? toDisplayGraph(connectivityGraph) : null),
    [connectivityGraph],
  );

  const storeyFilter = browseStoreyId !== "all" ? browseStoreyId : null;

  const browseRows = useMemo((): BrowseRow[] => {
    const q = query.trim().toLowerCase();
    const rows: BrowseRow[] = [];

    if (browseSection === "spaces" || browseSection === "removed") {
      for (const s of footprintsDocument?.spaces ?? []) {
        if (s.incomplete || s.polygon.length < 3) continue;
        if (
          storeyFilter &&
          s.storey_global_id != null &&
          s.storey_global_id !== storeyFilter
        ) {
          continue;
        }
        const rawId = `space:${s.global_id}`;
        const removed = excludedNodeIds.has(rawId);
        if (browseSection === "removed" && !removed) continue;
        const title = s.name || s.global_id;
        const storey =
          footprintsDocument?.storeys?.find((st) => st.global_id === s.storey_global_id)?.name ??
          "Unknown storey";
        if (!matchesQuery(q, title, s.global_id, storey)) continue;
        rows.push({
          rawId,
          title,
          subtitle: storey,
          removed: browseSection === "removed" ? true : removed,
          kind: "space",
        });
      }
    }

    if (browseSection === "connections" || browseSection === "removed") {
      for (const edge of display?.edges ?? []) {
        const rawId = `portal:${edge.id}`;
        const item = resolvePortalItem(rawId, footprintsDocument, connectivityGraph);
        if (!item) continue;
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
        const removed = excludedEdgeIds.has(edge.id);
        if (browseSection === "removed" && !removed) continue;
        const title = portalTitle(item);
        const subtitle = item.spaceBName
          ? `${item.spaceAName} ↔ ${item.spaceBName}`
          : item.spaceAName;
        if (!matchesQuery(q, title, subtitle, edge.id, portalKindLabel(item))) continue;
        rows.push({
          rawId,
          title,
          subtitle: `${portalKindLabel(item)} · ${subtitle}`,
          removed,
          kind: "portal",
        });
      }
    }

    if (browseSection === "exits" || browseSection === "removed") {
      for (const exitId of listExitPortalIds(connectivityGraph)) {
        const rawId = `portal:${exitId}`;
        const item = resolvePortalItem(rawId, footprintsDocument, connectivityGraph);
        if (!item) continue;
        if (storeyFilter) {
          const spaceMatch = /^viz-exit:door:[^:]+:space:(.+)$/.exec(exitId);
          const spaceGid = spaceMatch?.[1];
          if (spaceGid) {
            const sp = footprintsDocument?.spaces.find((s) => s.global_id === spaceGid);
            if (
              sp?.storey_global_id != null &&
              sp.storey_global_id !== storeyFilter
            ) {
              continue;
            }
          }
        }
        const removed = excludedEdgeIds.has(exitId);
        if (browseSection === "removed" && !removed) continue;
        const title = portalTitle(item);
        const subtitle = `${item.spaceAName} → Exterior`;
        if (!matchesQuery(q, title, subtitle, exitId)) continue;
        if (browseSection === "removed" && rows.some((r) => r.rawId === rawId)) continue;
        rows.push({
          rawId,
          title,
          subtitle,
          removed,
          kind: "portal",
        });
      }
    }

    if (browseSection === "removed") {
      for (const id of excludedNodeIds) {
        if (!id.startsWith("space:")) continue;
        if (rows.some((r) => r.rawId === id)) continue;
        const gid = id.slice("space:".length);
        if (!matchesQuery(q, gid, id)) continue;
        rows.push({
          rawId: id,
          title: gid,
          subtitle: "Removed space",
          removed: true,
          kind: "space",
        });
      }
      for (const id of excludedEdgeIds) {
        const rawId = `portal:${id}`;
        if (rows.some((r) => r.rawId === rawId)) continue;
        if (!matchesQuery(q, id)) continue;
        rows.push({
          rawId,
          title: id,
          subtitle: "Removed connection",
          removed: true,
          kind: "portal",
        });
      }
    }

    rows.sort((a, b) => a.title.localeCompare(b.title));
    return rows;
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

  const removedCount = excludedNodeIds.size + excludedEdgeIds.size;

  const capturePosFromPanel = (heightHint?: number) => {
    const panel = panelRef.current;
    if (!panel) return posRef.current;
    const rect = panel.getBoundingClientRect();
    const next = clampPos(
      rect.left,
      rect.top,
      panelWidth,
      heightHint ?? (rect.height || 40),
    );
    posRef.current = next;
    applyPos(panel, next);
    panel.classList.remove("bottom-4", "right-4");
    return next;
  };

  const onDragPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    e.preventDefault();
    const next = capturePosFromPanel(panel.offsetHeight || 40);
    if (!next) return;
    dragRef.current = {
      pointerId: e.pointerId,
      offsetX: e.clientX - next.left,
      offsetY: e.clientY - next.top,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onDragPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || !panel || drag.pointerId !== e.pointerId) return;
    const next = clampPos(
      e.clientX - drag.offsetX,
      e.clientY - drag.offsetY,
      panelWidth,
      panel.offsetHeight || 40,
    );
    posRef.current = next;
    applyPos(panel, next);
  };

  const onDragPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setPos(posRef.current);
  };

  const minimize = () => {
    const next = capturePosFromPanel(36);
    if (next) setPos(next);
    setExpanded(false);
  };

  const expand = () => {
    setExpanded(true);
  };

  const selectBrowseRow = (rawId: string) => {
    selectElement(rawId);
    setShowRaw(false);
  };

  const current = selectable[Math.min(index, Math.max(selectable.length - 1, 0))];

  const deselectCurrent = () => {
    if (!current) return;
    selectElement(current.rawId);
    setShowRaw(false);
  };

  const removeCurrent = () => {
    if (!current) return;
    if (current.kind === "space") {
      const nodeId = current.rawId.startsWith("space:")
        ? current.rawId
        : `space:${current.globalId}`;
      const wasExcluded = excludedNodeIds.has(nodeId);
      const label =
        current.footprint?.name || current.entity?.name || current.globalId;
      toggleExcludedNode(nodeId);
      toastExclusionToggle({
        label: exclusionNodeLabel(nodeId, label),
        wasExcluded,
        kind: "node",
        onUndo: () => toggleExcludedNode(nodeId),
      });
      return;
    }
    const edgeId = current.portalId;
    const wasExcluded = excludedEdgeIds.has(edgeId);
    toggleExcludedEdge(edgeId);
    toastExclusionToggle({
      label: portalTitle(current),
      wasExcluded,
      kind: "edge",
      onUndo: () => toggleExcludedEdge(edgeId),
    });
  };

  if (!hasModel) return null;

  const detailName = current
    ? current.kind === "space"
      ? current.footprint?.name || current.entity?.name || current.globalId
      : portalTitle(current)
    : "No selection";
  const detailStorey = current
    ? current.kind === "space"
      ? (() => {
          const storeyId =
            current.footprint?.storey_global_id ?? current.entity?.storey_global_id ?? null;
          const storeyList = footprintsDocument?.storeys ?? entitiesExtract?.storeys ?? [];
          return storeyList.find((s) => s.global_id === storeyId)?.name ?? "Unknown storey";
        })()
      : (current.storeyName ?? "Unknown storey")
    : "Select an item from Browse or the plan";

  const currentExcluded = current
    ? current.kind === "space"
      ? excludedNodeIds.has(
          current.rawId.startsWith("space:") ? current.rawId : `space:${current.globalId}`,
        )
      : excludedEdgeIds.has(current.portalId)
    : false;

  const selectedSet = new Set(selectedElementIds);
  const showPager = selectable.length > 1;
  const currentKindLabel = current
    ? current.kind === "space"
      ? "Space"
      : portalKindLabel(current)
    : null;

  // Minimized chip — stays where left; fully draggable.
  if (!expanded) {
    return (
      <aside
        ref={panelRef}
        aria-label="Control panel (minimized)"
        className={cn(
          "pointer-events-auto fixed z-[80] flex h-9 w-[168px] items-center gap-1 rounded-[7px] border border-border bg-muted text-popover-foreground shadow-[0_2px_4px_rgba(0,0,0,0.06),0_12px_28px_-10px_rgba(0,0,0,0.28)]",
          pos ? null : "bottom-4 right-4",
        )}
      >
        <button
          type="button"
          aria-label="Drag control panel"
          className="grid size-7 shrink-0 cursor-grab place-items-center rounded-[4px] text-muted-foreground/70 transition-colors hover:bg-background/80 hover:text-muted-foreground active:cursor-grabbing"
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerUp}
          onPointerCancel={onDragPointerUp}
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={expand}
          className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-[4px] px-1.5 py-1 text-left text-[12px] font-medium text-foreground transition-colors hover:bg-background/80"
          title="Expand control panel"
        >
          <SlidersHorizontal className="size-3.5 shrink-0 opacity-70" aria-hidden />
          <span className="truncate">Control</span>
          {removedCount > 0 ? (
            <span className="ml-auto shrink-0 rounded-full bg-background px-1.5 text-[10px] tabular-nums text-muted-foreground">
              {removedCount}
            </span>
          ) : null}
        </button>
      </aside>
    );
  }

  return (
    <aside
      ref={panelRef}
      aria-label="Control panel"
      style={{ width: panelWidth }}
      className={cn(
        "pointer-events-auto fixed z-[60] flex max-h-[min(58vh,440px)] flex-col overflow-hidden rounded-[7px] border border-border/90 bg-[color-mix(in_oklch,var(--muted)_88%,var(--foreground)_6%)] text-popover-foreground shadow-[0_2px_4px_rgba(0,0,0,0.08),0_16px_36px_-12px_rgba(0,0,0,0.32)]",
        pos ? null : "bottom-4 right-4",
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-[color-mix(in_oklch,var(--muted)_75%,var(--foreground)_8%)] px-2.5 py-2">
        <button
          type="button"
          aria-label="Drag control panel"
          className="grid size-6 shrink-0 cursor-grab place-items-center rounded-[4px] text-muted-foreground/70 transition-colors hover:bg-background/50 hover:text-muted-foreground active:cursor-grabbing"
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerUp}
          onPointerCancel={onDragPointerUp}
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-foreground">Control</p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {selectedElementIds.length
              ? `${selectedElementIds.length} selected`
              : "Nothing selected"}
          </p>
        </div>
        <button
          type="button"
          aria-label="Minimize control panel"
          onClick={minimize}
          className="grid size-6 shrink-0 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-background/50 hover:text-foreground"
          title="Minimize"
        >
          <Minus className="size-3.5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 gap-px bg-border/80 p-px">
        {/* Details — left, raised card */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto rounded-[5px] bg-popover shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          {current && (
            <div className="flex shrink-0 items-center gap-1 border-b border-border/70 bg-muted/50 px-3 py-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                {currentKindLabel}
              </span>
              {showPager ? (
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    aria-label="Previous selected item"
                    disabled={index <= 0}
                    onClick={() => {
                      setIndex((i) => Math.max(0, i - 1));
                      setShowRaw(false);
                    }}
                    className="grid size-6 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronLeft className="size-3.5" />
                  </button>
                  <span className="min-w-[2.5rem] text-center text-[11px] tabular-nums text-muted-foreground">
                    {index + 1}/{selectable.length}
                  </span>
                  <button
                    type="button"
                    aria-label="Next selected item"
                    disabled={index >= selectable.length - 1}
                    onClick={() => {
                      setIndex((i) => Math.min(selectable.length - 1, i + 1));
                      setShowRaw(false);
                    }}
                    className="grid size-6 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronRight className="size-3.5" />
                  </button>
                </div>
              ) : null}
            </div>
          )}

          <div className="flex shrink-0 items-start gap-1 border-b border-border/60 bg-popover px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-foreground">{detailName}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detailStorey}</p>
            </div>
            {current ? (
              <button
                type="button"
                aria-label="Deselect this entity"
                onClick={deselectCurrent}
                className="grid size-6 shrink-0 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Deselect"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>

          {current ? (
            <>
              {current.kind === "space" && current.footprint ? (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2.5 text-[12px]">
                  <Row
                    k="Derived from"
                    v={METHOD_LABEL[current.footprint.method] ?? current.footprint.method}
                  />
                  <Row k="Vertices" v={String(current.footprint.polygon.length)} />
                  {current.footprint.holes?.length ? (
                    <Row k="Holes" v={String(current.footprint.holes.length)} />
                  ) : null}
                  {current.footprint.incomplete ? (
                    <Row k="Status" v="Incomplete geometry" />
                  ) : null}
                  {currentExcluded ? <Row k="Routing" v="Removed" /> : null}
                </dl>
              ) : null}

              {current.kind === "space" && !current.footprint ? (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2.5 text-[12px]">
                  <Row k="Id" v={current.globalId} />
                  {currentExcluded ? <Row k="Routing" v="Removed" /> : null}
                </dl>
              ) : null}

              {current.kind === "portal" ? (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2.5 text-[12px]">
                  <Row k="Kind" v={portalKindLabel(current)} />
                  {current.doorGlobalId ? <Row k="Door id" v={current.doorGlobalId} /> : null}
                  <Row k="From" v={current.spaceAName} />
                  {current.spaceBName ? (
                    <Row k="To" v={current.spaceBName} />
                  ) : (
                    <Row k="To" v="Exterior" />
                  )}
                  {currentExcluded ? <Row k="Routing" v="Removed" /> : null}
                </dl>
              ) : null}

              <div className="mt-auto flex items-center justify-between gap-2 border-t border-border bg-muted/40 px-3 py-2 text-[12px]">
                <button
                  type="button"
                  onClick={() => setShowRaw((v) => !v)}
                  className="text-[12px] text-foreground transition-colors hover:text-primary"
                >
                  Raw data ›
                </button>
                <button
                  type="button"
                  onClick={removeCurrent}
                  className="rounded-[4px] px-2 py-1 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10"
                >
                  {currentExcluded
                    ? current.kind === "space"
                      ? "Restore space"
                      : "Restore connection"
                    : current.kind === "space"
                      ? "Remove space"
                      : "Remove connection"}
                </button>
              </div>

              {showRaw && (
                <pre className="max-h-32 overflow-auto border-t border-border bg-muted/60 px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
                  {JSON.stringify(
                    current.kind === "space"
                      ? (current.footprint ?? current.entity)
                      : {
                          id: current.portalId,
                          kind: current.portalKind,
                          inferred: current.inferred,
                          doorGlobalId: current.doorGlobalId,
                          doorName: current.doorName,
                          spaceA: current.spaceAName,
                          spaceB: current.spaceBName,
                        },
                    null,
                    2,
                  )}
                </pre>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center bg-muted/15 px-3 py-8 text-center text-[12px] text-muted-foreground">
              Select a space or connection on the plan, graph, or browse list.
            </div>
          )}
        </div>

        {/* Browse — right, recessed well */}
        {!browseCollapsed ? (
          <div className="flex w-[260px] shrink-0 flex-col rounded-[5px] bg-[color-mix(in_oklch,var(--muted)_70%,var(--foreground)_5%)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)]">
            <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/80 bg-[color-mix(in_oklch,var(--muted)_55%,var(--foreground)_7%)] px-2.5 py-2">
              <label className="block">
                <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Level
                </span>
                <select
                  value={browseStoreyId}
                  onChange={(e) =>
                    setBrowseStoreyId(e.target.value === "all" ? "all" : e.target.value)
                  }
                  className="h-8 w-full rounded-[4px] border border-border bg-background px-2 text-[12px] text-foreground outline-none focus:border-ring"
                >
                  <option value="all">All levels</option>
                  {storeys.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Category
                </span>
                <select
                  value={browseSection}
                  onChange={(e) => setBrowseSection(e.target.value as BrowseSection)}
                  className="h-8 w-full rounded-[4px] border border-border bg-background px-2 text-[12px] text-foreground outline-none focus:border-ring"
                >
                  <option value="spaces">{SECTION_LABEL.spaces}</option>
                  <option value="connections">{SECTION_LABEL.connections}</option>
                  <option value="exits">{SECTION_LABEL.exits}</option>
                  <option value="removed">
                    {SECTION_LABEL.removed}
                    {removedCount ? ` (${removedCount})` : ""}
                  </option>
                </select>
              </label>
              <label className="relative block">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70"
                  aria-hidden
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  className="h-8 w-full rounded-[4px] border border-border bg-background pl-7 pr-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-ring"
                />
              </label>
            </div>
            <ul
              ref={listRef}
              style={{ maxHeight: BROWSE_LIST_MAX_H }}
              className="min-h-0 overflow-y-auto bg-background py-1 shadow-[inset_0_1px_3px_rgba(0,0,0,0.05)]"
            >
              {browseRows.length === 0 ? (
                <li className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                  {browseSection === "removed" ? "Nothing removed" : "No matches"}
                </li>
              ) : (
                browseRows.map((row) => {
                  const isSelected = selectedSet.has(row.rawId);
                  return (
                    <li key={row.rawId} data-browse-id={row.rawId}>
                      <button
                        type="button"
                        onClick={() => selectBrowseRow(row.rawId)}
                        className={cn(
                          "flex w-full flex-col gap-0.5 border-l-2 px-3 py-1.5 text-left transition-colors",
                          isSelected
                            ? "border-l-[var(--selection)] bg-[color-mix(in_oklch,var(--selection)_16%,var(--background))]"
                            : "border-l-transparent hover:bg-muted/50",
                          row.removed && !isSelected ? "opacity-70" : null,
                        )}
                      >
                        <span className="flex items-center gap-1.5 truncate text-[12px] font-medium text-foreground">
                          <span className="truncate">{row.title}</span>
                          {isSelected ? (
                            <span className="shrink-0 rounded-[3px] bg-[color-mix(in_oklch,var(--selection)_30%,transparent)] px-1 text-[10px] font-medium text-foreground">
                              Selected
                            </span>
                          ) : null}
                          {row.removed ? (
                            <span className="shrink-0 rounded-[3px] bg-destructive/10 px-1 text-[10px] font-medium text-destructive">
                              Removed
                            </span>
                          ) : null}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {row.subtitle}
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
            <p className="shrink-0 border-t border-border/80 bg-[color-mix(in_oklch,var(--muted)_55%,var(--foreground)_7%)] px-2.5 py-1.5 text-[10px] text-muted-foreground">
              {browseRows.length} in list
              {browseStoreyId === "all" ? " · all levels" : ""}
            </p>
          </div>
        ) : null}

        {/* Rail — far right, same control for collapse/expand */}
        <button
          type="button"
          aria-label={browseCollapsed ? "Show browse list" : "Hide browse list"}
          onClick={() => setBrowseCollapsed((v) => !v)}
          className="flex w-9 shrink-0 flex-col items-center gap-2 rounded-[5px] bg-[color-mix(in_oklch,var(--muted)_60%,var(--foreground)_8%)] py-3 text-muted-foreground transition-colors hover:bg-[color-mix(in_oklch,var(--muted)_50%,var(--foreground)_10%)] hover:text-foreground"
          title={browseCollapsed ? "Show browse" : "Hide browse"}
        >
          {browseCollapsed ? (
            <PanelRightOpen className="size-3.5" />
          ) : (
            <PanelRightClose className="size-3.5" />
          )}
          <span
            className="text-[10px] font-medium tracking-wide"
            style={{ writingMode: "vertical-rl" }}
          >
            Browse
          </span>
        </button>
      </div>
    </aside>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="truncate text-right text-foreground">{v}</dd>
    </>
  );
}
