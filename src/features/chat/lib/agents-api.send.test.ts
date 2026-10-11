import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { agents } from "./agents-api";
import { appendNextStepsDirective } from "./next-steps";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("browser handoff intent on agents_send", () => {
  it("carries raw human text independently of the Agent wire prompt", async () => {
    const key = { agent_id: "agent", session_id: "owner" };
    const wire = appendNextStepsDirective("继续");
    await agents.send(key, wire, undefined, undefined, "继续");
    expect(invoke).toHaveBeenCalledWith("agents_send", {
      key,
      text: wire,
      userText: "继续",
      attachments: null,
      resourceLinks: null,
    });
  });

  it("does not reuse a replayed Agent prompt as fresh human continuation", async () => {
    await agents.send({ agent_id: "agent", session_id: "owner" }, "继续");
    expect(invoke).toHaveBeenCalledWith("agents_send", expect.objectContaining({ userText: null }));
  });
});
