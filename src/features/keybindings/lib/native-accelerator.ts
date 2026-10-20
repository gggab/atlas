import { isMac } from "@/lib/platform";
import type { Combo } from "./combo";

/**
 * A chord in Tauri's accelerator spelling for the native Window ▸ Close Tab
 * item. Keep it aligned with the frontend tab shortcut. See `src-tauri/src/menu.rs`.
 *
 * Null for a chord Tauri can't express; the caller leaves the item unbound
 * rather than guessing at a near-miss.
 */
export function toNativeAccelerator(combo: Combo, mac: boolean = isMac): string | null {
  const key = nativeKey(combo.code);
  if (!key) return null;
  const parts: string[] = [];
  if (mac) {
    if (combo.meta) parts.push("Cmd");
    if (combo.ctrl) parts.push("Control");
  } else if (combo.meta || combo.ctrl) {
    // Off macOS `cmd` is Ctrl; both flags together is Ctrl+Super.
    parts.push("Control");
    if (combo.meta && combo.ctrl) parts.push("Super");
  }
  if (combo.alt) parts.push("Alt");
  if (combo.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Letters, digits, F-keys and the named keys. Punctuation is deliberately
 *  absent: its accelerator spelling varies by platform and layout, and a
 *  menu item is not worth guessing wrong on. */
function nativeKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

const NAMED: Record<string, string> = {
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};
