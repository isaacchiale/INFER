/**
 * 3D pane content for a model with no BIM geometry to load through That
 * Open/web-ifc (currently: IndoorGML). A standalone Three.js render loop —
 * deliberately not routed through InferModelViewport's That Open runtime,
 * since that runtime's entire model-loading path (IfcLoader -> web-ifc)
 * only understands actual IFC bytes. Still not full parity with the IFC
 * pane's chrome (no wall thickness/openings/materials), but the storey
 * filter below now matches it — same shared `activeStoreyId`, so picking a
 * level here isolates the same floor in the Floorplan pane too.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Check, ChevronDown } from "lucide-react";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { GLASS } from "@/lib/floating-panel";
import { buildFootprintScene } from "@/lib/footprint-scene";
import { useModelData, useViewport } from "@/state/infer-store";

function frameCamera(camera: THREE.PerspectiveCamera, controls: OrbitControls, bounds: THREE.Box3) {
  const size = bounds.getSize(new THREE.Vector3());
  const centre = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 1);
  const dist = radius / Math.sin((Math.PI * camera.fov) / 360);
  camera.position.set(centre.x + dist * 0.6, centre.y + dist * 0.5, centre.z + dist * 0.6);
  camera.near = Math.max(dist / 100, 0.01);
  camera.far = dist * 10;
  camera.updateProjectionMatrix();
  controls.target.copy(centre);
  controls.update();
}

function FootprintModelViewportImpl({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const { footprintsDocument } = useModelData();
  // Shared with FloorplanViewer (and InferModelViewport, for IFC models) —
  // picking a storey in one pane isolates the same floor everywhere.
  const { activeStoreyId, setActiveStoreyId } = useViewport();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const storeys = useMemo(() => {
    const raw = footprintsDocument?.storeys ?? [];
    return [...raw].sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
  }, [footprintsDocument]);

  const storeyLabel = useMemo(() => {
    if (activeStoreyId === "all") return "All levels";
    if (!storeys.length) return "No storeys";
    const match = storeys.find((s) => s.global_id === activeStoreyId);
    if (!match) return "Select storey";
    return (
      match.name?.trim() ||
      (match.elevation != null ? `E${match.elevation}` : match.global_id.slice(0, 8))
    );
  }, [storeys, activeStoreyId]);

  // Drop a stale storey selection when the model changes underneath it.
  useEffect(() => {
    if (activeStoreyId === "all") return;
    if (storeys.some((s) => s.global_id === activeStoreyId)) return;
    setActiveStoreyId("all");
  }, [storeys, activeStoreyId, setActiveStoreyId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let frameId = 0;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    let scene: THREE.Scene | null = null;
    if (footprintsDocument) {
      const built = buildFootprintScene(footprintsDocument, activeStoreyId);
      if (built) {
        scene = built.scene;
        frameCamera(camera, controls, built.bounds);
        setError(null);
      } else {
        setError("No space geometry in this model's footprints.");
      }
    }

    const animate = () => {
      if (disposed) return;
      controls.update();
      if (scene) renderer.render(scene, camera);
      frameId = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) {
        host.removeChild(renderer.domElement);
      }
      scene?.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mat = obj.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      });
    };
  }, [footprintsDocument, activeStoreyId]);

  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-viewport", className)}>
      <div ref={hostRef} className="viewport-dark absolute inset-0" />
      {!footprintsDocument && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-4">
          <div className={cn(GLASS, "px-3 py-1.5 text-center text-[13px] text-foreground")}>
            No model loaded.
          </div>
        </div>
      )}
      {error && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-4">
          <div className={cn(GLASS, "max-w-xs px-3 py-1.5 text-center text-[13px] text-foreground")}>
            {error}
          </div>
        </div>
      )}
      <div className="pointer-events-none absolute left-3 top-3 z-20">
        <div className={cn(GLASS, "px-2.5 py-1.5 text-[11px] text-muted-foreground")}>
          Plan-derived 3D view (no BIM geometry in this format) — drag to orbit, scroll to zoom.
        </div>
      </div>
      {footprintsDocument && (
        <div className="pointer-events-auto absolute right-3 top-3 z-20">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={!storeys.length}
                className={cn(
                  GLASS,
                  "flex h-8 max-w-[220px] items-center gap-1.5 px-2.5 text-[12px] text-foreground transition-colors hover:bg-muted disabled:opacity-40",
                )}
                title="Storey — shared with the Floorplan pane; pick All levels to see every floor stacked"
              >
                <span className="min-w-0 truncate">{storeyLabel}</span>
                <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-64 min-w-[10rem] overflow-y-auto">
              <DropdownMenuItem className="text-[12px]" onSelect={() => setActiveStoreyId("all")}>
                {activeStoreyId === "all" ? (
                  <Check className="size-3.5" />
                ) : (
                  <span className="size-3.5" />
                )}
                All levels
              </DropdownMenuItem>
              {storeys.map((s) => {
                const label =
                  s.name?.trim() ||
                  (s.elevation != null ? `E${s.elevation}` : s.global_id.slice(0, 8));
                const active = activeStoreyId === s.global_id;
                return (
                  <DropdownMenuItem
                    key={s.global_id}
                    className="text-[12px]"
                    onSelect={() => setActiveStoreyId(s.global_id)}
                  >
                    {active ? <Check className="size-3.5" /> : <span className="size-3.5" />}
                    {label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {children}
    </div>
  );
}

export const FootprintModelViewport = memo(FootprintModelViewportImpl);
