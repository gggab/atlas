import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeConnection } from "./native-connection.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

test("the unpacked extension identity matches the native host allowlist", async () => {
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  const id = [
    ...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16),
  ]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
  assert.equal(
    id,
    "falkhmhmbghdjcabgojjooddbhjpmmfd",
    "Use the assigned Chrome Web Store public key",
  );
  const host = await readFile(
    new URL("../../../src-tauri/src/browser_native.rs", import.meta.url),
    "utf8",
  );
  assert.ok(host.includes(`EXTENSION_ID: &str = "${id}"`));
});

test("installation connects automatically to its packaged host, ignoring old manual preferences", async () => {
  const stored = { autoConnect: false, hostName: "com.atlas.browser.dev", clientId: "profile" },
    sent = [],
    opened = [];
  let receive, disconnect;
  const port = {
    onMessage: {
      addListener: (fn) => {
        receive = fn;
      },
    },
    onDisconnect: {
      addListener: (fn) => {
        disconnect = fn;
      },
    },
    postMessage: (message) => sent.push(message),
    disconnect() {},
  };
  const connection = new NativeConnection(
    {
      storage: {
        local: { get: async () => stored, set: async (value) => Object.assign(stored, value) },
      },
      runtime: {
        connectNative: (name) => {
          assert.equal(name, "com.atlas.browser");
          return port;
        },
        getManifest: () => ({ version: "0.3.0" }),
      },
      alarms: { onAlarm: { addListener() {} }, create: async () => {}, clear: async () => {} },
    },
    { connect: async (...args) => opened.push(args), disconnect: async () => {} },
  );
  connection.api.storage.session = { get: async () => ({}), set: async () => {} };
  await connection.restore();
  assert.equal(sent[0].clientId, "profile");
  assert.equal(sent[0].version, "0.3.0");
  await receive({ type: "bridgeReady" });
  await connection.receive(port, {
    type: "start",
    id: "task",
    endpoint: "private-task-address",
    title: "Search",
  });
  assert.deepEqual(opened, [["private-task-address", undefined, "Search", undefined]]);
  assert.deepEqual(sent.at(-1), { id: "task", result: true });
  await connection.receive(port, { type: "unbound" });
  disconnect();
  await connection.connect();
  assert.equal(connection.port, port);
  assert.equal(connection.enabled, true);
  disconnect();
  assert.ok(connection.status().connectionError);
  assert.equal(
    Object.hasOwn(connection.status(), "error"),
    false,
    "Connection status must not masquerade as an action failure",
  );
});

test("manifest icons exist at their declared raster sizes and popup has no manual host controls", async () => {
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  for (const [size, name] of Object.entries(manifest.icons)) {
    const png = await readFile(new URL(name, import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
  }
  const popup = await readFile(new URL("./popup.html", import.meta.url), "utf8");
  assert.equal(/host-name|enableAutomatic|disableAutomatic/.test(popup), false);
});
