/**
 * Client-only Cytoscape runtime for the graph pane.
 * Same discipline as That Open: wait for a non-zero container, own resize,
 * destroy once — do not recreate on every React state tick.
 *
 * Framing preserves a minimum node margin; large graphs overflow the pane
 * and are explored via pan/zoom instead of being squeezed until nodes collide.
 */

import type { Core, ElementDefinition, StylesheetJson } from "cytoscape";
import type { GraphLayout, GraphThemePalette } from "@/lib/graph-layout";
import { graphPalette, LAYOUT_NODE_W } from "@/lib/graph-layout";

export type CytoscapeRuntime = {
  setLayout: (layout: GraphLayout) => void;
  setPath: (pathNodeIds: string[], pathEdgeIds?: string[]) => void;
  setTheme: (theme: "light" | "dark") => void;
  resize: () => void;
  fit: () => void;
  destroy: () => void;
  onSpaceTap: (handler: (nodeId: string) => void) => void;
};

/** Minimum center-to-center spacing in screen pixels after framing. */
const MIN_NODE_MARGIN_PX = LAYOUT_NODE_W + 28;

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
        width: 1.5,
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
        width: 1.25,
        opacity: p.verticalOpacity,
        "z-index": 1,
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

type Frame = { scale: number; ox: number; oy: number };

/**
 * Uniform scale that fits when possible, but never shrinks below
 * MIN_NODE_MARGIN_PX center spacing (graph may overflow → pan/zoom).
 */
function frameForContainer(
  layout: GraphLayout,
  containerW: number,
  containerH: number,
  padding = 32,
): Frame {
  const content = layout.nodes.filter((n) => n.kind !== "label");
  const use = content.length ? content : layout.nodes;
  if (!use.length || containerW < 4 || containerH < 4) {
    return { scale: 1, ox: 0, oy: 0 };
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

  const fitScale = Math.min((containerW - padding * 2) / bw, (containerH - padding * 2) / bh);
  const cell = Math.min(layout.cellW || LAYOUT_NODE_W + 56, layout.cellH || LAYOUT_NODE_W + 48);
  const minScaleForSpacing = MIN_NODE_MARGIN_PX / cell;
  // Prefer readable spacing over forcing everything into the pane.
  const scale = Math.max(fitScale, minScaleForSpacing);

  const contentW = bw * scale;
  const contentH = bh * scale;
  const ox = (containerW - contentW) / 2 - scale * minX;
  const oy = (containerH - contentH) / 2 - scale * minY;
  return { scale, ox, oy };
}

export function layoutToCyElements(
  layout: GraphLayout,
  frame: Frame = { scale: 1, ox: 0, oy: 0 },
): ElementDefinition[] {
  const elements: ElementDefinition[] = [];
  const seen = new Set<string>();
  const { scale, ox, oy } = frame;

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
        onPath: 0,
      },
      position: { x: ox + scale * cx, y: oy + scale * cy },
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
    minZoom: 0.15,
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
    const frame = frameForContainer(layout, w, h, 32);
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
      const p = graphPalette(next);
      cy.style().fromJson(stylesheet(p)).update();
      container.style.background = p.bg;
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
