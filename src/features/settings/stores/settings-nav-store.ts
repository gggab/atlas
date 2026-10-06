import { create } from "zustand";

/**
 * Every section the Settings panel can show.
 *
 * Named rather than left as `string` because the callers that navigate here
 * (the sidebar's Skills button, the account menu) live nowhere near the panel:
 * a typo would compile, open Settings, and silently land on nothing. The
 * `SECTIONS` table in `settings-panel.tsx` is typed against this, so the two
 * cannot drift apart.
 */
export const SETTINGS_SECTIONS = [
  "general",
  "appearance",
  "icons",
  "layouts",
  "providers",
  "skills",
  "agents",
  "models",
  "keybindings",
  "about",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Cross-component signal to open the Settings tab on a specific section.
 *  Set `goTo(section)` before/after opening the (singleton, persistent) settings
 *  tab; `SettingsPanel` consumes it so the switch works whether the tab is
 *  freshly opened or already mounted on another section. */
interface SettingsNavState {
  section: SettingsSection | null;
  /** The section the mounted panel is showing right now (null: no panel) —
   *  what lets a notification know the user is already looking at its subject. */
  shown: string | null;
  goTo: (section: SettingsSection) => void;
  clear: () => void;
  setShown: (section: string | null) => void;
}

export const useSettingsNav = create<SettingsNavState>((set) => ({
  section: null,
  shown: null,
  goTo: (section) => set({ section }),
  clear: () => set({ section: null }),
  setShown: (shown) => set({ shown }),
}));
