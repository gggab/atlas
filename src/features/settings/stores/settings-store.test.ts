// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import builtinThemes from "@/dev/mock-backend/fixtures/builtin-themes.json";
import { applyTheme } from "@/features/theme/apply-theme";
import type { Theme } from "@/features/theme/lib/theme-api";
import { DEFAULT_SETTINGS, type AppSettings } from "../lib/app-settings";

const applyConfiguredTheme = vi.fn();
const applyConfiguredIconTheme = vi.fn();
const updateAtlasConfig = vi.fn();
let configChanged: ((payload: { settings: AppSettings; generation: number }) => void) | undefined;

vi.mock("@/features/theme/stores/theme-store", () => ({
  applyConfiguredTheme: (...args: unknown[]) => applyConfiguredTheme(...args),
}));
vi.mock("@/features/icon-theme/stores/icon-theme-store", () => ({
  applyConfiguredIconTheme: (...args: unknown[]) => applyConfiguredIconTheme(...args),
}));
vi.mock("@/features/settings/lib/ui-scale", () => ({ DEFAULT_SCALE: 1, applyUiScale: () => {} }));
vi.mock("@/features/settings/lib/atlas-config-api", () => ({
  updateSettings: (...args: unknown[]) => updateAtlasConfig(...args),
  resetConfig: vi.fn(),
  onConfigChanged: (callback: typeof configChanged) => {
    configChanged = callback;
    return Promise.resolve(() => {});
  },
  onConfigError: () => Promise.resolve(() => {}),
}));

const { useSettingsStore } = await import("./settings-store");

/** What IPC hands back: equal by value, never the same object. */
const fromRust = (settings: AppSettings): AppSettings => JSON.parse(JSON.stringify(settings));

const OVERRIDES = { base: { background: "navy" }, keys: { "syntax.keyword": "teal" } };

beforeEach(() => {
  useSettingsStore.getState().actions.hydrate({
    settings: {
      ...DEFAULT_SETTINGS,
      themeMode: "dark",
      themeOverrides: OVERRIDES,
      notificationsMigrated: true,
      notifyKindsMigrated: true,
    },
    configGeneration: 1,
  });
  vi.clearAllMocks();
});

describe("notification settings migration on hydrate", () => {
  it("persists the migrated tier settings once, and not for a file that failed to load", async () => {
    updateAtlasConfig.mockImplementation(async (patch: Partial<AppSettings>) => ({
      kind: "applied",
      settings: fromRust({ ...useSettingsStore.getState().settings, ...patch }),
      generation: 2,
    }));
    const legacy = { ...DEFAULT_SETTINGS, terminalNotifyNative: false };
    useSettingsStore.getState().actions.hydrate({
      settings: legacy,
      configGeneration: 1,
      configStatus: { status: "usingDefaults", error: "bad toml" },
    });
    expect(updateAtlasConfig).not.toHaveBeenCalled();

    useSettingsStore.getState().actions.hydrate({ settings: legacy, configGeneration: 1 });
    expect(updateAtlasConfig).toHaveBeenCalledTimes(1);
    expect(updateAtlasConfig.mock.calls[0]?.[0]).toMatchObject({
      notifyNeedsYouNative: false,
      notificationsMigrated: true,
    });
    await vi.waitFor(() =>
      expect(useSettingsStore.getState().settings.notificationsMigrated).toBe(true),
    );
  });
});

describe("settings side effects", () => {
  it("persists model favorites through the configuration API without reapplying appearance", async () => {
    const favoriteModels = ["codex:example", "claude-code:example"];
    updateAtlasConfig.mockImplementation(async () => ({
      kind: "applied",
      settings: fromRust({ ...useSettingsStore.getState().settings, favoriteModels }),
      generation: 2,
    }));
    useSettingsStore.getState().actions.updateSettings({ favoriteModels });
    await vi.waitFor(() => expect(useSettingsStore.getState().configGeneration).toBe(2));
    expect(updateAtlasConfig.mock.calls[0]?.[0]).toEqual({ favoriteModels });
    expect(useSettingsStore.getState().settings.favoriteModels).toEqual(favoriteModels);
    expect(applyConfiguredTheme).not.toHaveBeenCalled();
    expect(applyConfiguredIconTheme).not.toHaveBeenCalled();
  });

  /**
   * Every IPC result is a freshly parsed object, so a reference test on
   * `themeOverrides` re-applied the whole theme on every settings write —
   * once on the reconcile, again on the `atlas:config-changed` echo — and each
   * apply collapses mermaid diagrams and re-themes every terminal.
   */
  it("does not re-apply the theme for an unrelated setting", async () => {
    updateAtlasConfig.mockImplementation(async () => ({
      kind: "applied",
      settings: fromRust({ ...useSettingsStore.getState().settings, enterToSend: false }),
      generation: 2,
    }));

    useSettingsStore.getState().actions.updateSettings({ enterToSend: false });
    await vi.waitFor(() => expect(useSettingsStore.getState().configGeneration).toBe(2));
    configChanged?.({ settings: fromRust(useSettingsStore.getState().settings), generation: 3 });

    expect(applyConfiguredTheme).not.toHaveBeenCalled();
    expect(applyConfiguredIconTheme).not.toHaveBeenCalled();
  });

  it("does re-apply when an override actually changes", () => {
    const next = { ...OVERRIDES, keys: { "syntax.keyword": "olive" } };
    configChanged?.({
      settings: fromRust({ ...useSettingsStore.getState().settings, themeOverrides: next }),
      generation: 2,
    });

    expect(applyConfiguredTheme).toHaveBeenCalledTimes(1);
    expect(applyConfiguredTheme).toHaveBeenCalledWith("atlas", "dark", next);
  });

  it("ignores key order inside the overrides", () => {
    const reordered = { keys: OVERRIDES.keys, base: OVERRIDES.base };
    configChanged?.({
      settings: { ...useSettingsStore.getState().settings, themeOverrides: reordered },
      generation: 2,
    });
    expect(applyConfiguredTheme).not.toHaveBeenCalled();
  });
});

describe("icon appearance", () => {
  /**
   * Icons used to follow the REQUESTED mode. Monokai has no light variant, so
   * under Light it resolves — and paints — dark, and light icons on it were
   * the wrong half of the icon theme.
   */
  it("follows the appearance the theme actually resolved to", () => {
    const [rosePine, monokai] = ["rose-pine", "monokai"].map((id) =>
      (builtinThemes as Theme[]).find((theme) => theme.id === id)!,
    );
    // On a light theme under Light, icons are light.
    applyTheme(rosePine, "light");
    expect(applyConfiguredIconTheme).toHaveBeenLastCalledWith(DEFAULT_SETTINGS.iconTheme, "light");

    // Switch to Monokai, still under Light. The mode did not change — the
    // appearance did — and what the theme store does once the file is loaded
    // is apply it.
    configChanged?.({
      settings: { ...useSettingsStore.getState().settings, theme: "monokai", themeMode: "light" },
      generation: 2,
    });
    applyTheme(monokai, "light");

    expect(applyConfiguredIconTheme).toHaveBeenLastCalledWith(DEFAULT_SETTINGS.iconTheme, "dark");
  });

  it("uses the resolved appearance for a new icon theme, too", () => {
    const rosePine = (builtinThemes as Theme[]).find((theme) => theme.id === "rose-pine")!;
    applyTheme(rosePine, "light");
    vi.clearAllMocks();

    configChanged?.({
      settings: { ...useSettingsStore.getState().settings, iconTheme: "seti" },
      generation: 2,
    });

    expect(applyConfiguredIconTheme).toHaveBeenCalledTimes(1);
    expect(applyConfiguredIconTheme).toHaveBeenCalledWith("seti", "light");
  });
});
