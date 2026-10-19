// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { openRemoteExecution } from "./ssh-host";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

const baseline = useLayoutStore.getState();
afterEach(() => {
  useLayoutStore.setState(baseline, true);
  vi.clearAllMocks();
});

it("reveals remote output without replacing the central agent tab, including repeated opens", () => {
  useLayoutStore.setState({ rightPanel: { ...baseline.rightPanel, visible: false } });
  openRemoteExecution();
  openRemoteExecution();
  const state = useLayoutStore.getState();
  expect(state.rightPanel).toMatchObject({
    visible: true,
    mode: "remote-execution",
    activeSection: "remote-execution",
  });
  expect(state.tabs).toEqual(baseline.tabs);
  expect(state.activeTabId).toBe(baseline.activeTabId);
  expect(state.activeByGroup).toEqual(baseline.activeByGroup);
});

it("toggles only remote output and reveals it without replacing agent tabs", () => {
  const { toggleRightPanel, toggleRightPanelMode, revealRightSection } =
    useLayoutStore.getState().actions;
  openRemoteExecution();
  toggleRightPanel();
  expect(useLayoutStore.getState().rightPanel.visible).toBe(false);
  toggleRightPanel();
  expect(useLayoutStore.getState().rightPanel).toMatchObject({
    visible: true,
    mode: "remote-execution",
    activeSection: "remote-execution",
  });
  toggleRightPanelMode("remote-execution");
  expect(useLayoutStore.getState().rightPanel.visible).toBe(false);
  revealRightSection("remote-execution");
  expect(useLayoutStore.getState().rightPanel.visible).toBe(true);
  expect(useLayoutStore.getState().tabs).toEqual(baseline.tabs);
});

it.each(["changes", "git-graph", "github"])(
  "closes the removed %s panel on hydration and preserves its width and tabs",
  (activeSection) => {
    const merge = useLayoutStore.persist.getOptions().merge!;
    const state = merge(
      { rightPanel: { visible: true, width: 410, activeSection, mode: "source-control" } },
      baseline,
    );
    expect(state.rightPanel).toEqual({
      visible: false,
      width: 410,
      activeSection: "remote-execution",
      mode: "remote-execution",
    });
    expect(state.tabs).toEqual(baseline.tabs);
  },
);

it("keeps the right-panel selection and drops obsolete remote terminal tabs on hydration", () => {
  const merge = useLayoutStore.persist.getOptions().merge!;
  const legacy = {
    id: "terminal-ssh",
    type: "terminal" as const,
    title: "Remote execution",
    closable: true,
    dirty: false,
    data: { remote: true },
  };
  const state = merge(
    {
      tabs: [...baseline.tabs, legacy],
      activeTabId: legacy.id,
      rightPanel: { ...baseline.rightPanel, activeSection: "remote-execution" },
    },
    baseline,
  );
  expect(state.tabs).toEqual(baseline.tabs);
  expect(state.activeTabId).toBe(baseline.tabs[0].id);
  expect(state.rightPanel.mode).toBe("remote-execution");
});

it.each([true, false])("preserves saved remote-output visibility (%s)", (visible) => {
  const merge = useLayoutStore.persist.getOptions().merge!;
  const state = merge({ rightPanel: { ...baseline.rightPanel, visible, width: 360 } }, baseline);
  expect(state.rightPanel).toMatchObject({
    visible,
    width: 360,
    activeSection: "remote-execution",
  });
});

it("does not restore obsolete remote tabs as local terminals from a project's saved view", async () => {
  vi.mocked(invoke).mockResolvedValue(
    JSON.stringify({
      tabs: [
        { id: "terminal-ssh", type: "terminal", title: "Remote execution", data: { remote: true } },
        { id: "local-terminal", type: "terminal", title: "Terminal", data: {} },
      ],
      activeByGroup: { main: "terminal-ssh" },
    }),
  );
  await useLayoutStore.getState().actions.loadEditorState("C:/test-project");
  const state = useLayoutStore.getState();
  expect(state.tabs.find((t) => t.id === "terminal-ssh")).toBeUndefined();
  expect(state.tabs.find((t) => t.id === "local-terminal")).toBeTruthy();
  expect(state.activeTabId).not.toBe("terminal-ssh");
});
