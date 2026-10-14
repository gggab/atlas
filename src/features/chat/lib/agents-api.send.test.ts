import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { agents } from "./agents-api";
import { appendNextStepsDirective } from "./next-steps";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("agents_send", () => {
  it("sends the Agent wire prompt without browser handoff authorization", async () => {
    const key = { agent_id: "agent", session_id: "owner" };
    const wire = appendNextStepsDirective("继续");
    await agents.send(key, wire);
    expect(invoke).toHaveBeenCalledWith("agents_send", {
      key,
      text: wire,
      attachments: null,
      resourceLinks: null,
    });
  });

  it("preserves image attachments and resource links", async () => {
    const key = { agent_id: "agent", session_id: "owner" };
    const attachments = [{ mimeType: "image/png", dataBase64: "image-data" }];
    const resourceLinks = [{ uri: "file:///project/readme.md", name: "readme.md" }];
    await agents.send(key, "Inspect this", attachments, resourceLinks);
    expect(invoke).toHaveBeenCalledWith("agents_send", {
      key,
      text: "Inspect this",
      attachments,
      resourceLinks,
    });
  });
});
