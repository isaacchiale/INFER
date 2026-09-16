const apiBase = "/api";

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const json = JSON.parse(text) as { detail?: string };
    if (json.detail) return json.detail;
  } catch {
    /* plain text */
  }
  return text || `Request failed (${response.status})`;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const CONTENT_TYPE_BY_FORMAT = {
  glb: "model/gltf-binary",
  usdz: "model/vnd.usdz+zip",
} as const;

type RouteShareFormat = keyof typeof CONTENT_TYPE_BY_FORMAT;

/**
 * Upload an exported route file (GLB or USDZ) and get back the id another
 * device can fetch it from — only reachable while this page is open on this
 * backend (no persistent hosting), and only from a device on the same
 * network as the one serving this page.
 *
 * Pass `shareId` back in (from a prior upload's result) to attach a second
 * format to the same share — e.g. upload the GLB first, then the USDZ under
 * that same id, so the landing URL built by `routeShareUrl` below can pick
 * between them per-device.
 *
 * If this page was itself opened via "localhost"/"127.0.0.1" (the common
 * case when developing on the same machine), a link built from
 * window.location.origin is useless to scan from a phone — the phone would
 * resolve "localhost" to itself, not this computer. The backend reports its
 * own LAN-facing IP; swap that in for the hostname (keeping this page's own
 * scheme/port, since the /api proxy runs on this machine regardless of
 * which address the phone used to reach it).
 */
export async function uploadRouteShare(
  blob: Blob,
  format: RouteShareFormat = "glb",
  shareId?: string,
): Promise<{ shareId: string; origin: string }> {
  const query = shareId ? `?share_id=${encodeURIComponent(shareId)}` : "";
  const response = await fetch(`${apiBase}/route-shares${query}`, {
    method: "POST",
    headers: { "Content-Type": CONTENT_TYPE_BY_FORMAT[format] },
    body: blob,
  });
  if (!response.ok) throw new Error(await readError(response));
  const { share_id: resolvedShareId, lan_ip: lanIp } = (await response.json()) as {
    share_id: string;
    ext: string;
    lan_ip: string | null;
  };
  const origin =
    LOOPBACK_HOSTNAMES.has(window.location.hostname) && lanIp
      ? `${window.location.protocol}//${lanIp}${window.location.port ? `:${window.location.port}` : ""}`
      : window.location.origin;
  return { shareId: resolvedShareId, origin };
}

/** The landing URL for a share: redirects iPhones into AR Quick Look (USDZ), everyone else to the GLB. */
export function routeShareUrl(origin: string, shareId: string): string {
  return `${origin}${apiBase}/route-shares/${shareId}`;
}
