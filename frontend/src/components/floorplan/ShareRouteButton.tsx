import { useMemo, useRef, useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";
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
import { buildRouteShareScene } from "@/lib/route-share-scene";
import { buildRouteArrows, collectRouteTubes } from "@/lib/route-arrows";
import { buildExportGroup, buildRouteStoreyClipBands } from "@/lib/live-scene-export";
import {
  uploadRouteShare,
  routeShareUrl,
  deleteRouteShare,
  checkRouteShareReachable,
} from "@/api/route-shares";
import { useViewerPose, type NavmeshRoute } from "@/state/infer-store";
import type { FootprintsDocument } from "@/types/footprints";

/** Same iPhone-only scope as the backend's UA sniff — iPad's desktop-Safari
 * UA masquerade means it falls back to the GLB download here too. */
function isIPhone(): boolean {
  return /iPhone|iPod/i.test(navigator.userAgent);
}

/** What building the export + creating a share link produced for one route,
 * kept across a dialog close/reopen so re-checking a link you already
 * generated doesn't re-export and re-upload the same route from scratch.
 * Keyed by object identity: a genuinely new route (a fresh object from the
 * router) invalidates it naturally without needing an explicit id/hash. */
type ShareCache = {
  route: NavmeshRoute;
  glbBlob: Blob;
  usdzBlob: Blob | null;
  usedLiveGeometry: boolean;
  shareId: string | null;
  shareUrl: string | null;
  qrDataUrl: string | null;
  reachabilityWarning: boolean;
};

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
  const [shareId, setShareId] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usedLiveGeometry, setUsedLiveGeometry] = useState(false);
  const [reachabilityWarning, setReachabilityWarning] = useState(false);
  const [copied, setCopied] = useState(false);

  const { viewerExportRef, viewerModelBounds, viewerCoordInverse } = useViewerPose();
  const iPhone = useMemo(() => isIPhone(), []);
  const cacheRef = useRef<ShareCache | null>(null);
  const abortUploadRef = useRef<(() => void) | null>(null);
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasRoute = Boolean(
    navmeshRoute && (navmeshRoute.points?.length || navmeshRoute.segments?.length),
  );

  const openDialog = async () => {
    if (!navmeshRoute || !footprintsDocument) return;
    setOpen(true);
    setError(null);

    // Reopening for the exact same route object (e.g. just to re-check or
    // re-copy a link already generated) reuses the prior export/share
    // instead of rebuilding and re-uploading from scratch.
    const cached = cacheRef.current;
    if (cached && cached.route === navmeshRoute) {
      setBuilding(false);
      setGlbBlob(cached.glbBlob);
      setUsdzBlob(cached.usdzBlob);
      setUsedLiveGeometry(cached.usedLiveGeometry);
      setShareId(cached.shareId);
      setShareUrl(cached.shareUrl);
      setQrDataUrl(cached.qrDataUrl);
      setReachabilityWarning(cached.reachabilityWarning);
      setUsdzUrl(iPhone && cached.usdzBlob ? URL.createObjectURL(cached.usdzBlob) : null);
      return;
    }

    setBuilding(true);
    setGlbBlob(null);
    setUsdzBlob(null);
    setUsdzUrl(null);
    setShareId(null);
    setShareUrl(null);
    setQrDataUrl(null);
    setUsedLiveGeometry(false);
    setReachabilityWarning(false);
    try {
      // Prefer the actual loaded IFC geometry (real wall thickness, real
      // openings, real materials) over the flat-extrusion footprint proxy —
      // only available when the 3D Viewer pane is open and has finished
      // loading an IFC model; null for IndoorGML (no BIM geometry to load)
      // or if that pane is closed, in which case the proxy is still the
      // only option. buildExportGroup silently skips anything it can't
      // safely fetch/rebuild — hasBuildingGeometry tells us whether that
      // left any real content beyond the route tube, so a
      // total failure falls back to the proxy instead of silently sharing
      // an empty room with a tube floating in it.
      // Storeys the route actually touches — scopes the live geometry export
      // to just those storeys, not whatever the 3D Viewer's own storey
      // filter currently shows (see buildRouteStoreyClipBands's doc comment).
      const storeyIds = new Set(
        navmeshRoute.segments?.length
          ? navmeshRoute.segments.map((s) => s.storeyId)
          : [navmeshRoute.storeyId],
      );

      const exportableSource = viewerExportRef.current?.();
      let source: Object3D | null = null;
      let liveGeometryUsed = false;
      if (exportableSource) {
        const clipBands = buildRouteStoreyClipBands({
          footprints: footprintsDocument,
          storeyIds,
          modelBounds: viewerModelBounds,
          coordInverse: viewerCoordInverse,
        });
        const { group, hasBuildingGeometry, stats } = await buildExportGroup(
          exportableSource,
          clipBands,
        );
        if (hasBuildingGeometry) {
          source = group;
          liveGeometryUsed = true;
        } else {
          console.warn("Share export: live IFC geometry empty, falling back to footprint proxy", {
            ...stats,
            clipBands,
            storeyIds: [...storeyIds],
          });
        }
      } else {
        console.info("Share export: 3D Viewer not loaded, using footprint proxy");
      }
      // The live path adds nothing on top of the model's own geometry: its
      // real IFC doors are already in it, and an overlay placed with the
      // proxy's plan->Three convention floated above the floor on models
      // whose placement differs (seen on a phone as stray orange "walls").
      if (!source) source = buildRouteShareScene(navmeshRoute, footprintsDocument);
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
      // Direction cue: chevrons gliding along the tube. The live path's tube
      // is rebuilt as plain geometry in the export, so its curve comes from
      // the live tube objects; the proxy scene still holds TubeGeometry.
      const tubeRoots =
        liveGeometryUsed && exportableSource ? exportableSource.plainObjects : [source];
      const arrows = buildRouteArrows(collectRouteTubes(tubeRoots));
      if (arrows) source.add(arrows.group);
      const clips = arrows ? [arrows.clip] : [];
      const [glb, usdz] = await Promise.all([exportGLB(source, clips), exportUSDZ(source, clips)]);
      setGlbBlob(glb);
      setUsdzBlob(usdz);
      if (iPhone) setUsdzUrl(URL.createObjectURL(usdz));
      cacheRef.current = {
        route: navmeshRoute,
        glbBlob: glb,
        usdzBlob: usdz,
        usedLiveGeometry: liveGeometryUsed,
        shareId: null,
        shareUrl: null,
        qrDataUrl: null,
        reachabilityWarning: false,
      };
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
    setUploadProgress(0);
    // Weighted by bytes across both uploads so the bar reflects total
    // transfer progress, not "upload 1 of 2 done" jumping straight to 50%
    // when the GLB and USDZ are very different sizes.
    const totalBytes = glbBlob.size + (usdzBlob?.size ?? 0);
    let glbBytesSent = 0;
    let usdzBytesSent = 0;
    let uploadedShareId: string | null = null;
    const reportProgress = () => {
      setUploadProgress(totalBytes ? (glbBytesSent + usdzBytesSent) / totalBytes : 1);
    };
    try {
      const glbUpload = uploadRouteShare(glbBlob, "glb", undefined, (fraction) => {
        glbBytesSent = fraction * glbBlob.size;
        reportProgress();
      });
      abortUploadRef.current = glbUpload.abort;
      const glbResult = await glbUpload.done;
      uploadedShareId = glbResult.shareId;
      if (usdzBlob) {
        // A large export (or a slow/flaky connection) can fail or exceed
        // the backend's upload size limit for the USDZ specifically — that
        // shouldn't take down an otherwise-working GLB share. Worst case,
        // the landing route (route-shares.py) just falls back to the GLB
        // for everyone, iPhone included.
        try {
          const usdzUpload = uploadRouteShare(usdzBlob, "usdz", glbResult.shareId, (fraction) => {
            usdzBytesSent = fraction * usdzBlob.size;
            reportProgress();
          });
          abortUploadRef.current = usdzUpload.abort;
          await usdzUpload.done;
        } catch (err) {
          // A user-initiated cancel here must still cancel the whole share —
          // only a genuine USDZ failure (network error, size limit) should
          // fall back to a GLB-only share while swallowing the error.
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          console.warn("Share: USDZ upload failed, continuing with GLB only", err);
        }
      }
      const url = routeShareUrl(glbResult.origin, glbResult.shareId);
      const qr = await QRCode.toDataURL(url, { margin: 1, width: 220 });
      setShareId(glbResult.shareId);
      setShareUrl(url);
      setQrDataUrl(qr);
      if (cacheRef.current?.route === navmeshRoute) {
        cacheRef.current.shareId = glbResult.shareId;
        cacheRef.current.shareUrl = url;
        cacheRef.current.qrDataUrl = qr;
      }
      // Best-effort: confirms this machine can reach the address it just
      // built for the phone to scan, not that the phone itself can — see
      // checkRouteShareReachable's own doc comment for why that's still
      // worth surfacing as a hint rather than staying silent.
      const reachable = await checkRouteShareReachable(url);
      setReachabilityWarning(!reachable);
      if (cacheRef.current?.route === navmeshRoute) {
        cacheRef.current.reachabilityWarning = !reachable;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        toast("Share cancelled");
        if (uploadedShareId) void deleteRouteShare(uploadedShareId);
      } else {
        setError(err instanceof Error ? err.message : "Failed to create a shareable link.");
      }
    } finally {
      abortUploadRef.current = null;
      setSharing(false);
      setUploadProgress(null);
    }
  };

  const cancelShare = () => {
    abortUploadRef.current?.();
  };

  const stopSharing = async () => {
    const id = shareId;
    setShareId(null);
    setShareUrl(null);
    setQrDataUrl(null);
    setReachabilityWarning(false);
    if (cacheRef.current?.route === navmeshRoute) {
      cacheRef.current.shareId = null;
      cacheRef.current.shareUrl = null;
      cacheRef.current.qrDataUrl = null;
      cacheRef.current.reachabilityWarning = false;
    }
    if (id) {
      const revoked = await deleteRouteShare(id);
      toast(
        revoked
          ? "Link revoked"
          : "Couldn't reach the server to revoke — it'll still expire on its own",
      );
    }
  };

  const copyLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
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
                <div className="space-y-1.5">
                  <div className="flex gap-2">
                    <Button className="flex-1" disabled={!glbBlob || sharing} onClick={share}>
                      {sharing
                        ? `Creating link… ${Math.round((uploadProgress ?? 0) * 100)}%`
                        : "Get shareable link + QR"}
                    </Button>
                    {sharing && (
                      <Button variant="outline" onClick={cancelShare}>
                        Cancel
                      </Button>
                    )}
                  </div>
                  {sharing && (
                    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-[#DC143C] transition-[width]"
                        style={{ width: `${Math.round((uploadProgress ?? 0) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2 rounded-[6px] border border-border p-3">
                  {qrDataUrl ? (
                    <div className="mx-auto w-fit rounded-xl border-2 border-[#DC143C]/15 bg-white p-3 shadow-sm">
                      <img
                        src={qrDataUrl}
                        alt="QR code linking to the 3D route"
                        className="size-[220px] rounded-md"
                      />
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={shareUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className="min-w-0 flex-1 rounded-[4px] border border-border bg-muted/40 px-2 py-1 text-[11px] text-foreground"
                    />
                    <Button variant="outline" size="sm" onClick={copyLink}>
                      {copied ? (
                        <Check className="size-3.5 text-green-600" aria-hidden />
                      ) : (
                        <Copy className="size-3.5" aria-hidden />
                      )}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                  {reachabilityWarning && (
                    <p className="text-[11px] text-amber-600">
                      Couldn't confirm this link responds on your network — if scanning it does
                      nothing, check that the other device is on the same Wi-Fi.
                    </p>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    {usdzBlob
                      ? "Scanning this on iPhone opens straight into native AR Quick Look; every other device opens or downloads the .glb."
                      : "Opens or downloads the .glb 3D file — the AR (USDZ) export wasn't available for this route, so iPhone falls back to the same file."}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Works on a device on the same network as this computer — not a public link.
                  </p>
                  <Button variant="outline" size="sm" className="w-full" onClick={stopSharing}>
                    Stop sharing
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
