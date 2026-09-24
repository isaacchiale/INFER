import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, GripVertical, X } from "lucide-react";
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

const PANEL_W = 300;
const MARGIN = 16;

type Pos = { left: number; top: number };

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
  portalKind: "door" | "space" | "exit";
  inferred: boolean;
  doorName: string | null;
  doorGlobalId: string | null;
  spaceAName: string;
  spaceBName: string | null;
  storeyName: string | null;
};

type SelectableItem = SpaceItem | PortalItem;
type KindFilter = "space" | "portal";

function clampPos(left: number, top: number, height: number): Pos {
  const maxL = Math.max(MARGIN, window.innerWidth - PANEL_W - MARGIN);
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
  return "Door portal";
}

function portalKindLabel(item: PortalItem): string {
  if (item.portalKind === "exit") return "Exit";
  if (item.portalKind === "space") return "Space connection";
  return item.inferred ? "Door (geometry heal)" : "Door (IFC)";
}

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
  const { selectedElementIds, selectElement } = useViewport();
  const [showRaw, setShowRaw] = useState(false);
  const [index, setIndex] = useState(0);
  const [kindFilter, setKindFilter] = useState<KindFilter>("space");
  /** null = parked at bottom-right; set after a drag ends. */
  const [pos, setPos] = useState<Pos | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const posRef = useRef<Pos | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);

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

  const hasSpaces = allSelectable.some((s) => s.kind === "space");
  const hasPortals = allSelectable.some((s) => s.kind === "portal");
  const mixed = hasSpaces && hasPortals;

  const selectable = useMemo(() => {
    if (!mixed) return allSelectable;
    return allSelectable.filter((s) => s.kind === kindFilter);
  }, [allSelectable, mixed, kindFilter]);

  const selectionKey = allSelectable.map((s) => s.rawId).join("\0");

  useEffect(() => {
    setIndex(0);
    setShowRaw(false);
    // Prefer the kind of the most recently added selection when both exist.
    const last = allSelectable[allSelectable.length - 1];
    if (last) setKindFilter(last.kind);
  }, [selectionKey]); // eslint-disable-line react-hooks/exhaustive-deps -- reset on selection identity only

  useEffect(() => {
    if (index >= selectable.length) setIndex(Math.max(0, selectable.length - 1));
  }, [index, selectable.length]);

  // Closing the popup (or clearing selection) parks it bottom-right again.
  useEffect(() => {
    if (allSelectable.length > 0) return;
    posRef.current = null;
    setPos(null);
  }, [allSelectable.length]);

  useEffect(() => {
    posRef.current = pos;
    const el = panelRef.current;
    if (el) applyPos(el, pos);
  }, [pos]);

  const current = selectable[Math.min(index, Math.max(selectable.length - 1, 0))];
  if (!current) return null;

  const multi = selectable.length > 1;
  const name = current.kind === "space"
    ? current.footprint?.name || current.entity?.name || current.globalId
    : portalTitle(current);
  const storeyLabel =
    current.kind === "space"
      ? (() => {
          const storeyId =
            current.footprint?.storey_global_id ?? current.entity?.storey_global_id ?? null;
          const storeys = footprintsDocument?.storeys ?? entitiesExtract?.storeys ?? [];
          return storeys.find((s) => s.global_id === storeyId)?.name ?? "Unknown storey";
        })()
      : current.storeyName ?? "Unknown storey";

  const onDragPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const next = clampPos(rect.left, rect.top, rect.height);
    posRef.current = next;
    applyPos(panel, next);
    // Drop the default bottom/right Tailwind classes for the drag session.
    panel.classList.remove("bottom-4", "right-4");
    dragRef.current = {
      pointerId: e.pointerId,
      offsetX: e.clientX - next.left,
      offsetY: e.clientY - next.top,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onDragPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || !panel || drag.pointerId !== e.pointerId) return;
    const next = clampPos(
      e.clientX - drag.offsetX,
      e.clientY - drag.offsetY,
      panel.offsetHeight || 120,
    );
    posRef.current = next;
    applyPos(panel, next);
  };

  const onDragPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // One React commit at the end — not per pointermove.
    setPos(posRef.current);
  };

  const close = () => {
    posRef.current = null;
    setPos(null);
    selectElement(null);
  };

  const removeCurrent = () => {
    if (current.kind === "space") {
      const nodeId = current.rawId.startsWith("space:")
        ? current.rawId
        : `space:${current.globalId}`;
      const wasExcluded = excludedNodeIds.has(nodeId);
      toggleExcludedNode(nodeId);
      toastExclusionToggle({
        label: exclusionNodeLabel(nodeId, name),
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
      label: name,
      wasExcluded,
      kind: "edge",
      onUndo: () => toggleExcludedEdge(edgeId),
    });
  };

  const currentExcluded =
    current.kind === "space"
      ? excludedNodeIds.has(
          current.rawId.startsWith("space:") ? current.rawId : `space:${current.globalId}`,
        )
      : excludedEdgeIds.has(current.portalId);

  return (
    <aside
      ref={panelRef}
      aria-label="Selection"
      className={cn(
        "pointer-events-auto fixed z-[60] w-[300px] overflow-hidden rounded-[7px] border border-border bg-popover text-popover-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.18)]",
        pos ? null : "bottom-4 right-4",
      )}
    >
      <div className="flex items-start gap-1.5 border-b border-border/60 p-3">
        <button
          type="button"
          aria-label="Drag selection panel"
          className="mt-0.5 grid size-6 shrink-0 cursor-grab place-items-center rounded-[4px] text-muted-foreground/70 transition-colors hover:bg-muted hover:text-muted-foreground active:cursor-grabbing"
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerUp}
          onPointerCancel={onDragPointerUp}
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-foreground">{name}</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{storeyLabel}</p>
        </div>
        {multi ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              aria-label="Previous selected item"
              disabled={index <= 0}
              onClick={() => {
                setIndex((i) => Math.max(0, i - 1));
                setShowRaw(false);
              }}
              className="grid size-6 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
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
              className="grid size-6 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        ) : null}
        <button
          type="button"
          aria-label="Close selection"
          onClick={close}
          className="grid size-6 shrink-0 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {mixed ? (
        <div className="flex gap-1 border-b border-border/60 px-3 py-2">
          {(
            [
              { key: "space" as const, label: "Spaces" },
              { key: "portal" as const, label: "Portals" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => {
                setKindFilter(tab.key);
                setIndex(0);
                setShowRaw(false);
              }}
              className={cn(
                "rounded-[4px] px-2 py-1 text-[11px] font-medium transition-colors",
                kindFilter === tab.key
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}

      {current.kind === "space" && current.footprint ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border px-3 py-2.5 text-[12px]">
          <Row k="Derived from" v={METHOD_LABEL[current.footprint.method] ?? current.footprint.method} />
          <Row k="Vertices" v={String(current.footprint.polygon.length)} />
          {current.footprint.holes?.length ? (
            <Row k="Holes" v={String(current.footprint.holes.length)} />
          ) : null}
          {current.footprint.incomplete ? <Row k="Status" v="Incomplete geometry" /> : null}
        </dl>
      ) : null}

      {current.kind === "portal" ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border px-3 py-2.5 text-[12px]">
          <Row k="Kind" v={portalKindLabel(current)} />
          {current.doorGlobalId ? <Row k="Door id" v={current.doorGlobalId} /> : null}
          <Row k="From" v={current.spaceAName} />
          {current.spaceBName ? <Row k="To" v={current.spaceBName} /> : <Row k="To" v="Exterior" />}
        </dl>
      ) : null}

      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-[12px]">
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
        <pre className="max-h-48 overflow-auto border-t border-border bg-muted/40 px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
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
