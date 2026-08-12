import { createFileRoute } from "@tanstack/react-router";
import { building } from "@/data/mock";
import { InferModelViewport } from "@/components/viewer/InferModelViewport";
import { FloorSelector, RouteControls, ViewControls } from "@/components/viewer/ViewportControls";
import { Inspector } from "@/components/panels/Inspector";
import { NavigatePanel } from "@/components/panels/NavigatePanel";
import { ValidatePanel } from "@/components/panels/ValidatePanel";
import { ScenarioPanel } from "@/components/panels/ScenarioPanel";
import { LayersPanel } from "@/components/panels/LayersPanel";
import { SplitWorkspace } from "@/components/workspace/SplitWorkspace";
import { useInfer } from "@/state/infer-store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Model workspace — INFER" },
      {
        name: "description",
        content:
          "Inspect the indoor spatial model, plan routes, validate connectivity and simulate disruptions in one workspace.",
      },
      { property: "og:title", content: "Model workspace — INFER" },
      {
        property: "og:description",
        content: "Split 3D + graph workspace for indoor model inspection, routing and scenarios.",
      },
    ],
  }),
  component: WorkspaceScreen,
});

function WorkspaceScreen() {
  const {
    workMode,
    setWorkMode,
    selectedElementIds,
    selectElement,
    route,
    activeStoreyId,
    hazardZones,
    animation,
  } = useInfer();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SplitWorkspace
        modelPane={
          <InferModelViewport
            modelId={building.id}
            selectedElementIds={selectedElementIds}
            highlightedRoute={route}
            activeStoreyId={activeStoreyId}
            hazardZones={hazardZones}
            animationStepIndex={animation.stepIndex}
            animationPlaying={animation.playing}
            onElementSelected={(id) => selectElement(id)}
          >
            <div className="viewport-dark contents">
              {!animation.playing && workMode !== "layers" && workMode !== "navigate" && (
                <FloorSelector />
              )}
              {!animation.playing && <ViewControls />}
              <RouteControls />
            </div>

            {workMode === "navigate" && <NavigatePanel onClose={() => setWorkMode("model")} />}
            {workMode === "validate" && <ValidatePanel onClose={() => setWorkMode("model")} />}
            {workMode === "scenario" && <ScenarioPanel onClose={() => setWorkMode("model")} />}
            {workMode === "layers" && <LayersPanel onClose={() => setWorkMode("model")} />}

            {!animation.playing && <Inspector />}
          </InferModelViewport>
        }
      />
    </div>
  );
}
