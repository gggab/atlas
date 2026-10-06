import { describe, expect, it } from "vitest";
import { leadingBadge } from "./leading-badge";

describe("leadingBadge", () => {
  it("maps the agent kinds from the catalog", () => {
    expect(leadingBadge("agent-done")).toBe("done");
    expect(leadingBadge("agent-failed")).toBe("failed");
    expect(leadingBadge("permission")).toBe("needs-you");
    expect(leadingBadge("agent-question")).toBe("needs-you");
    expect(leadingBadge("agent-context-warning")).toBe("warning");
  });
});
