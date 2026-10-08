import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserHost } from "./host.mjs";

function fixture() {
  let allowed = true;
  const host = new BrowserHost({
    browser: "chrome",
    check: async () => {
      if (!allowed) throw new Error("Browser paused");
    },
  });
  const closed = [];
  host.context = { close: async () => closed.push("window") };
  for (const id of ["temporary", "result", "login"])
    host.pages.set(id, {
      isClosed: () => closed.includes(id),
      url: () => "about:blank",
      title: async () => id,
      close: async () => {
        closed.push(id);
        host.pages.delete(id);
      },
    });
  return {
    host,
    closed,
    pause: () => {
      allowed = false;
    },
  };
}

test("turn cleanup closes temporary pages and retains result and login handoff pages", async () => {
  const { host, closed } = fixture();
  await host.call("mark", { id: "result", disposition: "deliverable" });
  await host.call("mark", { id: "login", disposition: "handoff" });
  const result = await host.cleanup();
  assert.deepEqual(closed, ["temporary"]);
  assert.equal(result.keepAlive, true);
  assert.deepEqual(
    result.tabs.map((tab) => tab.id),
    ["result", "login"],
  );
  await host.call("mark", { id: "result", disposition: "temporary" });
  await host.call("mark", { id: "login", disposition: "temporary" });
  assert.equal((await host.cleanup()).keepAlive, false);
  assert.deepEqual(closed, ["temporary", "result", "login", "window"]);
});

test("revoked cleanup cannot close retained or temporary pages", async () => {
  const { host, closed, pause } = fixture();
  pause();
  await assert.rejects(host.cleanup(), /paused/);
  assert.deepEqual(closed, []);
});
