import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { yauzl } = require(
  path.join(path.dirname(require.resolve("playwright-core/package.json")), "lib/utilsBundle.js"),
);

function readZip(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const files = new Map();
      zip.on("error", reject);
      zip.on("end", () => resolve(files));
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error) {
            zip.close();
            return reject(error);
          }
          const chunks = [];
          stream.on("error", (error) => {
            zip.close();
            reject(error);
          });
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

test("store ZIPs omit the Edge key while preserving Chrome identity and packaged assets", async () => {
  const source = await readFile(new URL("./extension/manifest.json", import.meta.url));
  const manifest = JSON.parse(source);
  assert.equal(manifest.name, "DeskMate Browser");
  assert.equal(manifest.action.default_title, "DeskMate Browser");
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*", "file:///*"]);
  execFileSync(process.execPath, [fileURLToPath(new URL("./package.mjs", import.meta.url))]);
  const packages = [];
  for (const browser of ["chrome", "edge"]) {
    const files = await readZip(
      fileURLToPath(
        new URL(
          `../../artifacts/browser-extension/deskmate-browser-${manifest.version}-${browser}.zip`,
          import.meta.url,
        ),
      ),
    );
    assert.equal(files.size, 14);
    const packaged = JSON.parse(files.get("manifest.json"));
    if (browser === "edge")
      assert.equal(Object.hasOwn(packaged, "key"), false, "Edge rejects the key field");
    else assert.equal(packaged.key, manifest.key, "Chrome must keep its assigned public key");
    assert.deepEqual({ ...packaged, key: undefined }, { ...manifest, key: undefined });
    for (const [name, content] of files) {
      if (name === "manifest.json") continue;
      assert.equal(/test|secret|node_modules/.test(name), false);
      assert.deepEqual(content, await readFile(new URL(`./extension/${name}`, import.meta.url)));
    }
    packages.push(files);
  }
  assert.deepEqual([...packages[0].keys()].sort(), [...packages[1].keys()].sort());
  assert.deepEqual(await readFile(new URL("./extension/manifest.json", import.meta.url)), source);
});
