// Upload to the existing Chrome item whose public key is in manifest.json.
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const playwright = path.dirname(require.resolve("playwright-core/package.json"));
const { yazl } = require(path.join(playwright, "lib/utilsBundle.js"));
const source = fileURLToPath(new URL("./extension/", import.meta.url));
const output = fileURLToPath(new URL("../../artifacts/browser-extension/", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
await mkdir(output, { recursive: true });
const target = path.join(output, `atlas-browser-${manifest.version}-chrome.zip`);
const zip = new yazl.ZipFile();
zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), "manifest.json");
for (const name of [
  "config.js",
  "background.js",
  "controller.js",
  "native-connection.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "icons/icon.svg",
  ...[16, 32, 48, 128].map((size) => `icons/icon-${size}.png`),
])
  zip.addFile(path.join(source, name), name);
await new Promise((resolve, reject) => {
  const destination = createWriteStream(target);
  destination.on("finish", resolve).on("error", reject);
  zip.outputStream.on("error", reject).pipe(destination);
  zip.end();
});
console.log(
  `[browser:package] Chrome update ZIP: ${target}. Update the existing store draft; store installation and review are separate release checks.`,
);
