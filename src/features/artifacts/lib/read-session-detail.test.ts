import { describe, expect, it, vi } from "vitest";

import { readSessionDetail } from "./read-session-detail";
import type { SessionDetail } from "../types";

function detail(id: string): SessionDetail {
  return {
    summary: { id } as SessionDetail["summary"],
    entries: [],
    counts: { prompts: 0, responses: 0, thinking: 0, toolCalls: 0, checkpoints: 0 },
    tools: [],
  };
}

describe("readSessionDetail", () => {
  it("reads a local record with its project path and session id", async () => {
    const local = vi.fn(async (_path: string, id: string) => detail(id));
    expect(
      await readSessionDetail({ projectPath: "/tmp/atlas", sessionId: "s" }, { local }),
    ).toEqual(detail("s"));
    expect(local).toHaveBeenCalledWith("/tmp/atlas", "s");
  });
  it("leaves a missing local record missing", async () => {
    expect(
      await readSessionDetail(
        { projectPath: "/tmp/atlas", sessionId: "s" },
        { local: vi.fn(async () => null) },
      ),
    ).toBeNull();
  });
  it("does not read without a project path", async () => {
    const local = vi.fn(async () => detail("s"));
    expect(await readSessionDetail({ projectPath: "", sessionId: "s" }, { local })).toBeNull();
    expect(local).not.toHaveBeenCalled();
  });
  it("reports a local read failure", async () => {
    await expect(
      readSessionDetail(
        { projectPath: "/tmp/atlas", sessionId: "s" },
        {
          local: vi.fn(async () => {
            throw new Error("disk unavailable");
          }),
        },
      ),
    ).rejects.toThrow("disk unavailable");
  });
});
