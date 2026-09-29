const apiBase = "/api";

function readErrorFromXhr(xhr: XMLHttpRequest): string {
  const text = xhr.responseText;
  try {
    const json = JSON.parse(text) as { detail?: string };
    if (json.detail) return json.detail;
  } catch {
    /* plain text */
  }
  return text || `Request failed (${xhr.status})`;
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
 *
 * Uses XMLHttpRequest rather than fetch so a large export (real IFC
 * geometry, not just the flat proxy) can report upload progress and be
 * cancelled mid-flight — fetch has no cross-browser upload-progress event.
 * Returns the request immediately paired with an `abort()`; await `done`
 * for the result.
 */
export function uploadRouteShare(
  blob: Blob,
  format: RouteShareFormat = "glb",
  shareId?: string,
  onProgress?: (fraction: number) => void,
): { done: Promise<{ shareId: string; origin: string }>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<{ shareId: string; origin: string }>((resolve, reject) => {
    const query = shareId ? `?share_id=${encodeURIComponent(shareId)}` : "";
    xhr.open("POST", `${apiBase}/route-shares${query}`);
    xhr.setRequestHeader("Content-Type", CONTENT_TYPE_BY_FORMAT[format]);
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(readErrorFromXhr(xhr)));
        return;
      }
      const { share_id: resolvedShareId, lan_ip: lanIp } = JSON.parse(xhr.responseText) as {
        share_id: string;
        ext: string;
        lan_ip: string | null;
      };
      const origin =
        LOOPBACK_HOSTNAMES.has(window.location.hostname) && lanIp
          ? `${window.location.protocol}//${lanIp}${window.location.port ? `:${window.location.port}` : ""}`
          : window.location.origin;
      resolve({ shareId: resolvedShareId, origin });
    };
    xhr.send(blob);
  });
  return { done, abort: () => xhr.abort() };
}

/** The landing URL for a share: redirects iPhones into AR Quick Look (USDZ), everyone else to the GLB. */
export function routeShareUrl(origin: string, shareId: string): string {
  return `${origin}${apiBase}/route-shares/${shareId}`;
}

/**
 * Revoke a share early instead of waiting for it to expire — used both for
 * an explicit "Stop sharing" click and to clean up a share that got half
 * created (GLB uploaded, then the user cancelled before the USDZ finished).
 * Always goes through this device's own backend (not the LAN-IP-swapped
 * origin `routeShareUrl` builds for the phone), since that's who owns the
 * file regardless of which address a phone would use to reach it.
 * Best-effort: a network hiccup here just means the share lingers until the
 * backend's own expiry sweep, not a broken UI state, so this never throws.
 */
export async function deleteRouteShare(shareId: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase}/route-shares/${encodeURIComponent(shareId)}`, {
      method: "DELETE",
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Best-effort sanity check that the share URL actually resolves from here —
 * catches the common failure where the LAN-IP swap in uploadRouteShare
 * picked an address nothing is listening on (wrong interface, VPN active).
 * This still can't prove a *different* device on the network can reach it,
 * only that this one can reach the address it just built — false negatives
 * (a phone on a different subnet) and false positives (this machine reaching
 * itself while a phone still can't) are both possible, so callers should
 * treat a "false" result as a hint to double-check, not a hard failure.
 */
export async function checkRouteShareReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
