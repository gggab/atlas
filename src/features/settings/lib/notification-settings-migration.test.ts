import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "./app-settings";
import {
  migrateNotificationSettings,
  sanitizeLegacyAgentPrefs,
} from "./notification-settings-migration";

const apply = (s: AppSettings, legacy: unknown): AppSettings => ({
  ...s,
  ...migrateNotificationSettings(s, legacy),
});

describe("migrateNotificationSettings", () => {
  it("does nothing once migrated", () => {
    expect(
      migrateNotificationSettings(
        { ...DEFAULT_SETTINGS, notificationsMigrated: true, notifyKindsMigrated: true },
        {},
      ),
    ).toBeNull();
  });

  it("leaves an untouched install on the defaults, and marks it migrated", () => {
    const out = apply(DEFAULT_SETTINGS, null);
    expect(out).toEqual({
      ...DEFAULT_SETTINGS,
      notificationsMigrated: true,
      notifyKindsMigrated: true,
    });
  });

  it("carries the agent master, minimum duration and sound over", () => {
    const out = apply(DEFAULT_SETTINGS, {
      enabled: false,
      native: true,
      sound: false,
      minDurationMs: 30_000,
    });
    expect(out).toMatchObject({
      notificationsEnabled: false,
      notifyAgentMinDurationMs: 30_000,
      notifyNeedsYouSound: false,
      notifyOutcomeSound: false,
    });
  });

  it("keeps a banner off if either side had it off", () => {
    const terminalOff = apply({ ...DEFAULT_SETTINGS, terminalNotifyNative: false }, null);
    expect(terminalOff).toMatchObject({ notifyNeedsYouNative: false, notifyOutcomeNative: false });
    const agentOff = apply(DEFAULT_SETTINGS, { native: false });
    expect(agentOff).toMatchObject({ notifyNeedsYouNative: false, notifyOutcomeNative: false });
  });

  it("keeps a terminal sound that was opted into", () => {
    const out = apply({ ...DEFAULT_SETTINGS, terminalNotifySound: true }, { sound: false });
    expect(out).toMatchObject({ notifyNeedsYouSound: true, notifyOutcomeSound: true });
  });

  it("carries a switched-off terminal master onto all three terminal kinds", () => {
    const out = apply({ ...DEFAULT_SETTINGS, terminalNotifications: false }, null);
    expect(out).toMatchObject({
      terminalNotifications: false,
      terminalNotifyOnFailure: false,
      terminalNotifyOnAttention: false,
      notificationsEnabled: true,
    });
  });

  it("leaves terminal-specific choices that are still meaningful alone", () => {
    const base = {
      ...DEFAULT_SETTINGS,
      terminalNotifyMinDurationMs: 60_000,
      terminalNotifyOnAttention: false,
    };
    expect(apply(base, null)).toMatchObject({
      terminalNotifyMinDurationMs: 60_000,
      terminalNotifyOnAttention: false,
    });
  });

  it("does not leave the warning tier at anything but their defaults", () => {
    const out = apply(DEFAULT_SETTINGS, { enabled: true, native: false, sound: false });
    expect(out).toMatchObject({
      notifyWarningNative: false,
      notifyWarningSound: false,
    });
  });
});

describe("per-kind switch migration", () => {
  it("turns each switched-off per-kind setting into a disabled kind", () => {
    const out = apply(
      {
        ...DEFAULT_SETTINGS,
        notificationsMigrated: true,
        terminalNotifications: false,
        terminalNotifyOnAttention: false,
      },
      null,
    );
    expect(out.notifyDisabledKinds.sort()).toEqual(["terminal-attention", "terminal-done"]);
    expect(out.notifyKindsMigrated).toBe(true);
  });

  it("runs for an install that already ran the tier step, and leaves its tiers alone", () => {
    const base = {
      ...DEFAULT_SETTINGS,
      notificationsMigrated: true,
      notifyOutcomeNative: false,
      terminalNotifyOnFailure: false,
    };
    const patch = migrateNotificationSettings(base, { enabled: false });
    expect(patch).toEqual({ notifyDisabledKinds: ["terminal-failed"], notifyKindsMigrated: true });
  });

  it("a switched-off terminal master disables all three terminal kinds in one pass", () => {
    const out = apply({ ...DEFAULT_SETTINGS, terminalNotifications: false }, null);
    expect(out.notifyDisabledKinds.sort()).toEqual([
      "terminal-attention",
      "terminal-done",
      "terminal-failed",
    ]);
  });

  it("keeps kinds already listed and adds nothing for untouched switches", () => {
    const out = apply(
      { ...DEFAULT_SETTINGS, notificationsMigrated: true, notifyDisabledKinds: ["git-behind"] },
      null,
    );
    expect(out.notifyDisabledKinds).toEqual(["git-behind"]);
  });

  it("does nothing once the kind step has run", () => {
    expect(
      migrateNotificationSettings(
        { ...DEFAULT_SETTINGS, notificationsMigrated: true, notifyKindsMigrated: true },
        null,
      ),
    ).toBeNull();
  });
});

describe("sanitizeLegacyAgentPrefs", () => {
  it("falls back to the old defaults for junk", () => {
    expect(sanitizeLegacyAgentPrefs(null)).toEqual({
      enabled: true,
      native: true,
      sound: true,
      minDurationMs: 0,
    });
    expect(sanitizeLegacyAgentPrefs({ enabled: "no", minDurationMs: -5 })).toMatchObject({
      enabled: true,
      minDurationMs: 0,
    });
  });

  it("caps a duration Rust would reject", () => {
    expect(sanitizeLegacyAgentPrefs({ minDurationMs: 99_999_999 }).minDurationMs).toBe(3_600_000);
  });
});
