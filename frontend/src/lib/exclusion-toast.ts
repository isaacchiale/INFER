import { toast } from "sonner";

/**
 * Bottom-right feedback for excluding or restoring a graph node/edge from
 * routing. Always offers Undo so a mis-click on a safety-adjacent toggle is
 * one click to reverse (same pattern FloorplanViewer used for room exclude).
 */
export function toastExclusionToggle(opts: {
  label: string;
  /** True if the id was already excluded before this toggle (so we're restoring). */
  wasExcluded: boolean;
  kind: "node" | "edge";
  onUndo: () => void;
}): void {
  const { label, wasExcluded, kind, onUndo } = opts;
  const message =
    kind === "edge"
      ? wasExcluded
        ? `${label} link restored`
        : `${label} link disabled`
      : wasExcluded
        ? `${label} restored to routing`
        : `${label} excluded from routing`;
  toast(message, {
    action: { label: "Undo", onClick: onUndo },
  });
}

/** Human label for a graph node id when the model name is missing. */
export function exclusionNodeLabel(
  nodeId: string,
  name?: string | null,
): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  if (nodeId.startsWith("space:")) return "Room";
  if (nodeId.startsWith("door:")) return "Door";
  if (nodeId.startsWith("stair:")) return "Stair";
  if (nodeId.startsWith("lift:")) return "Lift";
  return "Node";
}
