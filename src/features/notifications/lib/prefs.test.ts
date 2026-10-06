import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "@/features/settings/lib/app-settings";
import {
  NOTIFICATION_CATALOG,
  catalogEntry,
  isNotificationKind,
  type NotificationKind,
} from "./catalog";
import { decideNotification, type NotificationEnv, type NotificationEvent } from "./decide";
import { TIER_ORDER, TIER_SETTINGS, kindsInTier, prefsFromSettings } from "./prefs";

const kinds = Object.keys(NOTIFICATION_CATALOG) as NotificationKind[];
const away: NotificationEnv = {
  windowFocused: false,
  sinceInputMs: 999_999,
  targetVisible: false,
  projectActive: true,
  away: true,
};
const event = (kind: NotificationKind): NotificationEvent => ({
  kind,
  title: "t",
  body: "b",
  target: { type: "session", tabId: "tab-1", sessionId: "s-1" },
  dedupeKey: `${kind}:1`,
});
const decide = (kind: NotificationKind, settings: AppSettings) =>
  decideNotification(event(kind), away, prefsFromSettings(settings));

describe("prefsFromSettings", () => {
  it("covers every switchable catalog kind and leaves locked ones to the defaults", () => {
    const prefs = prefsFromSettings(DEFAULT_SETTINGS);
    for (const kind of kinds) {
      const locked = catalogEntry(kind).locked;
      expect(kind in prefs).toBe(!locked);
    }
  });

  it("the tier switches decide banner and sound for every kind in the tier", () => {
    for (const tier of TIER_ORDER) {
      const { native, sound } = TIER_SETTINGS[tier];
      const settings = { ...DEFAULT_SETTINGS, [native]: false, [sound]: true };
      const prefs = prefsFromSettings(settings);
      for (const { kind, entry } of kindsInTier(tier)) {
        if (entry.locked) continue;
        expect(prefs[kind], kind).toMatchObject({ native: false, sound: true });
      }
    }
  });

  it("the master switch silences every switchable kind and spares the locked one", () => {
    const settings = { ...DEFAULT_SETTINGS, notificationsEnabled: false };
    for (const kind of kinds) {
      if (catalogEntry(kind).locked) {
        expect(decide(kind, settings), kind).not.toBeNull();
      } else {
        expect(decide(kind, settings), kind).toBeNull();
      }
    }
  });

  it("a kind listed in notifyDisabledKinds switches only that kind off", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      notifyDisabledKinds: ["terminal-failed", "git-behind"],
    };
    expect(decide("terminal-failed", settings)).toBeNull();
    expect(decide("git-behind", settings)).toBeNull();
    expect(decide("terminal-attention", settings)).not.toBeNull();
    expect(decide("terminal-done", settings)).not.toBeNull();
  });

  it("every non-locked kind can be switched off", () => {
    for (const kind of kinds) {
      if (catalogEntry(kind).locked) continue;
      const settings = { ...DEFAULT_SETTINGS, notifyDisabledKinds: [kind] };
      expect(prefsFromSettings(settings)[kind]?.enabled, kind).toBe(false);
    }
  });

  it("ignores unknown and retired ids", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      notifyDisabledKinds: ["not-a-kind", "atlas-signed-out"],
    };
    expect(decide("terminal-done", settings)).not.toBeNull();
    expect(prefsFromSettings(settings)).not.toHaveProperty("not-a-kind");
  });
});

describe("the decision honours the settings", () => {
  it("tier banner off keeps center and toast, drops the OS banner", () => {
    const d = decide("agent-failed", { ...DEFAULT_SETTINGS, notifyOutcomeNative: false });
    expect(d?.channels).toMatchObject({ center: true, toast: true, native: false });
  });

  it("tier sound off removes the banner sound; on adds it", () => {
    const off = decide("permission", { ...DEFAULT_SETTINGS, notifyNeedsYouSound: false });
    expect(off?.channels).toMatchObject({ native: true, sound: false });
    expect(off?.native.sound).toBeUndefined();
    const on = decide("permission", { ...DEFAULT_SETTINGS, notifyNeedsYouSound: true });
    expect(on?.native.sound).toBe("Ping");
  });

  it("warnings are quiet by default and can opt in to a banner", () => {
    expect(decide("agent-rate-limit", DEFAULT_SETTINGS)?.channels.native).toBe(false);
    const opted = decide("agent-rate-limit", { ...DEFAULT_SETTINGS, notifyWarningNative: true });
    expect(opted?.channels.native).toBe(true);
  });
});

describe("the catalog drives the groups", () => {
  it("every kind appears in exactly one group, with a label", () => {
    const seen = TIER_ORDER.flatMap((tier) => kindsInTier(tier).map((k) => k.kind));
    expect([...seen].sort()).toEqual([...kinds].sort());
    for (const kind of kinds) expect(catalogEntry(kind).label.length).toBeGreaterThan(0);
    expect(seen.every(isNotificationKind)).toBe(true);
  });
});
