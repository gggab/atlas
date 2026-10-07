import { lazy, Suspense, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "../stores/layout-store";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { GitCommit, GitCompare, Server } from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { useAppStore } from "@/features/app/stores/app-store";

// Right-panel sub-panels are lazy so they don't run their first
// invokes / vendor parses during the boot-cascade window. The user lands
// on a project, sees the tab bar + skeleton instantly, and the data slides
// in as each chunk + IPC resolves. `GitManagerPanel` in particular pulls in
// `@tanstack/react-virtual` and parses git diff text that can be large on
// active branches — keeping it lazy stops the right panel from blocking
// the post-`hydrate` render.
const GitManagerPanel = lazy(() =>
  import("@/features/git/components/git-manager/git-manager-panel").then((m) => ({
    default: m.GitManagerPanel,
  })),
);
// xyflow + the layout pass are heavy; load only when the user opens the tab.
const GitGraphPanel = lazy(() =>
  import("@/features/git/components/git-graph-panel").then((m) => ({
    default: m.GitGraphPanel,
  })),
);
const GithubPanel = lazy(() =>
  import("@/features/github/components/github-panel").then((m) => ({
    default: m.GithubPanel,
  })),
);
const RemoteExecutionPanel = lazy(() =>
  import("@/features/ssh/components/remote-execution-panel").then((m) => ({
    default: m.RemoteExecutionPanel,
  })),
);
const sections = [
  { id: "changes" as const, label: "Source Control", icon: GitCompare },
  { id: "git-graph" as const, label: "Commit", icon: GitCommit },
  { id: "github" as const, label: "GitHub", icon: GithubIcon },
  { id: "remote-execution" as const, label: "Remote execution", icon: Server },
];

export function RightPanel() {
  const rightPanel = useLayoutStore.use.rightPanel();
  const activeSection = rightPanel.activeSection;
  const currentProject = useAppStore.use.currentProject();
  const { setRightSection } = useLayoutStore.use.actions();
  const selectedTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selectedTab.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeSection]);

  return (
    <div className="atlas-vibrant-panel h-full flex flex-col bg-[var(--card)]">
      <div className="flex items-center border-b border-border px-1 h-[29px] shrink-0 gap-0.5 overflow-x-auto hide-scrollbar">
        {sections.map((s) => (
          <button
            key={s.id}
            ref={activeSection === s.id ? selectedTab : undefined}
            onClick={() => setRightSection(s.id)}
            disabled={!currentProject && s.id !== "remote-execution"}
            title={
              !currentProject && s.id !== "remote-execution" ? "Open a project first" : undefined
            }
            aria-pressed={activeSection === s.id}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors cursor-pointer shrink-0 whitespace-nowrap disabled:opacity-40 disabled:cursor-default",
              activeSection === s.id
                ? "text-foreground bg-element-selected"
                : "text-muted-foreground hover:text-secondary-foreground hover:bg-element-hover",
            )}
          >
            <s.icon size={12} />
            {s.label}
          </button>
        ))}
      </div>

      <div
        className={cn(
          "flex-1 min-h-0",
          // Graph and remote transcript own their scrolling.
          activeSection === "git-graph" || activeSection === "remote-execution"
            ? "overflow-hidden"
            : "overflow-auto hide-scrollbar",
        )}
      >
        <Suspense
          fallback={
            <PanelSkeleton label={activeSection === "changes" ? "Loading changes…" : "Loading…"} />
          }
        >
          {activeSection === "changes" && <GitManagerPanel />}
          {activeSection === "git-graph" && <GitGraphPanel />}
          {activeSection === "github" && <GithubPanel />}
          {activeSection === "remote-execution" && <RemoteExecutionPanel />}
        </Suspense>
      </div>
    </div>
  );
}
