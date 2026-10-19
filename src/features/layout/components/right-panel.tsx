import { lazy, Suspense } from "react";
import { PanelSkeleton } from "@/components/panel-skeleton";

const RemoteExecutionPanel = lazy(() =>
  import("@/features/ssh/components/remote-execution-panel").then((m) => ({
    default: m.RemoteExecutionPanel,
  })),
);

export function RightPanel() {
  return (
    <div className="atlas-vibrant-panel h-full flex flex-col bg-[var(--card)]">
      <div className="flex-1 min-h-0 overflow-hidden">
        <Suspense fallback={<PanelSkeleton label="Loading remote execution…" />}>
          <RemoteExecutionPanel />
        </Suspense>
      </div>
    </div>
  );
}
