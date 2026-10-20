import { beforeEach, describe, expect, it } from "vitest";
import { openDetail, useDetailPanelStore } from "./detail-panel-store";

beforeEach(() => useDetailPanelStore.setState({ targets: {} }));

describe("delegated work details", () => {
  it("closes the same child's detail on a second click", () => {
    openDetail("tab", { kind: "subagent", toolCallId: "child" });
    openDetail("tab", { kind: "subagent", toolCallId: "child" });
    expect(useDetailPanelStore.getState().targets.tab).toBeUndefined();
  });

  it("retargets another child without changing another tab", () => {
    openDetail("other", { kind: "subagent", toolCallId: "retained" });
    openDetail("tab", { kind: "subagent", toolCallId: "a" });
    openDetail("tab", { kind: "subagent", toolCallId: "b" });
    expect(useDetailPanelStore.getState().targets).toEqual({
      tab: { kind: "subagent", toolCallId: "b" },
      other: { kind: "subagent", toolCallId: "retained" },
    });
  });
});
