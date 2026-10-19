import test from "node:test";
import assert from "node:assert/strict";
import { helperInfo } from "./package.mjs";

test("helper has a distinct macOS identity without changing the data profile", () => {
  const info = helperInfo("dev.atlas.ide.dev", "0.4.1");
  assert.match(info, /dev\.atlas\.ide\.dev\.background/);
  assert.match(info, /<key>LSUIElement<\/key><true\/>/);
  assert.match(info, /atlas-background/);
});
