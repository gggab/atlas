import { spawnSync } from "node:child_process";
import { renameSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const icons = fileURLToPath(new URL("./extension/icons/", import.meta.url));
const cli = path.join(path.dirname(require.resolve("@tauri-apps/cli/package.json")), "tauri.js");
const sizes = [16, 32, 48, 128];
const result = spawnSync(
  process.execPath,
  [
    cli,
    "icon",
    path.join(icons, "icon.svg"),
    "--output",
    icons,
    ...sizes.flatMap((size) => ["--png", String(size)]),
  ],
  { stdio: "inherit", windowsHide: true },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("Browser icon rendering failed");
for (const size of sizes)
  renameSync(path.join(icons, `${size}x${size}.png`), path.join(icons, `icon-${size}.png`));
