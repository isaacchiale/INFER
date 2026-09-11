import { createFileRoute } from "@tanstack/react-router";
import { InferModelViewport } from "@/components/viewer/InferModelViewport";
import { Inspector } from "@/components/panels/Inspector";
import { SplitWorkspace } from "@/components/workspace/SplitWorkspace";
import { useModelData, useViewport } from "@/state/infer-store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Model workspace — INFER" },
      {
        name: "description",
        content: "Inspect the indoor spatial model and plan navmesh routes in one workspace.",
      },
      { property: "og:title", content: "Model workspace — INFER" },
      {
        property: "og:description",
        content: "Split 3D + graph workspace for indoor model inspection and routing.",
      },
    ],
  }),
  component: WorkspaceScreen,
});

function WorkspaceScreen() {
  const { backendModelId } = useModelData();
  const { selectedElementIds } = useViewport();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SplitWorkspace
        modelPane={
          <InferModelViewport
            modelId={backendModelId ?? "model"}
            selectedElementIds={selectedElementIds}
          >
            <Inspector />
          </InferModelViewport>
        }
      />
    </div>
  );
}
