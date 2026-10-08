import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const source = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(source, "../..");
const target = path.join(root, "src-tauri/resources/browser-use");
const require = createRequire(import.meta.url);
const playwright = path.dirname(require.resolve("playwright-core/package.json"));
if (Number(process.versions.node.split(".")[0]) < 20)
  throw new Error("Browser runtime requires Node.js 20 or later");
const copy = (from, to) => {
  if (
    existsSync(to) &&
    statSync(from).size === statSync(to).size &&
    readFileSync(from).equals(readFileSync(to))
  )
    return;
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
};
function tree(from, to) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".local-browsers" || entry.name.endsWith(".test.mjs")) continue;
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) tree(a, b);
    else if (entry.isFile()) copy(a, b);
  }
}
for (const name of [
  "runtime.mjs",
  "host.mjs",
  "worker.mjs",
  "extension-host.mjs",
  "extension-relay.mjs",
])
  copy(path.join(source, name), path.join(target, name));
tree(path.join(source, "extension"), path.join(target, "extension"));
copy(process.execPath, path.join(target, process.platform === "win32" ? "node.exe" : "node"));
const nodeDirectory = path.dirname(process.execPath);
const license = [path.join(nodeDirectory, "LICENSE"), path.join(nodeDirectory, "../LICENSE")].find(
  existsSync,
);
if (!license)
  throw new Error(
    "Node distribution LICENSE is missing; use an official Node distribution before bundling",
  );
copy(license, path.join(target, "Node-LICENSE.txt"));
tree(playwright, path.join(target, "node_modules/playwright-core"));
console.log(
  `[browser:bundle] Node ${process.versions.node}, Playwright ${JSON.parse(readFileSync(path.join(playwright, "package.json"), "utf8")).version}; runtime and licenses ready`,
);
