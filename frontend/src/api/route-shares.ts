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

/**
 * Upload an exported route GLB and get back a URL another device can fetch
 * it from — only reachable while this page is open on this backend (no
 * persistent hosting), and only from a device on the same network as the
 * one serving this page.
 */
export async function uploadRouteShare(glb: Blob): Promise<{ shareId: string; url: string }> {
  const response = await fetch(`${apiBase}/route-shares`, {
    method: "POST",
    headers: { "Content-Type": "model/gltf-binary" },
    body: glb,
  });
  if (!response.ok) throw new Error(await readError(response));
  const { share_id: shareId } = (await response.json()) as { share_id: string };
  return { shareId, url: `${window.location.origin}${apiBase}/route-shares/${shareId}.glb` };
}
