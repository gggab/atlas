// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { useAppBootstrap } from "./use-app-bootstrap";
import { useAppStore } from "../stores/app-store";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  hydrate: vi.fn(),
  writable: vi.fn(),
  openProject: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../stores/app-store", async () => {
  const { create } = await import("zustand");
  const { createSelectors } = await import("@/lib/create-selectors");
  const store = createSelectors(
    create(() => ({
      hydrated: false,
      actions: {
        hydrate: (...args: unknown[]) => {
          mocks.hydrate(...args);
          store.setState({ hydrated: true });
        },
        openProject: mocks.openProject,
      },
    })),
  );
  return { useAppStore: store, setAppStateWritable: mocks.writable };
});
vi.mock("@/features/log/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("@/lib/markdown-cache", () => ({ primeMarkdownRenderer: vi.fn() }));
vi.mock("@/lib/markdown", () => ({ primeMarkdown: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));

const snapshot = { version: 5, currentProject: null, recentProjects: [], workspaces: [] };
const ready = () => (window as unknown as { __atlasAppReady?: boolean }).__atlasAppReady;

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ hydrated: false });
  delete (window as unknown as { __atlasAppReady?: boolean }).__atlasAppReady;
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "bootstrap_app_state" ? snapshot : null,
  );
});
afterEach(cleanup);

it("hydrates once and leaves ready stores alone across renders", async () => {
  const { rerender } = renderHook(useAppBootstrap);
  await waitFor(() => expect(useAppStore.getState().hydrated).toBe(true));
  rerender();
  expect(mocks.hydrate).toHaveBeenCalledTimes(1);
  expect(ready()).toBe(true);
});

it("restores stores reset after the shell was already marked ready", async () => {
  renderHook(useAppBootstrap);
  await waitFor(() => expect(ready()).toBe(true));
  act(() => useAppStore.setState({ hydrated: false }));
  await waitFor(() => expect(mocks.hydrate).toHaveBeenCalledTimes(2));
  expect(useAppStore.getState().hydrated).toBe(true);
  expect(mocks.hydrate.mock.calls[1]?.[0]).toEqual(snapshot);
});

it("finishes CLI project opening after hydration changes the ready flag", async () => {
  let finish!: () => void;
  mocks.openProject.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "bootstrap_app_state" ? snapshot : "C:/cli-project",
  );
  renderHook(useAppBootstrap);
  await waitFor(() => expect(mocks.openProject).toHaveBeenCalledWith("C:/cli-project"));
  expect(ready()).not.toBe(true);
  await act(async () => finish());
  await waitFor(() => expect(ready()).toBe(true));
});

it("hydrates only the live attempt under StrictMode", async () => {
  renderHook(useAppBootstrap, { wrapper: StrictMode });
  await waitFor(() => expect(ready()).toBe(true));
  expect(mocks.hydrate).toHaveBeenCalledTimes(1);
});

it("does not apply a snapshot after the bootstrap owner unmounts", async () => {
  let finish!: (value: unknown) => void;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "bootstrap_app_state")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return null;
  });
  const { unmount } = renderHook(useAppBootstrap);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  unmount();
  await act(async () => finish(snapshot));
  expect(mocks.hydrate).not.toHaveBeenCalled();
  expect(mocks.writable).not.toHaveBeenCalledWith(true);
});

it("keeps persistence suspended when the saved state cannot be read", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "bootstrap_app_state") throw new Error("offline");
    return null;
  });
  renderHook(useAppBootstrap);
  await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
  expect(mocks.writable).not.toHaveBeenCalledWith(true);
  expect(mocks.writable).toHaveBeenLastCalledWith(false);
  expect(mocks.hydrate.mock.calls[0]?.[0]).toEqual({
    currentProject: null,
    recentProjects: [],
    version: 1,
  });
  vi.restoreAllMocks();
});
