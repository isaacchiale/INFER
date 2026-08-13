/**
 * Client-only Cytoscape runtime for the graph pane.
 * Same discipline as That Open: wait for a non-zero container, own resize,
 * destroy once — do not recreate on every React state tick.
 *
 * Initial framing: bake scale/translate into preset positions so zoom=1
 * already fills the pane (cy.fit has been unreliable in the split layout).
 */

import type { Core, ElementDefinition, StylesheetJson } from "cytoscape";
import type { GraphLayout, GraphThemePalette } from "@/lib/graph-layout";
import { graphPalette } from "@/lib/graph-layout";

export type CytoscapeRuntime = {
  setLayout: (layout: GraphLayout) => void;
  setPath: (pathNodeIds: string[], pathEdgeIds?: string[]) => void;
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
        color: p.nodeLabel,
        "background-color": "#60a5fa",
        "border-width": 2,
        "border-color": p.nodeBorder,
        width: 64,
        height: 64,
        "text-wrap": "wrap",
        "text-max-width": "90",
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
      },
    },
    {
      selector: 'node[kind = "space"]',
      style: {
        "background-color": "data(color)",
        width: 64,
        height: 64,
      },
    },
    {
      selector: 'node[kind = "stair"], node[kind = "lift"]',
      style: {
        shape: "round-rectangle",
        "background-color": "data(color)",
        color: "#ffffff",
        width: 80,
        height: 44,
      },
    },
    {
      selector: "node[onPath = 1]",
      style: {
        "border-width": 4,
        "border-color": p.path,
      },
    },
    {
      selector: "edge",
      style: {
        width: 2,
        "line-color": p.edge,
        "curve-style": "bezier",
        "target-arrow-shape": "none",
        opacity: 0.85,
      },
    },
    {
      selector: "edge[vertical = 1]",
      style: {
        "line-style": "dashed",
        "line-color": p.vertical,
        width: 2.5,
      },
    },
    {
      selector: "edge[onPath = 1]",
      style: {
        width: 5,
        "line-color": p.path,
        "line-style": "solid",
        opacity: 1,
        "z-index": 999,
      },
    },
  ];
}

type Frame = { scaleX: number; scaleY: number; ox: number; oy: number };

/** Map layout coords into the container so the graph fills width AND height at zoom=1. */
function frameForContainer(
  layout: GraphLayout,
  containerW: number,
  containerH: number,
  padding = 28,
): Frame {
  const content = layout.nodes.filter((n) => n.kind !== "label");
  // Prefer rooms/portals for framing, but fall back to all nodes.
  const use = content.length ? content : layout.nodes;
  if (!use.length || containerW < 4 || containerH < 4) {
    return { scaleX: 1, scaleY: 1, ox: 0, oy: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of use) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  // Independent axes so a tall storey stack still uses the full pane width.
  const scaleX = (containerW - padding * 2) / bw;
  const scaleY = (containerH - padding * 2) / bh;
  const ox = padding - scaleX * minX;
  const oy = padding - scaleY * minY;
  return { scaleX, scaleY, ox, oy };
}

export function layoutToCyElements(
  layout: GraphLayout,
  frame: Frame = { scaleX: 1, scaleY: 1, ox: 0, oy: 0 },
): ElementDefinition[] {
  const elements: ElementDefinition[] = [];
  const seen = new Set<string>();
  const { scaleX, scaleY, ox, oy } = frame;

  for (const node of layout.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const cx = node.x + node.w / 2;
    const cy = node.y + node.h / 2;
    elements.push({
      group: "nodes",
      data: {
        id: node.id,
        label: node.label,
        kind: node.kind,
        color: node.color === "transparent" ? "#000000" : node.color,
        onPath: 0,
      },
      position: { x: ox + scaleX * cx, y: oy + scaleY * cy },
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
  // Prefer a real pane size, not the old min-h 200px trap.
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

  const cy: Core = cytoscape({
    container,
    elements: [],
    layout: { name: "preset", fit: false },
    style: stylesheet(palette),
    minZoom: 0.2,
    maxZoom: 8,
    wheelSensitivity: 1.4,
    boxSelectionEnabled: false,
    autoungrabify: true,
    pixelRatio: "auto",
  });

  let lastLayout: GraphLayout | null = null;
  let lastWh = { w: 0, h: 0 };
  let userAdjustedView = false;
  let suppressViewFlag = false;

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

  const applyLayoutToCy = (layout: GraphLayout) => {
    const w = Math.max(container.clientWidth, 1);
    const h = Math.max(container.clientHeight, 1);
    lastWh = { w, h };
    const frame = frameForContainer(layout, w, h, 24);
    const elements = layoutToCyElements(layout, frame);

    suppressViewFlag = true;
    try {
      cy.batch(() => {
        cy.elements().remove();
        if (elements.length) cy.add(elements);
      });
      cy.resize();
      cy.zoom(1);
      cy.pan({ x: 0, y: 0 });
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
      cy.resize();
      if (!lastLayout?.nodes.length) {
        lastWh = { w, h };
        return;
      }
      // Pane grew/shrunk (split drag or flex finally resolving) — always re-fill.
      if (Math.abs(w - lastWh.w) > 4 || Math.abs(h - lastWh.h) > 4) {
        lastWh = { w, h };
        userAdjustedView = false;
        applyLayoutToCy(lastLayout);
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
    setLayout(layout) {
      lastLayout = layout;
      userAdjustedView = false;
      if (!layout.nodes.length) {
        cy.elements().remove();
        return;
      }
      // Wait a frame so the panel has its real size after ingest / split settle.
      requestAnimationFrame(() => {
        cy.resize();
        applyLayoutToCy(layout);
        requestAnimationFrame(() => {
          if (!userAdjustedView && lastLayout === layout) {
            cy.resize();
            applyLayoutToCy(layout);
          }
        });
      });
    },
    setPath(pathNodeIds, pathEdgeIds = []) {
      const pathNodes = new Set(pathNodeIds);
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
          n.data("onPath", pathNodes.has(n.id()) ? 1 : 0);
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
      cy.style().fromJson(stylesheet(graphPalette(next))).update();
      container.style.background = graphPalette(next).bg;
    },
    resize,
    fit() {
      userAdjustedView = false;
      if (lastLayout && lastLayout.nodes.length) applyLayoutToCy(lastLayout);
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
