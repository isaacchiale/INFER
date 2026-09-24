/**
 * Client-only Cytoscape runtime for the graph pane.
 * Same discipline as That Open: wait for a non-zero container, own resize,
 * destroy once — do not recreate on every React state tick.
 *
 * Node positions stay in layout model space. Viewport zoom/pan (including Fit)
 * never rewrites coordinates or node sizes — only cy.zoom / cy.pan / cy.fit.
 */

import type { Core, ElementDefinition, StylesheetJson } from "cytoscape";
import type { GraphLayout, GraphThemePalette } from "@/lib/graph-layout";
import { graphPalette } from "@/lib/graph-layout";

export type CytoscapeRuntime = {
  setLayout: (layout: GraphLayout, opts?: { fit?: boolean }) => void;
  setPath: (
    pathNodeIds: string[],
    pathEdgeIds?: string[],
    selectedNodeIds?: string[],
    selectedEdgeIds?: string[],
  ) => void;
  setTheme: (theme: "light" | "dark") => void;
  /** Soft-remove / restore edges without rebuilding node positions. */
  setExcludedEdges: (edgeIds: ReadonlySet<string>) => void;
  resize: () => void;
  fit: () => void;
  destroy: () => void;
  onSpaceTap: (handler: (nodeId: string) => void) => void;
  /** Left-click toggle for connections (Inspector / floorplan portal selection). */
  onEdgeTap: (handler: (edgeId: string) => void) => void;
  /** Right-click toggle for spaces / stairs / lifts (including excluded grid). */
  onNodeCxtTap: (handler: (nodeId: string) => void) => void;
  /** Right-click toggle soft-remove / restore for connections. */
  onEdgeCxtTap: (handler: (edgeId: string) => void) => void;
};

function stylesheet(p: GraphThemePalette): StylesheetJson {
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "text-valign": "center",
        "text-halign": "center",
        "font-size": 11,
        "text-wrap": "wrap",
        "text-max-width": "70",
        "background-color": p.spaceFill,
        color: p.spaceLabel,
        "border-width": 1.5,
        "border-color": p.spaceBorder,
        width: 64,
        height: 64,
        "z-index": 10,
      },
    },
    {
      selector: 'node[kind = "label"]',
      style: {
        label: "data(label)",
        "text-valign": "center",
        "text-halign": "left",
        "font-size": 13,
        "font-weight": "bold",
        color: p.label,
        "background-opacity": 0,
        "border-width": 0,
        width: 1,
        height: 1,
        "text-margin-x": 6,
        events: "no",
        "z-index": 5,
      },
    },
    {
      selector: 'node[kind = "space"]',
      style: {
        "background-color": p.spaceFill,
        color: p.spaceLabel,
        "border-color": p.spaceBorder,
        width: 64,
        height: 64,
      },
    },
    {
      selector: 'node[kind = "stair"], node[kind = "lift"]',
      style: {
        shape: "round-rectangle",
        "background-color": p.portalFill,
        color: p.portalLabel,
        "border-color": p.portalBorder,
        "border-width": 1.5,
        width: 80,
        height: 44,
        "font-size": 10,
      },
    },
    {
      // Nested IfcSpace parents — red circle; before onPath so a hop's blue
      // ring wins when the parent is also on the route.
      selector: "node[nestedParent = 1]",
      style: {
        "underlay-color": "#ef4444",
        "underlay-padding": 10,
        "underlay-opacity": 0.55,
        "underlay-shape": "ellipse",
        "z-index": 45,
      },
    },
    {
      // Hop on a calculated route — blue outline ring only (fill unchanged).
      selector: "node[onPath = 1]",
      style: {
        "underlay-color": p.pathUnderlay,
        "underlay-padding": 8,
        "underlay-opacity": 0.55,
        "underlay-shape": "ellipse",
        "z-index": 50,
      },
    },
    {
      // Click selection — sky fill (orthogonal to hop ring).
      selector: "node[selected = 1]",
      style: {
        "background-color": p.selectedFill,
        color: p.selectedLabel,
        "border-color": p.selectedFill,
        "border-width": 2,
        "z-index": 55,
      },
    },
    {
      selector: "node[excluded = 1]",
      style: {
        "background-opacity": 0.45,
        "border-style": "dashed",
        "border-width": 2,
        "border-color": p.disabled,
        opacity: 0.75,
        "z-index": 20,
      },
    },
    {
      // Excluded + selected: keep dashed “removed” look but sky selection wins.
      selector: "node[excluded = 1][selected = 1]",
      style: {
        "background-color": p.selectedFill,
        color: p.selectedLabel,
        "border-color": p.selectedFill,
        "border-style": "dashed",
        "border-width": 2,
        "background-opacity": 0.7,
        opacity: 0.9,
        "z-index": 56,
      },
    },
    {
      selector: "edge",
      style: {
        width: 3.5,
        "line-color": p.edge,
        // Bezier + step-size fans parallel edges (multiple doors between the
        // same two rooms) into distinct curves instead of stacking on one line.
        "curve-style": "bezier",
        "control-point-step-size": 28,
        "target-arrow-shape": "none",
        opacity: p.edgeOpacity,
        "z-index": 1,
        // Enlarge hit target — thin strokes are nearly impossible to right-click.
        "overlay-padding": 14,
        "overlay-opacity": 0,
        events: "yes",
      },
    },
    // Legend channels: IFC door amber, door heal pink, space heal green, stair purple.
    {
      selector: "edge[heal = 'ifc']",
      style: {
        width: 3.25,
        "line-color": p.ifcDoor,
        opacity: 0.95,
        "z-index": 2,
      },
    },
    {
      selector: "edge[heal = 'door']",
      style: {
        width: 3.25,
        "line-color": p.doorHeal,
        opacity: 0.95,
        "z-index": 2,
      },
    },
    {
      selector: "edge[heal = 'space']",
      style: {
        width: 3.25,
        "line-color": p.spaceHeal,
        opacity: 0.95,
        "z-index": 2,
      },
    },
    {
      selector: "edge[heal = 'stair']",
      style: {
        width: 3.25,
        "line-color": p.stairHeal,
        opacity: 0.95,
        "z-index": 2,
      },
    },
    {
      selector: "edge[vertical = 1]",
      style: {
        "line-style": "solid",
        "line-color": p.vertical,
        width: 2.5,
        opacity: p.verticalOpacity,
        "z-index": 1,
      },
    },
    {
      selector: "edge[vertical = 1][heal = 'stair']",
      style: {
        "line-style": "solid",
        "line-color": p.stairHeal,
        width: 2.75,
        opacity: 0.95,
        "z-index": 2,
      },
    },
    {
      selector: "edge[excluded = 1]",
      style: {
        "line-style": "dashed",
        "line-dash-pattern": [8, 6],
        opacity: 0.4,
        width: 3,
        "z-index": 0,
      },
    },
    {
      // Route hop: solid heal-colour underlay + white marching dashes on top.
      selector: "edge[onPath = 1]",
      style: {
        width: 2.75,
        "line-color": "#ffffff",
        "line-style": "dashed",
        "line-dash-pattern": [7, 9],
        "line-dash-offset": 0,
        "underlay-color": p.edge,
        "underlay-padding": 3.5,
        "underlay-opacity": 0.95,
        opacity: 1,
        "z-index": 999,
      },
    },
    {
      selector: "edge[onPath = 1][heal = 'ifc']",
      style: { "underlay-color": p.ifcDoor },
    },
    {
      selector: "edge[onPath = 1][heal = 'door']",
      style: { "underlay-color": p.doorHeal },
    },
    {
      selector: "edge[onPath = 1][heal = 'space']",
      style: { "underlay-color": p.spaceHeal },
    },
    {
      selector: "edge[onPath = 1][heal = 'stair']",
      style: { "underlay-color": p.stairHeal },
    },
    {
      selector: "edge[onPath = 1][vertical = 1]",
      style: { "underlay-color": p.vertical },
    },
    {
      selector: "edge[onPath = 1][vertical = 1][heal = 'stair']",
      style: { "underlay-color": p.stairHeal },
    },
    {
      // Selection uses overlay (not underlay) so it still shows on route hops
      // whose underlay is already the heal colour.
      selector: "edge[selected = 1]",
      style: {
        "overlay-color": p.selectedFill,
        "overlay-padding": 8,
        "overlay-opacity": 0.4,
        "z-index": 1000,
      },
    },
  ];
}

/** Positions in layout model space only — no container bake. */
export function layoutToCyElements(layout: GraphLayout): ElementDefinition[] {
  const elements: ElementDefinition[] = [];
  const nodeSeen = new Set<string>();
  const edgeSeen = new Set<string>();

  for (const node of layout.nodes) {
    if (nodeSeen.has(node.id)) continue;
    nodeSeen.add(node.id);
    elements.push({
      group: "nodes",
      data: {
        id: node.id,
        label: node.label,
        kind: node.kind,
        onPath: 0,
        selected: 0,
        nestedParent: node.nestedParent ? 1 : 0,
        excluded: node.excluded ? 1 : 0,
      },
      position: { x: node.x + node.w / 2, y: node.y + node.h / 2 },
      selectable: node.kind === "space" || Boolean(node.excluded),
      grabbable: false,
    });
  }

  for (const edge of layout.edges) {
    if (edgeSeen.has(edge.id)) continue;
    edgeSeen.add(edge.id);
    elements.push({
      group: "edges",
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        vertical: edge.vertical ? 1 : 0,
        inferred: edge.inferred ? 1 : 0,
        heal: edge.heal ?? "",
        excluded: edge.excluded ? 1 : 0,
        selected: 0,
        onPath: 0,
        /** +1 path flows source→target; −1 target→source; 0 not on path. */
        pathDir: 0,
      },
      selectable: true,
      grabbable: false,
    });
  }

  return elements;
}

function waitForSize(el: HTMLElement, timeoutMs = 4000): Promise<void> {
  const ready = () => el.clientWidth > 80 && el.clientHeight > 120;
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const started = Date.now();
    const ro = new ResizeObserver(() => {
      if (ready()) {
        ro.disconnect();
        resolve();
      }
    });
    ro.observe(el);
    const tick = () => {
      if (ready()) {
        ro.disconnect();
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        ro.disconnect();
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function createCytoscapeRuntime(
  container: HTMLElement,
  theme: "light" | "dark" = "dark",
): Promise<CytoscapeRuntime> {
  await waitForSize(container);

  container.style.width = "100%";
  container.style.height = "100%";

  const mod = await import("cytoscape");
  const cytoscape = mod.default;
  const palette = graphPalette(theme);
  container.style.background = palette.bg;

  const cy: Core = cytoscape({
    container,
    elements: [],
    layout: { name: "preset", fit: false },
    style: stylesheet(palette),
    minZoom: 0.02,
    maxZoom: 6,
    wheelSensitivity: 1.2,
    boxSelectionEnabled: false,
    autoungrabify: true,
    // We own wheel zoom below — Cytoscape's handler no-ops while
    // `scrollingPage` is true (any window scroll), which breaks the graph pane.
    userZoomingEnabled: false,
    pixelRatio: "auto",
  });

  let lastLayout: GraphLayout | null = null;
  let lastWh = { w: 0, h: 0 };
  let userAdjustedView = false;
  let suppressViewFlag = false;
  let fitGeneration = 0;
  /** True after we've fitted with a non-zero container at least once for the current graph. */
  let hasFittedWithSize = false;

  cy.on("pan zoom", () => {
    if (!suppressViewFlag) userAdjustedView = true;
  });

  // Same step as FloorplanViewer — Cytoscape's pow(10, delta/250) was extreme
  // on Windows mice (deltaY ≈ 100 → ~3× per notch).
  const ZOOM_STEP = 1.12;
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.deltaY === 0) return;
    userAdjustedView = true;

    try {
      cy.resize();
      cy.userPanningEnabled(true);
    } catch {
      /* ignore */
    }

    const rect = container.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;

    const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
    const level = Math.min(Math.max(cy.zoom() * factor, cy.minZoom()), cy.maxZoom());
    cy.zoom({
      level,
      renderedPosition: {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      },
    });
  };
  container.addEventListener("wheel", onWheel, { passive: false, capture: true });

  const fitViewport = (): boolean => {
    if (!cy.elements().length) return false;
    if (container.clientWidth < 8 || container.clientHeight < 8) return false;
    suppressViewFlag = true;
    try {
      cy.resize();
      cy.fit(cy.elements(), 48);
      hasFittedWithSize = true;
      return true;
    } finally {
      requestAnimationFrame(() => {
        suppressViewFlag = false;
      });
    }
  };

  /** Replace elements; never changes camera (caller restores or fits). */
  const applyLayoutToCy = (layout: GraphLayout) => {
    const w = Math.max(container.clientWidth, 1);
    const h = Math.max(container.clientHeight, 1);
    lastWh = { w, h };
    const elements = layoutToCyElements(layout);

    suppressViewFlag = true;
    try {
      cy.batch(() => {
        cy.elements().remove();
        if (elements.length) cy.add(elements);
      });
      cy.resize();
    } finally {
      requestAnimationFrame(() => {
        suppressViewFlag = false;
      });
    }
  };

  const resize = () => {
    try {
      const w = container.clientWidth;
      const h = container.clientHeight;
      // Stale container metrics make pan/extents wrong after split resize.
      cy.resize();
      cy.userPanningEnabled(true);
      if (!lastLayout?.nodes.length) {
        lastWh = { w, h };
        return;
      }
      const sizeChanged = Math.abs(w - lastWh.w) > 4 || Math.abs(h - lastWh.h) > 4;
      lastWh = { w, h };
      if (!sizeChanged) return;
      // Graph Viewer mounts parked off-screen at a fixed KEEP_ALIVE size, so the
      // first fit often frames 640×480 — not the real pane. Whenever the
      // container size changes and the user hasn't zoomed/panned yet, re-fit
      // so opening the pane zooms to fit by default.
      if (!userAdjustedView) {
        fitViewport();
      }
    } catch {
      /* ignore */
    }
  };

  const ro = new ResizeObserver(() => resize());
  ro.observe(container);
  window.addEventListener("resize", resize);

  /** Marching dash offset for on-path edges (floorplan-style flow cue). */
  const PATH_DASH_PERIOD = 18;
  let pathDashOffset = 0;
  let pathAnimRaf = 0;
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  const stopPathAnim = () => {
    if (pathAnimRaf) cancelAnimationFrame(pathAnimRaf);
    pathAnimRaf = 0;
    cy.edges().forEach((e) => {
      try {
        e.removeStyle("line-dash-offset");
      } catch {
        /* ignore */
      }
    });
  };

  const startPathAnim = () => {
    if (prefersReducedMotion || pathAnimRaf) return;
    const tick = () => {
      const onPath = cy.edges("[onPath = 1]");
      if (onPath.length === 0) {
        pathAnimRaf = 0;
        return;
      }
      // Negative offset moves dashes source→target in Cytoscape; flip with
      // pathDir so flow always matches the route order (start → end).
      pathDashOffset = (pathDashOffset + 0.65) % PATH_DASH_PERIOD;
      onPath.forEach((e) => {
        const dir = Number(e.data("pathDir")) || 1;
        e.style("line-dash-offset", -dir * pathDashOffset);
      });
      pathAnimRaf = requestAnimationFrame(tick);
    };
    pathAnimRaf = requestAnimationFrame(tick);
  };

  let spaceHandler: ((nodeId: string) => void) | null = null;
  let edgeTapHandler: ((edgeId: string) => void) | null = null;
  let cxtHandler: ((nodeId: string) => void) | null = null;
  let edgeCxtHandler: ((edgeId: string) => void) | null = null;
  cy.on("tap", "node", (evt) => {
    const id = String(evt.target.id());
    if (!id.startsWith("space:")) return;
    // Live and soft-excluded spaces both toggle into the Inspector selection
    // (excluded rooms stay on the canvas so they can be restored from there).
    spaceHandler?.(id);
  });
  cy.on("tap", "edge", (evt) => {
    evt.stopPropagation();
    const id = String(evt.target.id());
    if (!id) return;
    edgeTapHandler?.(id);
  });
  cy.on("cxttap", "node", (evt) => {
    evt.preventDefault();
    const id = String(evt.target.id());
    if (
      !id.startsWith("space:") &&
      !id.startsWith("stair:") &&
      !id.startsWith("lift:")
    ) {
      return;
    }
    cxtHandler?.(id);
  });
  // Prefer edge target; also catch bubbled cxttap when the stroke is hard to hit.
  cy.on("cxttap", "edge", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    const id = String(evt.target.id());
    if (!id) return;
    edgeCxtHandler?.(id);
  });
  // Stop the browser context menu over the canvas (right-click restore/remove).
  container.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });

  return {
    setLayout(layout, opts) {
      lastLayout = layout;
      const shouldFit = opts?.fit === true;
      fitGeneration += 1;
      const gen = fitGeneration;

      if (!layout.nodes.length) {
        cy.elements().remove();
        hasFittedWithSize = false;
        return;
      }

      requestAnimationFrame(() => {
        if (fitGeneration !== gen || lastLayout !== layout) return;

        const prevZoom = cy.zoom();
        const prevPan = { ...cy.pan() };
        const hadElements = cy.elements().length > 0;
        const preserveCamera = hadElements && !shouldFit && userAdjustedView;

        applyLayoutToCy(layout);

        if (shouldFit) {
          userAdjustedView = false;
          hasFittedWithSize = false;
          const tryFit = (attempt: number) => {
            if (fitGeneration !== gen || lastLayout !== layout || userAdjustedView) return;
            if (fitViewport()) return;
            if (attempt < 30) requestAnimationFrame(() => tryFit(attempt + 1));
          };
          tryFit(0);
          return;
        }

        if (preserveCamera || hadElements) {
          // Keep the user's (or previous) camera across element rebuilds.
          suppressViewFlag = true;
          try {
            cy.zoom(prevZoom);
            cy.pan(prevPan);
          } finally {
            requestAnimationFrame(() => {
              suppressViewFlag = false;
            });
          }
          return;
        }

        if (!hasFittedWithSize && !userAdjustedView) {
          const tryFit = (attempt: number) => {
            if (fitGeneration !== gen || userAdjustedView) return;
            if (fitViewport()) return;
            if (attempt < 30) requestAnimationFrame(() => tryFit(attempt + 1));
          };
          tryFit(0);
        }
      });
    },
    setPath(pathNodeIds, pathEdgeIds = [], selectedNodeIds = [], selectedEdgeIds = []) {
      const pathNodes = new Set(pathNodeIds);
      const selected = new Set(selectedNodeIds);
      const selectedEdges = new Set(selectedEdgeIds);
      const displayPath = pathNodeIds.filter(
        (id) =>
          id.startsWith("space:") || id.startsWith("stair:") || id.startsWith("lift:"),
      );
      // Ordered hops only (a→b), not the reverse — drives dash flow direction.
      const flowForward = new Set<string>();
      for (let i = 0; i < displayPath.length - 1; i++) {
        flowForward.add(`${displayPath[i]}|${displayPath[i + 1]}`);
      }
      const edgeIds = new Set(pathEdgeIds);

      cy.batch(() => {
        cy.nodes().forEach((n) => {
          if (n.data("kind") === "label") return;
          const id = n.id();
          n.data("onPath", pathNodes.has(id) ? 1 : 0);
          n.data("selected", selected.has(id) ? 1 : 0);
        });
        cy.edges().forEach((e) => {
          const src = String(e.data("source"));
          const tgt = String(e.data("target"));
          const forward = flowForward.has(`${src}|${tgt}`);
          const reverse = flowForward.has(`${tgt}|${src}`);
          const onPath = edgeIds.has(e.id()) || forward || reverse;
          e.data("onPath", onPath ? 1 : 0);
          e.data("pathDir", forward ? 1 : reverse ? -1 : 0);
          e.data("selected", selectedEdges.has(e.id()) ? 1 : 0);
        });
      });
      if (cy.edges("[onPath = 1]").length > 0) startPathAnim();
      else stopPathAnim();
    },
    setExcludedEdges(edgeIds) {
      cy.batch(() => {
        cy.edges().forEach((e) => {
          e.data("excluded", edgeIds.has(e.id()) ? 1 : 0);
        });
      });
    },
    setTheme(next) {
      const p = graphPalette(next);
      cy.style().fromJson(stylesheet(p)).update();
      container.style.background = p.bg;
    },
    resize,
    fit() {
      userAdjustedView = false;
      hasFittedWithSize = false;
      fitViewport();
    },
    destroy() {
      stopPathAnim();
      container.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("resize", resize);
      ro.disconnect();
      try {
        cy.destroy();
      } catch {
        /* ignore */
      }
    },
    onSpaceTap(handler) {
      spaceHandler = handler;
    },
    onEdgeTap(handler) {
      edgeTapHandler = handler;
    },
    onNodeCxtTap(handler) {
      cxtHandler = handler;
    },
    onEdgeCxtTap(handler) {
      edgeCxtHandler = handler;
    },
  };
}
