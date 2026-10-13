/**
 * Chords the operating system takes before Atlas ever sees them.
 *
 * Binding one is allowed — Atlas can't stop the user, and on a machine with
 * the system shortcut turned off it even works — so this is a warning shown
 * while recording, not a rejection. The list is deliberately short: only
 * chords the OS itself owns, where the binding would appear to do nothing.
 * ⌘W and friends are Atlas's to bind; the webview hands them over.
 */

import { isMac } from "@/lib/platform";
import { type Combo, effectiveCombo, serializeCombo } from "./combo";

const MAC_RESERVED: Record<string, string> = {
  "cmd+q": "macOS quits DeskMate with this.",
  "cmd+h": "macOS hides DeskMate with this.",
  "cmd+alt+h": "macOS hides other apps with this.",
  "cmd+m": "macOS minimizes the window with this.",
  "cmd+space": "Spotlight takes this.",
  "ctrl+space": "macOS switches input source with this.",
  "cmd+tab": "The app switcher takes this.",
  "cmd+`": "macOS cycles DeskMate's windows with this.",
  "cmd+alt+escape": "Force Quit takes this.",
  "cmd+shift+3": "macOS screenshots take this.",
  "cmd+shift+4": "macOS screenshots take this.",
  "cmd+shift+5": "macOS screenshots take this.",
  "ctrl+left": "Mission Control switches Spaces with this.",
  "ctrl+right": "Mission Control switches Spaces with this.",
  "ctrl+up": "Mission Control takes this.",
  "ctrl+down": "App Exposé takes this.",
  // The system Cancel chord: swallowed before the webview, which is why the
  // project sidebar's default carries Shift.
  "cmd+.": "macOS reserves this as Cancel; it never reaches DeskMate.",
};

const OTHER_RESERVED: Record<string, string> = {
  "alt+tab": "The window switcher takes this.",
  "alt+f4": "The window manager closes windows with this.",
  "cmd+alt+delete": "The system takes this.",
};

/** Why this chord may never reach DeskMate, or null if nothing claims it. */
export function reservedReason(combo: Combo, mac: boolean = isMac): string | null {
  const table = mac ? MAC_RESERVED : OTHER_RESERVED;
  return table[serializeCombo(effectiveCombo(combo, mac))] ?? null;
}
