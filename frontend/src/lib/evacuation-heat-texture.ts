/**
 * Renders the evacuation-load heatmap as an actual continuous field,
 * computed as a Gaussian-weighted average of every sample near each pixel
 * (a small IDW/kernel-density field, done in plain JS — not a canvas
 * blend-mode trick) rather than coloring each room polygon as a flat,
 * hard-edged fill.
 *
 * This went through two designs. The first drew each sample as a soft
 * radial *alpha* blob (value = alpha) and remapped the accumulated alpha
 * through a color ramp — the classic heatmap.js "hotspot density" trick.
 * That's the wrong model here: it conflates "how much data is near this
 * pixel" with "the value at this pixel", so a low-but-real value (a room
 * that's genuinely close to an exit — not "no data") rendered as barely
 * more than transparent, since alpha *was* the value. That's invisible-by-
 * design in a hotspot map (no clicks near here = nothing to show) but
 * wrong for this one: every room has a real status, and "safe-ish" needs
 * to read as a clearly visible green, not a near-transparent one — the bug
 * behind "green doesn't show up" (worse against a dark canvas, but really
 * present in both themes).
 *
 * This version keeps the two concerns separate per pixel — see
 * computeHeatField, which is the pure (canvas-free) core and is unit
 * tested directly in evacuation-heat-texture.test.ts:
 *  - `coverage` = total nearby sample weight (drives how opaque the field
 *    is here — solid within a room's own footprint, fading only in truly
 *    empty space far from every sample, which is *smoothness*, not value).
 *  - `value` = the weighted-average heat value near this pixel (drives
 *    color via the LUT, independent of how opaque the pixel ends up).
 * A pixel near one green sample and nothing else is therefore fully
 * opaque *and* green — not faded — while a pixel between a green room and
 * a red room blends smoothly through the scale's actual intermediate
 * colors as the weighted average shifts, rather than either alpha-stacking
 * two different hues (muddy) or hard-cutting between them.
 *
 * The result is a data URL sized/positioned to exactly match the given
 * world-space bounds, meant to be dropped straight into an SVG <image> at
 * x={bounds.minX} y={bounds.minY} width={bounds.maxX-bounds.minX}
 * height={bounds.maxY-bounds.minY} *inside the same world-space <g>* the
 * rest of the floorplan already renders in (FloorplanViewer wraps
 * everything in one pan/zoom-transformed group) — so it inherits panning
 * and zooming for free, with no separate coordinate sync to maintain, the
 * same way a wall or room polygon does. Texture resolution is deliberately
 * modest (capped well below the previous version) since the field is
 * meant to look soft/blurred anyway, and this is recomputed synchronously
 * on the main thread on every load-data/theme change — kept cheap on
 * purpose, not sent to a worker, per the performance work already done on
 * the actually expensive part of this feature (route/evacuation search).
 */

export type HeatSample = { x: number; y: number; value: number };
export type HeatBounds = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * Canvas 2D's fillStyle/gradient stops accept CSS Color 4 syntax (oklch(),
 * color-mix(), ...) directly — verified against this browser target rather
 * than assumed, since support for that in <canvas> (as opposed to regular
 * CSS) is comparatively recent. That means the app's real heat-scale colors
 * (styles.css --evac-heat-low/--warning/--hazard/--evac-heat-max, oklch and
 * theme-aware — --warning/--hazard shift between light/dark mode) can be
 * read directly off the live DOM via getComputedStyle and hop straight into
 * a canvas gradient with no manual OKLCH math and no hand-maintained second
 * copy of the palette.
 */
// Same 4 stops/positions as FloorplanSvgLayers.tsx's EVACUATION_HEAT_STOPS —
// kept in sync by hand since one lives in an SVG-fill helper and the other
// feeds a canvas gradient, but both need to render the identical scale.
const HEAT_STOP_POSITIONS = [0, 0.33, 0.66, 1] as const;

function resolveHeatColorStops(): [string, string, string, string] {
  if (typeof document === "undefined") {
    // SSR/no-DOM fallback — same 4 values as styles.css's light theme.
    return ["oklch(0.72 0.15 145)", "oklch(0.65 0.13 78)", "oklch(0.55 0.2 22)", "oklch(0.28 0.13 22)"];
  }
  const cs = getComputedStyle(document.documentElement);
  const low = cs.getPropertyValue("--evac-heat-low").trim();
  const warning = cs.getPropertyValue("--warning").trim();
  const hazard = cs.getPropertyValue("--hazard").trim();
  const max = cs.getPropertyValue("--evac-heat-max").trim();
  return [
    low || "oklch(0.72 0.15 145)",
    warning || "oklch(0.65 0.13 78)",
    hazard || "oklch(0.55 0.2 22)",
    max || "oklch(0.28 0.13 22)",
  ];
}

/**
 * A 256-entry RGB lookup table (alpha level -> color), built by asking a
 * throwaway canvas to render the actual gradient once and reading its
 * pixels back — offloading the color-stop interpolation to the browser's
 * own gradient renderer instead of hand-rolling OKLCH blending, the same
 * way evacuationHeatColor offloads it to CSS color-mix().
 */
function buildHeatColorLut(): Uint8ClampedArray {
  const stops = resolveHeatColorStops();
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new Uint8ClampedArray(256 * 4);
  const gradient = ctx.createLinearGradient(0, 0, 256, 0);
  HEAT_STOP_POSITIONS.forEach((position, i) => gradient.addColorStop(position, stops[i]!));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 1);
  return ctx.getImageData(0, 0, 256, 1).data;
}

// A pixel this opaque or more reads as "fully in a room", not faded —
// coverage above this is treated as fully covered rather than climbing to
// literal 1.0, which would need unrealistically many overlapping samples.
const FULL_COVERAGE_WEIGHT = 1.1;
// Ceiling on how opaque the field ever gets — leaves the room's own
// outline/label (drawn on top, see FloorplanSvgLayers.tsx) legible even
// over the hottest, most-covered pixel.
const MAX_FIELD_OPACITY = 0.82;

export type HeatField = {
  width: number;
  height: number;
  /** Weighted-average heat value per pixel, 0..1, row-major. Meaningless where coverage is 0. */
  value: Float32Array;
  /** How much nearby sample weight this pixel has, 0..1, row-major. */
  coverage: Float32Array;
};

/**
 * The pure core of the heat field: no canvas, no colors, no world units —
 * just samples already in pixel space and a Gaussian sigma (also pixels)
 * in, a per-pixel {value, coverage} grid out. Kept separate from
 * renderEvacuationHeatTextureDataUrl specifically so it can be unit tested
 * directly (see evacuation-heat-texture.test.ts) without a canvas
 * implementation — this project's test runner (Node's built-in) has no
 * DOM/canvas available, and the two prior bugs in this feature (alpha
 * encoding the value; the grid-binning optimization potentially excluding
 * a sample near a cell boundary) were both in this exact logic, not in the
 * canvas plumbing around it.
 *
 * Spatially hashes samples into cutoff-sized cells and only checks each
 * pixel's own 3x3 neighborhood of cells, rather than every sample against
 * every pixel — measured ~100ms for the brute-force version against a
 * synthetic 500-sample worst case on a ~220x220 texture; this cuts that
 * roughly in half and scales with local sample density rather than total
 * sample count. See the test file for a brute-force cross-check that this
 * optimization doesn't silently drop samples near a cell boundary.
 */
export function computeHeatField(
  samples: HeatSample[],
  width: number,
  height: number,
  sigma: number,
): HeatField {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const value = new Float32Array(w * h);
  const coverage = new Float32Array(w * h);
  if (samples.length === 0 || sigma <= 0) return { width: w, height: h, value, coverage };

  const sampleXs = new Float64Array(samples.length);
  const sampleYs = new Float64Array(samples.length);
  const sampleValues = new Float64Array(samples.length);
  samples.forEach((s, i) => {
    sampleXs[i] = s.x;
    sampleYs[i] = s.y;
    sampleValues[i] = Math.max(0, Math.min(1, s.value));
  });

  const twoSigmaSq = 2 * sigma * sigma;
  const cutoff = sigma * 3;
  const cutoffSq = cutoff * cutoff;

  const cellSize = Math.max(1, cutoff);
  const gridW = Math.max(1, Math.ceil(w / cellSize));
  const gridH = Math.max(1, Math.ceil(h / cellSize));
  const cellCoords = (px: number, py: number) => ({
    cx: Math.min(gridW - 1, Math.max(0, Math.floor(px / cellSize))),
    cy: Math.min(gridH - 1, Math.max(0, Math.floor(py / cellSize))),
  });
  const grid: number[][] = new Array(gridW * gridH);
  for (let k = 0; k < sampleXs.length; k++) {
    const { cx, cy } = cellCoords(sampleXs[k]!, sampleYs[k]!);
    const cell = cy * gridW + cx;
    (grid[cell] ??= []).push(k);
  }

  for (let y = 0; y < h; y++) {
    const { cy } = cellCoords(0, y);
    for (let x = 0; x < w; x++) {
      const { cx } = cellCoords(x, 0);
      let sumWeight = 0;
      let sumWeightedValue = 0;
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        if (gy < 0 || gy >= gridH) continue;
        for (let gx = cx - 1; gx <= cx + 1; gx++) {
          if (gx < 0 || gx >= gridW) continue;
          const bucket = grid[gy * gridW + gx];
          if (!bucket) continue;
          for (const k of bucket) {
            const dx = x - sampleXs[k]!;
            const dy = y - sampleYs[k]!;
            const distSq = dx * dx + dy * dy;
            if (distSq > cutoffSq) continue;
            const weight = Math.exp(-distSq / twoSigmaSq);
            sumWeight += weight;
            sumWeightedValue += weight * sampleValues[k]!;
          }
        }
      }
      const idx = y * w + x;
      if (sumWeight < 1e-4) continue;
      value[idx] = sumWeightedValue / sumWeight;
      coverage[idx] = Math.min(1, sumWeight / FULL_COVERAGE_WEIGHT);
    }
  }

  return { width: w, height: h, value, coverage };
}

export function renderEvacuationHeatTextureDataUrl(
  samples: HeatSample[],
  bounds: HeatBounds,
  opts: { blobRadius: number; pxPerUnit?: number; maxTexturePx?: number },
): string | null {
  if (typeof document === "undefined" || samples.length === 0) return null;
  const width = Math.max(1e-6, bounds.maxX - bounds.minX);
  const height = Math.max(1e-6, bounds.maxY - bounds.minY);
  // Deliberately low-res: the field is meant to look soft/blurred anyway
  // (the browser's own image scaling when this is stretched into the SVG
  // <image> box does that for free), and every pixel here costs one pass
  // over nearby samples in computeHeatField — keeping this small keeps
  // that cheap.
  const maxTexturePx = opts.maxTexturePx ?? 220;
  const density = Math.min(opts.pxPerUnit ?? 10, maxTexturePx / Math.max(width, height));
  const w = Math.max(1, Math.round(width * density));
  const h = Math.max(1, Math.round(height * density));

  // Canvas rows increase downward from (0,0); mapping world y the same
  // direction (row 0 = bounds.minY) matches how the SVG <image> this feeds
  // will place row 0 at y={bounds.minY} in the same *pre-flip* local
  // coordinate space every wall/room polygon is already authored in — the
  // whole plan (this texture included) gets flipped together by the one
  // ambient scale(1,-1) group, so no separate flip belongs here.
  const pixelSamples: HeatSample[] = samples.map((s) => ({
    x: (s.x - bounds.minX) * density,
    y: (s.y - bounds.minY) * density,
    value: s.value,
  }));
  const sigma = Math.max(1, opts.blobRadius * density * 0.5);
  const field = computeHeatField(pixelSamples, w, h, sigma);

  const canvas = document.createElement("canvas");
  canvas.width = field.width;
  canvas.height = field.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const imageData = ctx.createImageData(field.width, field.height);
  const data = imageData.data;
  const lut = buildHeatColorLut();
  for (let i = 0; i < field.coverage.length; i++) {
    const coverage = field.coverage[i]!;
    if (coverage <= 0) continue;
    const lutIndex = Math.max(0, Math.min(255, Math.round(field.value[i]! * 255))) * 4;
    const idx = i * 4;
    data[idx] = lut[lutIndex]!;
    data[idx + 1] = lut[lutIndex + 1]!;
    data[idx + 2] = lut[lutIndex + 2]!;
    data[idx + 3] = Math.round(coverage * MAX_FIELD_OPACITY * 255);
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL();
}
