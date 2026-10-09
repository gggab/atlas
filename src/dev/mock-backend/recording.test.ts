// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingMode, startMockBackend } from "./backend";
import { scenarios } from "./scenarios";
import { mountBadge } from "./badge";
import {
  agentHandlers,
  setAgentModels,
  setAgentCommands,
  setAgentDisplayNames,
  setPromptHandler,
} from "./fake-agent";

vi.mock("./badge", () => ({ mountBadge: vi.fn(() => vi.fn()) }));

afterEach(() => {
  history.replaceState(null, "", "/");
  delete scenarios["recording-test"];
  vi.clearAllMocks();
  setAgentModels(null);
  setAgentCommands(null);
  setAgentDisplayNames(null);
  setPromptHandler(null);
});

describe("mock recording", () => {
  it("exposes scenario models and handles a prompt in its actual session", async () => {
    setAgentModels(() => ({ current: "demo", available: [{ id: "demo", name: "Demo model" }] }));
    setAgentCommands(() => [{ name: "review", description: "Review this project" }]);
    setAgentDisplayNames(() => "Demo agent");
    const agent = await agentHandlers.agents_spawn({ pluginId: "demo-agent" });
    expect(agent.display_name).toBe("Demo agent");
    const session = await agentHandlers.agents_new_session({
      agentId: agent.agent_id,
      cwd: "/demo",
    });
    const snapshot = await agentHandlers.agents_snapshot_meta({ key: session.key });
    expect(snapshot.current_model).toBe("demo");
    expect(snapshot.available_models).toEqual([{ id: "demo", name: "Demo model" }]);
    expect(snapshot.available_commands).toEqual([
      { name: "review", description: "Review this project" },
    ]);
    const handler = vi.fn(() => true);
    setPromptHandler(handler);
    await agentHandlers.agents_send({ key: session.key, text: "Review this code" });
    expect(handler).toHaveBeenCalledWith({
      sessionId: session.key.session_id,
      pluginId: "demo-agent",
      cwd: "/demo",
      text: "Review this code",
    });
  });
  it("hides mock chrome only when recording was requested", () => {
    expect(recordingMode("?record=1")).toBe(true);
    for (const search of ["", "?record=0", "?record=false"])
      expect(recordingMode(search)).toBe(false);
    history.replaceState(null, "", "/?record=1");
    const backend = startMockBackend("default");
    expect(mountBadge).not.toHaveBeenCalled();
    backend.answer("recording_test_unknown", {});
    expect(window.__atlasMock?.unmocked()).toContain("recording_test_unknown");
  });

  it("lets typed handlers override raw scenario handlers", () => {
    scenarios["recording-test"] = {
      name: "recording-test",
      description: "Recording test",
      rawCommands: { custom_test: () => "raw", git_graph_signature: () => "raw" },
      commands: { git_graph_signature: () => "typed" },
    };
    const backend = startMockBackend("recording-test");
    expect(backend.answer("custom_test", {})).toBe("raw");
    expect(backend.answer("git_graph_signature", {})).toBe("typed");
    expect(mountBadge).toHaveBeenCalled();
  });
});
