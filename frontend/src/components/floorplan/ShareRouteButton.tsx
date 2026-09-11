import { useState } from "react";
import { Share2 } from "lucide-react";
import { toast } from "sonner";
import QRCode from "qrcode";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { exportGLB } from "@/lib/export-glb";
import { buildRouteShareScene } from "@/lib/route-share-scene";
import { uploadRouteShare } from "@/api/route-shares";
import type { NavmeshRoute } from "@/state/infer-store";
import type { FootprintsDocument } from "@/types/footprints";

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
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasRoute = Boolean(
    navmeshRoute && (navmeshRoute.points?.length || navmeshRoute.segments?.length),
  );

  const openDialog = async () => {
    if (!navmeshRoute || !footprintsDocument) return;
    setOpen(true);
    setBuilding(true);
    setError(null);
    setGlbBlob(null);
    setShareUrl(null);
    setQrDataUrl(null);
    try {
      const scene = buildRouteShareScene(navmeshRoute, footprintsDocument);
      if (!scene) {
        setError("This route has no drawable points yet.");
        return;
      }
      setGlbBlob(await exportGLB(scene));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build the 3D export.");
    } finally {
      setBuilding(false);
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
      const { url } = await uploadRouteShare(glbBlob);
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
        variant="destructive"
        size="sm"
        disabled={!hasRoute}
        onClick={openDialog}
        title="Export the current route as a 3D file, or share a link/QR to open it on another device"
      >
        <Share2 className="size-3.5" aria-hidden />
        Share
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
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
                    Android 3D viewers open .glb directly; on iPhone this currently downloads the
                    file rather than opening a native AR preview (that needs a USDZ export, not
                    built yet).
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
