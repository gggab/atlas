import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

import { useExplorerStore } from "@/features/explorer/stores/explorer-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { captureSnapshot, clearPanelStores, restoreSnapshot } from "./project-snapshot";

describe("clearPanelStores", () => {
  it("empties the file tree left by a torn-down project", () => {
    useExplorerStore.setState({
      rootPath: "F:\\perf-repos\\TypeScript",
      tree: [
        {
          entry: {
            name: "README.md",
            path: "F:\\perf-repos\\TypeScript\\README.md",
            is_dir: false,
          },
          children: [],
          expanded: false,
          depth: 0,
        },
      ] as never,
    });

    clearPanelStores();

    expect(useExplorerStore.getState().rootPath).toBeNull();
    expect(useExplorerStore.getState().tree).toEqual([]);
    expect(useGitStore.getState()).toMatchObject(
      Object.fromEntries(
        Object.entries(useGitStore.getInitialState()).filter(([k]) => k !== "actions"),
      ),
    );
  });

  it("keeps the actions, so the next project can still load", () => {
    const actions = useExplorerStore.getState().actions;
    clearPanelStores();
    expect(useExplorerStore.getState().actions).toBe(actions);
  });

  it("does not disturb a snapshot captured before it", () => {
    useExplorerStore.setState({ rootPath: "/a", tree: [] });
    captureSnapshot("p-a");
    clearPanelStores();
    expect(restoreSnapshot("p-a")).toBe(true);
    expect(useExplorerStore.getState().rootPath).toBe("/a");
  });
});
