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
  assert.ok(host.includes('EDGE_EXTENSION_ID: &str = "dpjekhhlbnbbpcjampjnmffnpnndpcci"'));
  const bridge = await readFile(
    new URL("../../../src-tauri/src/commands/browser_bridge.rs", import.meta.url),
    "utf8",
  );
  assert.ok(bridge.includes('"allowed_origins":browser_native::extension_origins()'));
});

test("installation connects automatically to its packaged host, ignoring old manual preferences", async () => {
  const stored = {
      autoConnect: false,
      hostName: "com.atlas.browser.dev",
      clientId: "profile",
      browserDataConsent: 1,
    },
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

test("page access requires explicit consent and revocation stops control before persistence", async () => {
  const local = { browserDataConsent: true },
    session = { shareNextTab: 7 },
    opened = [],
    stopped = [];
  const port = {
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
    postMessage() {},
  };
  const api = {
    storage: {
      local: { get: async () => local, set: async (value) => Object.assign(local, value) },
      session: { get: async () => session, set: async (value) => Object.assign(session, value) },
    },
    runtime: { connectNative: () => port, getManifest: () => ({ version: "0.3.2" }) },
    alarms: { onAlarm: { addListener() {} }, create: async () => {} },
    tabs: { get: async () => ({ url: "https://example.com" }) },
  };
  const connection = new NativeConnection(api, {
    connect: async (...args) => opened.push(args),
    disconnect: async () => stopped.push(true),
  });
  await connection.restore();
  await connection.receive(port, { type: "bridgeReady" });
  assert.equal(connection.status().appConnected, true, "Metadata connection stays automatic");
  assert.equal(connection.status().dataConsent, false, "Old preferences are not consent");
  const start = { type: "start", id: "task", endpoint: "task-address" };
  await connection.receive(port, start);
  assert.equal(opened.length, 0);
  await assert.rejects(connection.share(7), /consent/i);
  await assert.rejects(connection.setConsent("yes"), /boolean/i);
  await connection.setConsent(true);
  assert.equal(local.browserDataConsent, 1);
  await connection.receive(port, start);
  assert.equal(opened.length, 1);
  await connection.share(7);
  let finishSave;
  api.storage.local.set = (value) =>
    new Promise((resolve) => {
      finishSave = () => {
        Object.assign(local, value);
        resolve();
      };
    });
  const revoking = connection.setConsent(false);
  assert.equal(stopped.length, 1, "Stop active control without waiting for storage");
  assert.equal(connection.status().dataConsent, false);
  assert.equal(connection.shareNextTab, undefined);
  await connection.receive(port, start);
  assert.equal(opened.length, 1);
  assert.throws(() => connection.requireConsent(), /consent/i);
  finishSave();
  await revoking;
  assert.equal(local.browserDataConsent, null);
  assert.equal(session.shareNextTab, null);
  api.storage.local.set = async (value) => Object.assign(local, value);
  await connection.restore();
  assert.equal(connection.status().dataConsent, false, "Revocation survives worker restart");
  let releaseGrant;
  api.storage.local.set = (value) =>
    value.browserDataConsent === 1
      ? new Promise((resolve) => {
          releaseGrant = () => {
            Object.assign(local, value);
            resolve();
          };
        })
      : Promise.resolve(Object.assign(local, value));
  const granting = connection.setConsent(true);
  const withdrawing = connection.setConsent(false);
  assert.equal(connection.status().dataConsent, false);
  releaseGrant();
  await Promise.all([granting, withdrawing]);
  assert.equal(connection.status().dataConsent, false, "A pending grant cannot undo withdrawal");
  assert.equal(local.browserDataConsent, null);
});
