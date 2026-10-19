import { mkdir, copyFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const escapeXml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c],
  );
const plist = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${body}</dict></plist>`;

export function helperInfo(identifier, version) {
  return plist(
    `<key>CFBundleIdentifier</key><string>${escapeXml(identifier)}.background</string><key>CFBundleExecutable</key><string>atlas-background</string><key>CFBundleName</key><string>DeskMate Background</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${escapeXml(version)}</string><key>CFBundleShortVersionString</key><string>${escapeXml(version)}</string><key>LSUIElement</key><true/>`,
  );
}

async function prepare() {
  if (process.platform !== "darwin") return;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const base = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const overlay = process.env.TAURI_CONFIG ? JSON.parse(process.env.TAURI_CONFIG) : {};
  const config = { ...base, ...overlay };
  const target = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (!target?.endsWith("apple-darwin")) throw new Error("Missing macOS TAURI_ENV_TARGET_TRIPLE");
  const buildProfile = process.env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";
  const binary = path.resolve(
    process.env.CARGO_TARGET_DIR || path.join(root, "target"),
    target,
    buildProfile,
    "atlas",
  );
  const contents = path.join(root, "output/background-package/DeskMate Background.app/Contents");
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  await mkdir(path.join(contents, "Resources"), { recursive: true });
  await copyFile(binary, path.join(contents, "MacOS/atlas-background"));
  await chmod(path.join(contents, "MacOS/atlas-background"), 0o755);
  await writeFile(path.join(contents, "Info.plist"), helperInfo(config.identifier, config.version));
  const identity =
    process.env.APPLE_SIGNING_IDENTITY ||
    overlay.bundle?.macOS?.signingIdentity ||
    base.bundle?.macOS?.signingIdentity ||
    "-";
  const signed = spawnSync(
    "/usr/bin/codesign",
    [
      "--force",
      "--options",
      "runtime",
      ...(identity === "-" ? [] : ["--timestamp"]),
      "--entitlements",
      path.join(root, "src-tauri/entitlements.plist"),
      "--sign",
      identity,
      path.dirname(contents),
    ],
    { stdio: "inherit" },
  );
  if (signed.error || signed.status !== 0)
    throw new Error("macOS background helper signing failed");
  const verified = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", path.dirname(contents)],
    { stdio: "inherit" },
  );
  if (verified.error || verified.status !== 0)
    throw new Error("macOS background helper signature verification failed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await prepare();
