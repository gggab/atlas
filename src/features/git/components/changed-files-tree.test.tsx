// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ChangedFilesTree } from "./changed-files-tree";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 22,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 22 })),
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("selects a turn's file inside its host without opening tabs or reading commit history", () => {
  const tabs = useLayoutStore.getState().tabs;
  const onSelect = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ChangedFilesTree
        repoPath=""
        staged={false}
        currentFile="a.ts"
        only={["a.ts", "b.ts"]}
        onSelect={onSelect}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTitle("b.ts"));
  expect(onSelect).toHaveBeenCalledWith("b.ts");
  expect(useLayoutStore.getState().tabs).toEqual(tabs);
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.queryByTitle("Inspect a commit's changes")).toBeNull();
});
