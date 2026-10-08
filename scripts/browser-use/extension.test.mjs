import assert from "node:assert/strict";
import { test } from "node:test";
import { ExtensionRelay, ws } from "./extension-relay.mjs";
import { ExtensionHost } from "./extension-host.mjs";

test("extension relay rejects web origins and wrong pairing secrets", async () => {
  const relay = new ExtensionRelay();
  await relay.start();
  try {
    for (const [url, origin] of [
      [relay.endpoint, "https://example.com"],
      [relay.endpoint + "wrong", "chrome-extension://" + "a".repeat(32)],
    ]) {
      const client = new ws(url, { origin });
      const status = await new Promise((resolve) => {
        client.on("unexpected-response", (_req, res) => {
          res.resume();
          client.terminate();
          resolve(res.statusCode);
        });
        client.on("error", () => {});
      });
      assert.equal(status, 403);
    }
  } finally {
    await relay.close();
  }
});

test("only explicitly shared targets are visible and disconnect preserves pages", async () => {
  const relay = new ExtensionRelay();
  await relay.start();
  const client = new ws(relay.endpoint, { origin: "chrome-extension://" + "a".repeat(32) });
  await new Promise((resolve) => client.once("open", resolve));
  client.send(
    JSON.stringify({
      type: "ready",
      targetInfo: { targetId: "shared", type: "page", title: "Shared", url: "https://example.com" },
      userAgent: "Chrome/140.0.0.0",
    }),
  );
  await new Promise((resolve) => relay.once("ready", resolve));
  assert.deepEqual(
    (await relay.command("Target.getTargets", {})).targetInfos.map((t) => t.targetId),
    ["shared"],
  );
  await assert.rejects(
    relay.command("Target.attachToTarget", { targetId: "private" }),
    /not shared/,
  );
  await assert.rejects(relay.command("Browser.close", {}), /Unsupported/);
  await assert.rejects(relay.command("Target.closeTarget", { targetId: "shared" }), /preserved/);
  const commands = [];
  client.on("message", (data) => commands.push(JSON.parse(data)));
  const closed = new Promise((resolve) => client.once("close", resolve));
  await relay.close();
  await closed;
  assert.deepEqual(commands, []);
});

test("finished turns release extension control without closing the user context", async () => {
  let disconnected = false;
  const host = new ExtensionHost({ check: async () => {} });
  host.relay = {
    close: async () => {
      disconnected = true;
    },
  };
  host.connection = { close: async () => {} };
  host.context = {
    close: async () => {
      throw new Error("Must preserve browser context");
    },
  };
  assert.equal((await host.cleanup()).keepAlive, false);
  assert.equal(disconnected, true);
});
