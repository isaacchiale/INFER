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
  ) => void;
  setTheme: (theme: "light" | "dark") => void;
  resize: () => void;
  fit: () => void;
  destroy: () => void;
  onSpaceTap: (handler: (nodeId: string) => void) => void;
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
      selector: "node[onPath = 1]",
      style: {
        "border-width": 5,
        "border-color": p.pathNode,
        "underlay-color": p.pathUnderlay,
        "underlay-padding": 7,
        "underlay-opacity": 0.35,
        "underlay-shape": "ellipse",
        "z-index": 50,
      },
    },
    {
      selector: "edge",
      style: {
        width: 3,
        "line-color": p.edge,
        "curve-style": "bezier",
        "target-arrow-shape": "none",
        opacity: p.edgeOpacity,
        "z-index": 1,
      },
    },
    {
      selector: "edge[vertical = 1]",
      style: {
        "line-style": "dashed",
        "line-color": p.vertical,
        width: 2.5,
        opacity: p.verticalOpacity,
        "z-index": 1,
      },
    },
    {
      selector: "edge[onPath = 1]",
      style: {
        width: 5.5,
        "line-color": p.path,
        "line-style": "solid",
        opacity: 1,
        "z-index": 999,
      },
    },
  ];
}

/** Positions in layout model space only — no container bake. */
export function layoutToCyElements(layout: GraphLayout): ElementDefinition[] {
  const elements: ElementDefinition[] = [];
  const seen = new Set<string>();

  for (const node of layout.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    elements.push({
      group: "nodes",
      data: {
        id: node.id,
        label: node.label,
        kind: node.kind,
        onPath: 0,
      },
      position: { x: node.x + node.w / 2, y: node.y + node.h / 2 },
      selectable: node.kind === "space",
      grabbable: false,
    });
  }

  for (const edge of layout.edges) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    elements.push({
      group: "edges",
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        vertical: edge.vertical ? 1 : 0,
        onPath: 0,
      },
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
  container.addEventListener(
    "wheel",
    () => {
      userAdjustedView = true;
    },
    { passive: true },
  );

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
      // Stale container metrics make wheel zoom no-op until a hard remount/maximize.
      cy.resize();
      cy.userZoomingEnabled(true);
      cy.userPanningEnabled(true);
      if (!lastLayout?.nodes.length) {
        lastWh = { w, h };
        return;
      }
      const sizeChanged = Math.abs(w - lastWh.w) > 4 || Math.abs(h - lastWh.h) > 4;
      lastWh = { w, h };
      if (!sizeChanged) return;
      // Only auto-fit when we never framed a real-sized pane — never fight user zoom/pan.
      if (!userAdjustedView && !hasFittedWithSize) {
        fitViewport();
      }
    } catch {
      /* ignore */
    }
  };

  const ro = new ResizeObserver(() => resize());
  ro.observe(container);
  window.addEventListener("resize", resize);

  let spaceHandler: ((nodeId: string) => void) | null = null;
  cy.on("tap", "node", (evt) => {
    const id = String(evt.target.id());
    if (!id.startsWith("space:")) return;
    spaceHandler?.(id);
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
    setPath(pathNodeIds, pathEdgeIds = [], selectedNodeIds = []) {
      const pathNodes = new Set(pathNodeIds);
      const selected = new Set(selectedNodeIds);
      const displayPath = pathNodeIds.filter(
        (id) =>
          id.startsWith("space:") || id.startsWith("stair:") || id.startsWith("lift:"),
      );
      const consecutive = new Set<string>();
      for (let i = 0; i < displayPath.length - 1; i++) {
        consecutive.add(`${displayPath[i]}|${displayPath[i + 1]}`);
        consecutive.add(`${displayPath[i + 1]}|${displayPath[i]}`);
      }
      const edgeIds = new Set(pathEdgeIds);

      cy.batch(() => {
        cy.nodes().forEach((n) => {
          if (n.data("kind") === "label") return;
          const id = n.id();
          n.data("onPath", pathNodes.has(id) || selected.has(id) ? 1 : 0);
        });
        cy.edges().forEach((e) => {
          const key = `${e.data("source")}|${e.data("target")}`;
          e.data(
            "onPath",
            edgeIds.has(e.id()) || consecutive.has(key) ? 1 : 0,
          );
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
  };
}
