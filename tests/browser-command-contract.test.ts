import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../src-tauri/src/commands/browser.rs", import.meta.url),
  "utf8",
);

describe("native browser creation threading", () => {
  // WebView2 creation deadlocks inside a synchronous main-thread IPC handler.
  // Both entry points must use Tauri's async dispatch or an async function.
  it.each(["browser_embed_create", "browser_open_window"])(
    "%s is dispatched off the main thread",
    (command) => {
      const declaration = source.match(
        new RegExp(
          `(#\\[tauri::command(?:\\([^)]*\\))?\\])\\s+pub\\s+(async\\s+)?fn\\s+${command}\\b`,
        ),
      );
      expect(declaration, `${command} must remain a registered command`).not.toBeNull();
      expect(
        declaration?.[1].includes("(async)") || Boolean(declaration?.[2]),
        `${command} must not create a WebView2 on the IPC main thread`,
      ).toBe(true);
    },
  );
});
