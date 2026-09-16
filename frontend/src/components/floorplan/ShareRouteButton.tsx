import { useMemo, useState } from "react";
import { Share2 } from "lucide-react";
import { toast } from "sonner";
import QRCode from "qrcode";
import type { Object3D } from "three";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { exportGLB } from "@/lib/export-glb";
import { exportUSDZ } from "@/lib/export-usdz";
import { buildRouteShareScene, buildDoorOverlay } from "@/lib/route-share-scene";
import { buildExportGroup } from "@/lib/live-scene-export";
import { uploadRouteShare, routeShareUrl } from "@/api/route-shares";
import { useViewerPose, type NavmeshRoute } from "@/state/infer-store";
import type { FootprintsDocument } from "@/types/footprints";

/** Same iPhone-only scope as the backend's UA sniff — iPad's desktop-Safari
 * UA masquerade means it falls back to the GLB download here too. */
function isIPhone(): boolean {
  return /iPhone|iPod/i.test(navigator.userAgent);
}

/**
 * Exports the current click-to-click navmesh route (plus the rooms it
 * passes through, for context) as a standalone GLB — downloadable directly,
 * or hosted at a short-lived backend URL with a QR code so another device
 * on the same network can open the 3D path with no app install.
 */
export function ShareRouteButton({
  navmeshRoute,
  footprintsDocument,
}: {
  navmeshRoute: NavmeshRoute | null;
  footprintsDocument: FootprintsDocument | null;
}) {
  const [open, setOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  const [glbBlob, setGlbBlob] = useState<Blob | null>(null);
  const [usdzBlob, setUsdzBlob] = useState<Blob | null>(null);
  const [usdzUrl, setUsdzUrl] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usedLiveGeometry, setUsedLiveGeometry] = useState(false);

  const { viewerExportRef } = useViewerPose();
  const iPhone = useMemo(() => isIPhone(), []);

  const hasRoute = Boolean(
    navmeshRoute && (navmeshRoute.points?.length || navmeshRoute.segments?.length),
  );

  const openDialog = async () => {
    if (!navmeshRoute || !footprintsDocument) return;
    setOpen(true);
    setBuilding(true);
    setError(null);
    setGlbBlob(null);
    setUsdzBlob(null);
    setUsdzUrl(null);
    setShareUrl(null);
    setQrDataUrl(null);
    setUsedLiveGeometry(false);
    try {
      // Prefer the actual loaded IFC geometry (real wall thickness, real
      // openings, real materials) over the flat-extrusion footprint proxy —
      // only available when the 3D Viewer pane is open and has finished
      // loading an IFC model; null for IndoorGML (no BIM geometry to load)
      // or if that pane is closed, in which case the proxy is still the
      // only option. buildExportGroup silently skips anything it can't
      // safely fetch/rebuild — hasBuildingGeometry tells us whether that
      // left any real content beyond the route tube and fixed lights, so a
      // total failure falls back to the proxy instead of silently sharing
      // an empty room with a tube floating in it.
      const exportableSource = viewerExportRef.current?.();
      let source: Object3D | null = null;
      let liveGeometryUsed = false;
      if (exportableSource) {
        const { group, hasBuildingGeometry } = await buildExportGroup(exportableSource);
        if (hasBuildingGeometry) {
          source = group;
          liveGeometryUsed = true;
        }
      }
      if (!source) {
        // buildRouteShareScene already draws doors itself; the live path
        // doesn't know about footprints/doors at all (it only queries
        // fragments' geometry), so that one needs the overlay added below.
        source = buildRouteShareScene(navmeshRoute, footprintsDocument);
      } else {
        const storeyIds = new Set(
          navmeshRoute.segments?.length
            ? navmeshRoute.segments.map((s) => s.storeyId)
            : [navmeshRoute.storeyId],
        );
        source.add(buildDoorOverlay(footprintsDocument, storeyIds));
      }
      if (!source) {
        setError("This route has no drawable points yet.");
        return;
      }
      setUsedLiveGeometry(liveGeometryUsed);
      // Always build both, regardless of which device this dialog is open
      // on: the "View in AR" button below only matters on an iPhone, but
      // the shareable link/QR is typically generated from a *different*
      // device (a laptop) and then scanned by the iPhone — gating the USDZ
      // export on "is this device an iPhone" would mean it never gets
      // built for that flow, and the scanned link would always fall back
      // to the GLB download. The export itself is cheap, so building it
      // unconditionally costs little.
      const [glb, usdz] = await Promise.all([exportGLB(source), exportUSDZ(source)]);
      setGlbBlob(glb);
      setUsdzBlob(usdz);
      if (iPhone) setUsdzUrl(URL.createObjectURL(usdz));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build the 3D export.");
    } finally {
      setBuilding(false);
    }
  };

  const closeDialog = (next: boolean) => {
    setOpen(next);
    if (!next && usdzUrl) {
      URL.revokeObjectURL(usdzUrl);
      setUsdzUrl(null);
    }
  };

  const download = () => {
    if (!glbBlob) return;
    const url = URL.createObjectURL(glbBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "infer-route.glb";
    a.click();
    URL.revokeObjectURL(url);
  };

  const share = async () => {
    if (!glbBlob) return;
    setSharing(true);
    setError(null);
    try {
      const glbUpload = await uploadRouteShare(glbBlob, "glb");
      if (usdzBlob) {
        // A large export (or a slow/flaky connection) can fail or exceed
        // the backend's upload size limit for the USDZ specifically — that
        // shouldn't take down an otherwise-working GLB share. Worst case,
        // the landing route (route-shares.py) just falls back to the GLB
        // for everyone, iPhone included.
        try {
          await uploadRouteShare(usdzBlob, "usdz", glbUpload.shareId);
        } catch (err) {
          console.warn("Share: USDZ upload failed, continuing with GLB only", err);
        }
      }
      const url = routeShareUrl(glbUpload.origin, glbUpload.shareId);
      setShareUrl(url);
      setQrDataUrl(await QRCode.toDataURL(url, { margin: 1, width: 220 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create a shareable link.");
    } finally {
      setSharing(false);
    }
  };

  const copyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast("Link copied");
    } catch {
      toast("Couldn't copy — copy it manually");
    }
  };

  return (
    <>
      <Button
        size="sm"
        disabled={!hasRoute}
        onClick={openDialog}
        title="Export the current route as a 3D file, or share a link/QR to open it on another device"
        className="bg-[#DC143C] text-white shadow hover:bg-[#c01236] focus-visible:ring-[#DC143C]/50"
      >
        <Share2 className="size-3.5" aria-hidden />
        Share
      </Button>

      <Dialog open={open} onOpenChange={closeDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share this route</DialogTitle>
            <DialogDescription>
              Exports the path and the rooms it passes through as a standalone 3D file.
            </DialogDescription>
          </DialogHeader>

          {building ? (
            <p className="text-sm text-muted-foreground">Building 3D export…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <div className="space-y-4">
              <p className="-mt-2 text-[11px] text-muted-foreground">
                {usedLiveGeometry
                  ? "Using the loaded IFC model's real geometry."
                  : "Using a simplified room-outline proxy — open the 3D Viewer pane and let the model finish loading for a truer export."}
              </p>
              {usdzUrl && (
                <a
                  rel="ar"
                  href={usdzUrl}
                  className="flex h-9 w-full items-center justify-center rounded-[6px] bg-[#DC143C] text-[13px] font-medium text-white shadow transition-colors hover:bg-[#c01236]"
                >
                  View in AR
                </a>
              )}

              <Button variant="outline" className="w-full" disabled={!glbBlob} onClick={download}>
                Download .glb
              </Button>

              {!shareUrl ? (
                <Button className="w-full" disabled={!glbBlob || sharing} onClick={share}>
                  {sharing ? "Creating link…" : "Get shareable link + QR"}
                </Button>
              ) : (
                <div className="space-y-2 rounded-[6px] border border-border p-3">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt="QR code linking to the 3D route"
                      className="mx-auto size-[220px]"
                    />
                  ) : null}
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={shareUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className="min-w-0 flex-1 rounded-[4px] border border-border bg-muted/40 px-2 py-1 text-[11px] text-foreground"
                    />
                    <Button variant="outline" size="sm" onClick={copyLink}>
                      Copy
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Works on a device on the same network as this computer — not a public link. Most
                    Android 3D viewers open .glb directly; on iPhone it opens straight into native AR
                    Quick Look.
                  </p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
