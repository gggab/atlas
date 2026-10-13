import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ICONS_DIR, readManifest, staleOutputs } from "../scripts/app-icons.mjs";

/** Guards shared SVG sources, native outputs and the cross-platform renderer. */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readManifest();
const ids = manifest.icons.map((icon) => icon.id);

function readJson(rel: string) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8"));
}

describe("app icon manifest", () => {
  it("lists unique plain ids, and the default is one of them", () => {
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ids).size).toBe(ids.length);
    // Same rule as `app_icon::is_valid_id`: the id names a file.
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ids).toContain(manifest.default);
  });

  it("uses an existing square SVG source for each preserved icon id", () => {
    expect(ids).toEqual(["dark", "light"]);
    for (const icon of manifest.icons) {
      expect(icon.source).toMatch(/^src\/assets\/deskmate-icon(?:-light)?\.svg$/);
      expect(readFileSync(path.join(REPO_ROOT, icon.source), "utf8")).toContain(
        'viewBox="0 0 1024 1024"',
      );
    }
  });

  it("has a rendered .icns for every id but the default, and nothing else", () => {
    const dock = readdirSync(path.join(ICONS_DIR, "dock")).filter((n) => n !== ".DS_Store");
    const expected = ids.filter((id) => id !== manifest.default).map((id) => `${id}.icns`);
    expect(dock.sort()).toEqual(expected.sort());
  });

  it("has renders that match the current sources", () => {
    expect(staleOutputs(manifest)).toEqual([]);
  });

  it("checks committed outputs through the CLI on every platform", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts/app-icons.mjs"), "--check"],
      { encoding: "utf8" },
    );
    expect(output).toContain("all generated assets are current");
  });

  it("shares the default source with the browser and landing page", () => {
    const source = readFileSync(path.join(REPO_ROOT, manifest.icons[0].source));
    for (const file of ["scripts/browser-use/extension/icons/icon.svg", "landing/icon-sm.svg"])
      expect(readFileSync(path.join(REPO_ROOT, file))).toEqual(source);
    const background = readFileSync(path.join(REPO_ROOT, "src-tauri/icons/dmg-background.png"));
    expect([background.readUInt32BE(16), background.readUInt32BE(20)]).toEqual([512, 352]);
  });
});

describe("tauri config", () => {
  const conf = readJson("src-tauri/tauri.conf.json");
  const macos = readJson("src-tauri/tauri.macos.conf.json");

  it("bundles the new flat ICNS instead of the old compiled brand", () => {
    const icons: string[] = conf.bundle.icon;
    expect(icons).toContain("icons/Icon.icns");
    expect(icons).not.toContain("icons/app-icons/Assets.car");
    expect(existsSync(path.join(REPO_ROOT, "src-tauri", "icons/Icon.icns"))).toBe(true);
    // Icon Composer sources would restore the removed Xcode-only build path.
    expect(icons.filter((i) => i.endsWith(".icon"))).toEqual([]);
  });

  it("ships the rendered icons on macOS only, where app_icon.rs reads them", () => {
    expect(macos.bundle.resources).toEqual({ "icons/app-icons/dock/": "icons/app-icons/" });
    const shared = Object.keys(conf.bundle.resources ?? {});
    expect(shared.filter((k) => k.includes("app-icons") || k.endsWith(".icns"))).toEqual([]);
  });
});
