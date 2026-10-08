import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Windows release packaging", () => {
  const workflow = () =>
    readFileSync(new URL("../.github/workflows/release-windows.yml", import.meta.url), "utf8");

  it("builds the production x64 MSI with the pinned toolchain", () => {
    const source = workflow();
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("runs-on: windows-2025");
    expect(source).toContain("jdx/mise-action@v2");
    expect(source).toContain("rustup toolchain install");
    expect(source).toContain("bun run build:app:win");
    expect(source).not.toContain("tauri.dev.conf.json");
  });

  it("verifies the package and records the source commit before uploading", () => {
    const source = workflow();
    expect(source).toContain("WindowsInstaller.Installer");
    expect(source).toContain("ProductVersion");
    expect(source).toContain("Get-FileHash");
    expect(source).toContain("$env:GITHUB_SHA");
    expect(source).toContain("if-no-files-found: error");
  });

  it("keeps publication separate from the read-only build job", () => {
    const source = workflow();
    expect(source).toContain("contents: read");
    expect(source).not.toContain("contents: write");
    expect(source).not.toContain("gh release create");
  });

  it("uses a Chinese MSI language so the product name is representable", () => {
    const config = JSON.parse(
      readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    );
    expect(config.productName).toBe("Atlas改");
    expect(config.bundle.windows.wix.language).toBe("zh-CN");
  });
});
