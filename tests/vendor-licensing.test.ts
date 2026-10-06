import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = path.join(REPO_ROOT, "src-tauri");
const MATERIAL_VENDOR = path.join(
  REPO_ROOT,
  "crates",
  "atlas-icon-theme",
  "vendor",
  "material-icon-theme",
);
const BUNDLED_MATERIAL_LICENSE = "licenses/Material-Icon-Theme-LICENSE.txt";
const read = (file: string) => readFileSync(file, "utf8");
describe("the bundled Material Icon Theme keeps its MIT notice", () => {
  it("keeps the licence beside the icons it covers", () => {
    const license = read(path.join(MATERIAL_VENDOR, "LICENSE.txt"));
    expect(license).toMatch(/MIT License/i);
    expect(license, "the copyright line is the part MIT actually requires").toMatch(
      /Copyright \(c\) \d{4} Material Extensions/,
    );
  });

  it("records where the assets came from", () => {
    // Upstream, registry, version and date. Without it the next person to
    // update the icons cannot tell what they are updating *from*.
    const attribution = read(path.join(MATERIAL_VENDOR, "ATTRIBUTION.txt"));
    expect(attribution).toMatch(/material-extensions\/vscode-material-icon-theme/);
    expect(attribution).toMatch(/open-vsx\.org/);
    expect(attribution).toMatch(/\d+\.\d+\.\d+/);
    expect(attribution, "the CC BY-SA exclusion is a decision, not a preference").toMatch(
      /vscode-icons/,
    );
  });

  it("ships the licence in the built app bundle", () => {
    const conf = JSON.parse(read(path.join(REPO_ROOT, "src-tauri", "tauri.conf.json")));
    const resources = conf.bundle?.resources;
    const entries = Array.isArray(resources) ? resources : Object.keys(resources);
    expect(entries, "Material Icon Theme licence not bundled").toContain(BUNDLED_MATERIAL_LICENSE);
  });

  it("bundles a byte-identical copy", () => {
    expect(read(path.join(TAURI_DIR, BUNDLED_MATERIAL_LICENSE))).toBe(
      read(path.join(MATERIAL_VENDOR, "LICENSE.txt")),
    );
  });

  it("still has the icons the licence covers", () => {
    // A licence with nothing under it, or icons with no licence, are the same
    // failure seen from either end.
    const icons = readdirSync(path.join(MATERIAL_VENDOR, "icons")).filter((f) =>
      f.endsWith(".svg"),
    );
    expect(icons.length).toBeGreaterThan(1000);
    expect(existsSync(path.join(MATERIAL_VENDOR, "dist", "material-icons.json"))).toBe(true);
  });

  it("does not vendor vscode-icons, whose icons are CC BY-SA", () => {
    // Decision 12 names it explicitly. CC BY-SA would put a share-alike
    // obligation on anything Atlas ships alongside it, which MIT does not.
    const vendored = readdirSync(path.join(REPO_ROOT, "crates", "atlas-icon-theme", "vendor"));
    expect(vendored).not.toContain("vscode-icons");
  });
});
