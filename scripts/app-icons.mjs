#!/usr/bin/env node
/** Render DeskMate's shared SVG brand into desktop, browser and landing assets. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ICONS_DIR = path.join(ROOT, "src-tauri/icons/app-icons");
const NATIVE = path.join(ROOT, "src-tauri/icons");
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve("@tauri-apps/cli/package.json")), "tauri.js");
const { PNG } = require(
  path.join(path.dirname(require.resolve("playwright-core/package.json")), "lib/utilsBundle.js"),
);

export function readManifest() {
  return JSON.parse(readFileSync(path.join(ICONS_DIR, "app-icons.json"), "utf8"));
}

export function sourcesHash(manifest = readManifest()) {
  const hash = createHash("sha256");
  hash.update(`default:${manifest.default}\n`);
  for (const icon of manifest.icons) {
    hash.update(`${icon.id}:${icon.source}\n`);
    hash.update(readFileSync(path.join(ROOT, icon.source)));
  }
  hash.update(readFileSync(path.join(NATIVE, "dmg-background.svg")));
  return hash.digest("hex");
}

export function staleOutputs(manifest = readManifest()) {
  const expected = [
    "src-tauri/icons/Icon.icns",
    "src-tauri/icons/icon.ico",
    "src-tauri/icons/app-icon-source.png",
    "src-tauri/icons/dmg-background.png",
    "src-tauri/icons/dmg-icon.icns",
  ];
  for (const icon of manifest.icons) {
    if (icon.id !== manifest.default)
      expected.push(`src-tauri/icons/app-icons/dock/${icon.id}.icns`);
  }
  for (const size of [16, 32, 48, 128])
    expected.push(`scripts/browser-use/extension/icons/icon-${size}.png`);
  const problems = expected
    .filter((file) => !existsSync(path.join(ROOT, file)))
    .map((file) => `${file} is missing`);
  const source = readFileSync(
    path.join(ROOT, manifest.icons.find((icon) => icon.id === manifest.default).source),
  );
  for (const file of ["scripts/browser-use/extension/icons/icon.svg", "landing/icon-sm.svg"]) {
    if (!existsSync(path.join(ROOT, file)) || !readFileSync(path.join(ROOT, file)).equals(source))
      problems.push(`${file} differs from the default source`);
  }
  const stamp = path.join(ICONS_DIR, "sources.sha256");
  if (!existsSync(stamp) || readFileSync(stamp, "utf8").trim() !== sourcesHash(manifest))
    problems.push("sources changed since the last render");
  return problems;
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, "icon", ...args], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Tauri icon rendering failed (${result.status})`);
}

function render() {
  const manifest = readManifest();
  const source = manifest.icons.find((icon) => icon.id === manifest.default)?.source;
  if (!source) throw new Error("The default icon is not listed in the manifest");
  const work = mkdtempSync(path.join(tmpdir(), "deskmate-icons-"));
  if (
    path.dirname(path.resolve(work)) !== path.resolve(tmpdir()) ||
    !path.basename(work).startsWith("deskmate-icons-")
  )
    throw new Error("Refusing to use an unexpected icon render directory");
  try {
    run([path.join(ROOT, source), "--output", NATIVE]);
    renameSync(path.join(NATIVE, "icon.icns"), path.join(NATIVE, "Icon.icns"));
    run([path.join(ROOT, source), "--output", work, "--png", "256", "--png", "1024"]);
    copyFileSync(path.join(work, "256x256.png"), path.join(NATIVE, "256x256.png"));
    copyFileSync(path.join(work, "1024x1024.png"), path.join(NATIVE, "app-icon-source.png"));
    copyFileSync(path.join(NATIVE, "Icon.icns"), path.join(NATIVE, "dmg-icon.icns"));
    const dock = path.join(ICONS_DIR, "dock");
    mkdirSync(dock, { recursive: true });
    for (const icon of manifest.icons) {
      if (icon.id === manifest.default) continue;
      const output = path.join(work, icon.id);
      run([path.join(ROOT, icon.source), "--output", output]);
      copyFileSync(path.join(output, "icon.icns"), path.join(dock, `${icon.id}.icns`));
    }
    for (const target of ["scripts/browser-use/extension/icons/icon.svg", "landing/icon-sm.svg"])
      copyFileSync(path.join(ROOT, source), path.join(ROOT, target));
    const browser = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/browser-use/icons.mjs")],
      { stdio: "inherit", windowsHide: true },
    );
    if (browser.error) throw browser.error;
    if (browser.status !== 0) throw new Error("Browser icon rendering failed");
    run([path.join(NATIVE, "dmg-background.svg"), "--output", work, "--png", "512"]);
    const full = PNG.sync.read(readFileSync(path.join(work, "512x512.png")));
    const background = new PNG({ width: 512, height: 352 });
    PNG.bitblt(full, background, 0, 0, 512, 352, 0, 0);
    writeFileSync(path.join(NATIVE, "dmg-background.png"), PNG.sync.write(background));
    writeFileSync(path.join(ICONS_DIR, "sources.sha256"), `${sourcesHash(manifest)}\n`);
    const problems = staleOutputs(manifest);
    if (problems.length) throw new Error(problems.join("\n"));
    console.log("DeskMate icons: desktop, browser and landing assets rendered.");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--check")) {
      const problems = staleOutputs();
      if (problems.length) throw new Error(`${problems.join("\n")}\nRun bun run icons:render.`);
      console.log("DeskMate icons: all generated assets are current.");
    } else render();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
