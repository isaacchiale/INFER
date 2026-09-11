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

/**
 * Upload an exported route GLB and get back a URL another device can fetch
 * it from — only reachable while this page is open on this backend (no
 * persistent hosting), and only from a device on the same network as the
 * one serving this page.
 *
 * If this page was itself opened via "localhost"/"127.0.0.1" (the common
 * case when developing on the same machine), a link built from
 * window.location.origin is useless to scan from a phone — the phone would
 * resolve "localhost" to itself, not this computer. The backend reports its
 * own LAN-facing IP; swap that in for the hostname (keeping this page's own
 * scheme/port, since the /api proxy runs on this machine regardless of
 * which address the phone used to reach it).
 */
export async function uploadRouteShare(glb: Blob): Promise<{ shareId: string; url: string }> {
  const response = await fetch(`${apiBase}/route-shares`, {
    method: "POST",
    headers: { "Content-Type": "model/gltf-binary" },
    body: glb,
  });
  if (!response.ok) throw new Error(await readError(response));
  const { share_id: shareId, lan_ip: lanIp } = (await response.json()) as {
    share_id: string;
    lan_ip: string | null;
  };
  const origin =
    LOOPBACK_HOSTNAMES.has(window.location.hostname) && lanIp
      ? `${window.location.protocol}//${lanIp}${window.location.port ? `:${window.location.port}` : ""}`
      : window.location.origin;
  return { shareId, url: `${origin}${apiBase}/route-shares/${shareId}.glb` };
}
