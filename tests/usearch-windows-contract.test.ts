import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Windows vector backend", () => {
  for (const crate of ["atlas-memory", "atlas-retrieval"]) {
    it(`${crate} cannot re-enable NumKong through Cargo feature unification`, () => {
      const manifest = readFileSync(`crates/${crate}/Cargo.toml`, "utf8");
      const [shared, otherTargets] = manifest.split("[target.'cfg(not(windows))'.dependencies]");
      expect(shared).toMatch(/usearch\s*=\s*\{[^}]*default-features\s*=\s*false/);
      expect(shared).not.toMatch(/features\s*=\s*\[[^\]]*"numkong"/);
      expect(otherTargets).toMatch(/usearch\s*=\s*\{[^}]*features\s*=\s*\["numkong"\]/);
    });
  }
});
