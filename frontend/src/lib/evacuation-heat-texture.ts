/**
 * Renders the evacuation-load heatmap as an actual continuous field —
 * the same two-pass technique real heatmap tools (heatmap.js, WiFi survey
 * apps like the one this feature was modeled on) use, rather than coloring
 * each room polygon as a flat, hard-edged fill:
 *
 * 1. Draw every sample point as a soft radial *alpha* blob (pure black,
 *    alpha = that point's heat value, fading to 0 at the blob's edge) onto a
 *    scratch canvas. Overlapping blobs accumulate more alpha through normal
 *    canvas compositing — that's where "hotter where multiple hot samples
 *    are close together" comes from, for free, with no manual blending math.
 * 2. Remap that accumulated alpha channel through a color ramp built from
 *    the app's own heat-scale tokens (see buildHeatColorLut) instead of
 *    leaving it grayscale — turning "how much alpha piled up here" into
 *    "what color the heat scale says that level is".
 *
 * The result is a data URL sized/positioned to exactly match the given
 * world-space bounds, meant to be dropped straight into an SVG <image> at
 * x={bounds.minX} y={bounds.minY} width={bounds.maxX-bounds.minX}
 * height={bounds.maxY-bounds.minY} *inside the same world-space <g>* the
 * rest of the floorplan already renders in (FloorplanViewer wraps
 * everything in one pan/zoom-transformed group) — so it inherits panning
 * and zooming for free, with no separate coordinate sync to maintain, the
 * same way a wall or room polygon does.
 */

export type HeatSample = { x: number; y: number; value: number };
export type HeatBounds = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * Canvas 2D's fillStyle/gradient stops accept CSS Color 4 syntax (oklch(),
 * color-mix(), ...) directly — verified against this browser target rather
 * than assumed, since support for that in <canvas> (as opposed to regular
 * CSS) is comparatively recent. That means the app's real heat-scale colors
 * (styles.css --evac-heat-low/--evac-heat-mid/--hazard, oklch and
 * theme-aware — --hazard itself shifts between light/dark mode) can be read
 * directly off the live DOM via getComputedStyle and hop straight into a
 * canvas gradient with no manual OKLCH math and no hand-maintained second
 * copy of the palette.
 */
function resolveHeatColorStops(): [string, string, string] {
  if (typeof document === "undefined") {
    // SSR/no-DOM fallback — same 3 values as styles.css's light theme.
    return ["oklch(0.9619 0.058 95.62)", "oklch(0.7049 0.1867 47.6)", "oklch(0.55 0.2 22)"];
  }
  const cs = getComputedStyle(document.documentElement);
  const low = cs.getPropertyValue("--evac-heat-low").trim();
  const mid = cs.getPropertyValue("--evac-heat-mid").trim();
  const hi = cs.getPropertyValue("--hazard").trim();
  return [
    low || "oklch(0.9619 0.058 95.62)",
    mid || "oklch(0.7049 0.1867 47.6)",
    hi || "oklch(0.55 0.2 22)",
  ];
}

/**
 * A 256-entry RGB lookup table (alpha level -> color), built by asking a
 * throwaway canvas to render the actual gradient once and reading its
 * pixels back — offloading the low/mid/high color-stop interpolation to the
 * browser's own gradient renderer instead of hand-rolling OKLCH blending,
 * the same way evacuationHeatColor offloads it to CSS color-mix().
 */
function buildHeatColorLut(): Uint8ClampedArray {
  const [low, mid, hi] = resolveHeatColorStops();
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new Uint8ClampedArray(256 * 4);
  const gradient = ctx.createLinearGradient(0, 0, 256, 0);
  gradient.addColorStop(0, low);
  gradient.addColorStop(0.5, mid);
  gradient.addColorStop(1, hi);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 1);
  return ctx.getImageData(0, 0, 256, 1).data;
}

export function renderEvacuationHeatTextureDataUrl(
  samples: HeatSample[],
  bounds: HeatBounds,
  opts: { blobRadius: number; pxPerUnit?: number; maxTexturePx?: number },
): string | null {
  if (typeof document === "undefined" || samples.length === 0) return null;
  const width = Math.max(1e-6, bounds.maxX - bounds.minX);
  const height = Math.max(1e-6, bounds.maxY - bounds.minY);
  const maxTexturePx = opts.maxTexturePx ?? 1024;
  const density = Math.min(opts.pxPerUnit ?? 24, maxTexturePx / Math.max(width, height));
  const w = Math.max(1, Math.round(width * density));
  const h = Math.max(1, Math.round(height * density));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const blobRadiusPx = Math.max(4, opts.blobRadius * density);
  for (const s of samples) {
    const px = (s.x - bounds.minX) * density;
    // Canvas rows increase downward from (0,0); mapping world y the same
    // direction (row 0 = bounds.minY) matches how the SVG <image> this feeds
    // will place row 0 at y={bounds.minY} in the same *pre-flip* local
    // coordinate space every wall/room polygon is already authored in — the
    // whole plan (this texture included) gets flipped together by the one
    // ambient scale(1,-1) group, so no separate flip belongs here.
    const py = (s.y - bounds.minY) * density;
    const value = Math.max(0, Math.min(1, s.value));
    const gradient = ctx.createRadialGradient(px, py, 0, px, py, blobRadiusPx);
    gradient.addColorStop(0, `rgba(0,0,0,${value})`);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(px, py, blobRadiusPx, 0, Math.PI * 2);
    ctx.fill();
  }

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const lut = buildHeatColorLut();
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]!;
    if (alpha === 0) continue;
    const lutIndex = alpha * 4;
    data[i] = lut[lutIndex]!;
    data[i + 1] = lut[lutIndex + 1]!;
    data[i + 2] = lut[lutIndex + 2]!;
    // Boost off the floor so one faint, isolated sample stays visible
    // instead of reading as almost-transparent — accumulated alpha from
    // overlapping samples still comes through above this floor.
    data[i + 3] = Math.min(255, alpha + 40);
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL();
}
