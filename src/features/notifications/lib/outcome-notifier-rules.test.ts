import { describe, expect, it } from "vitest";
import { type NotificationEnv } from "./decide";
import {
  decideGitOp,
  decideModelDownload,
  GIT_SUCCESS_MIN_MS,
  trimError,
  type GitOpResult,
} from "./outcome-notifier-rules";

const env = (over: Partial<NotificationEnv> = {}): NotificationEnv => ({
  windowFocused: true,
  sinceInputMs: 1_000,
  targetVisible: false,
  projectActive: true,
  away: false,
  ...over,
});
const AWAY = { windowFocused: false, away: true, sinceInputMs: 60_000 };
const prefs = {};

describe("decideModelDownload", () => {
  const done = { id: "m", name: "MiniLM", success: true, error: null, seq: 1 };
  const failed = { ...done, success: false, error: "network offline" };

  it("toasts when Settings is not showing the model; center always", () => {
    const d = decideModelDownload(done, env({ targetVisible: false }), prefs)!;
    expect(d.kind).toBe("model-download-done");
    expect(d.channels).toMatchObject({ center: true, toast: true, native: false });
    expect(d.target).toEqual({ type: "settings", section: "models" });
  });

  it("keeps the toast and banner quiet while the models view shows it", () => {
    const d = decideModelDownload(done, env({ targetVisible: true }), prefs)!;
    expect(d.channels).toMatchObject({ center: true, toast: false, native: false });
  });

  it("banners when away, even with the view showing it", () => {
    const d = decideModelDownload(done, env({ ...AWAY, targetVisible: true }), prefs)!;
    expect(d.channels.native).toBe(true);
  });

  it("carries the error of a failure", () => {
    const d = decideModelDownload(failed, env(), prefs)!;
    expect(d.kind).toBe("model-download-failed");
    expect(d.body).toBe("network offline");
  });
});

describe("decideGitOp", () => {
  const ok: GitOpResult = {
    op: "push",
    projectId: "p1",
    projectName: "Atlas",
    projectActive: true,
    durationMs: GIT_SUCCESS_MIN_MS,
    error: null,
    seq: 1,
  };

  it("a failure always notifies, even in a visible panel, trimmed to one line", () => {
    const d = decideGitOp(
      { ...ok, durationMs: 50, error: `${"x".repeat(300)}\nmore chatter` },
      env({ targetVisible: true }),
      prefs,
    )!;
    expect(d.kind).toBe("git-op-failed");
    expect(d.channels.center).toBe(true);
    expect(d.body.length).toBeLessThanOrEqual(160);
    expect(d.body).not.toContain("chatter");
  });

  it("a quick success is silent", () => {
    expect(decideGitOp({ ...ok, durationMs: GIT_SUCCESS_MIN_MS - 1 }, env(), prefs)).toBeNull();
    expect(decideGitOp({ ...ok, durationMs: 500 }, env(AWAY), prefs)).toBeNull();
  });

  it("a slow success speaks when the panel is not visible", () => {
    const d = decideGitOp(ok, env({ targetVisible: false }), prefs)!;
    expect(d.kind).toBe("git-op-done");
    expect(d.channels.toast).toBe(true);
  });

  it("a slow success speaks when away, even with the panel visible", () => {
    const d = decideGitOp(ok, env({ ...AWAY, targetVisible: true }), prefs)!;
    expect(d.channels.native).toBe(true);
  });

  it("a slow success is silent while looking at the panel", () => {
    expect(decideGitOp(ok, env({ targetVisible: true }), prefs)).toBeNull();
  });

  it("names the project only when it is not the active one", () => {
    expect(decideGitOp(ok, env(), prefs)!.subtitle).toBeUndefined();
    expect(decideGitOp({ ...ok, projectActive: false }, env(), prefs)!.subtitle).toBe("Atlas");
  });

  it("routes to that project's git panel", () => {
    expect(decideGitOp(ok, env(), prefs)!.target).toEqual({
      type: "git-panel",
      projectId: "p1",
      projectName: "Atlas",
    });
  });
});

describe("trimError", () => {
  it("takes the first non-empty line", () => {
    expect(trimError("\n  fatal: no remote \nhint")).toBe("fatal: no remote");
    expect(trimError(null)).toBe("");
  });
});
