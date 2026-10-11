import assert from "node:assert/strict";
import { test } from "node:test";
import { ExtensionController, validateEndpoint } from "./controller.js";
import { ExtensionRelay, ws } from "../extension-relay.mjs";

test("extension accepts only Atlas local secret addresses", () => {
  const valid = "ws://127.0.0.1:1234/extension/" + "a".repeat(64);
  assert.equal(validateEndpoint(valid), valid);
  for (const address of [
    valid.replace("127.0.0.1", "example.com"),
    valid + "?secret=x",
    valid.replace("ws:", "wss:"),
    "ws://127.0.0.1:1234/extension/x",
  ])
    assert.throws(() => validateEndpoint(address));
});

test("controller shares one selected tab, rejects other targets, and detaches on relay teardown", async () => {
  const relay = new ExtensionRelay();
  await relay.start();
  const events = [],
    commands = [],
    detached = [],
    storage = {};
  let onDetach;
  const api = {
    debugger: {
      onEvent: { addListener: (fn) => events.push(fn) },
      onDetach: {
        addListener: (fn) => {
          onDetach = fn;
        },
      },
      attach: async () => {},
      detach: async ({ tabId }) => {
        detached.push(tabId);
        onDetach({ tabId });
      },
      sendCommand: async (target, method) => {
        commands.push({ target, method });
        if (method === "Target.getTargetInfo")
          return { targetInfo: { targetId: "selected", type: "page", url: "https://example.com" } };
        return {};
      },
    },
    tabs: {
      get: async (id) => ({ id, windowId: 1, url: "https://example.com" }),
      remove: () => {
        throw new Error("Never close user tabs");
      },
    },
    storage: {
      session: { set: async (value) => Object.assign(storage, value), get: async () => storage },
    },
    action: { setBadgeText: async () => {} },
  };
  class ExtensionSocket extends ws {
    constructor(url) {
      super(url, { origin: "chrome-extension://" + "a".repeat(32) });
    }
  }
  const controller = new ExtensionController(api, ExtensionSocket, {
    authorize: async () => {},
    begin() {},
    end() {},
  });
  try {
    const ready = new Promise((resolve) => relay.once("ready", resolve));
    await controller.connect(relay.endpoint, 7);
    await ready;
    await assert.rejects(controller.connect(relay.endpoint, 8), /Disconnect/);
    await assert.rejects(
      relay.rpc("cdp", { targetId: "private", method: "Runtime.enable" }),
      /not shared/,
    );
    await assert.rejects(
      relay.rpc("cdp", { targetId: "selected", method: "Page.close" }),
      /exceeds/,
    );
    assert.deepEqual(
      commands.map((c) => c.method),
      ["Fetch.enable", "Target.setAutoAttach", "Page.getFrameTree", "Target.getTargetInfo"],
    );
    await relay.close();
    for (let i = 0; i < 50 && !detached.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(detached, [7]);
    assert.deepEqual(storage.atlasTabs, []);
  } finally {
    await controller.disconnect();
    await relay.close();
  }
});

test("disconnect during debugger attachment cannot leave new access behind", async () => {
  let completeAttach, entered;
  const detached = [];
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const controller = new ExtensionController(
    {
      debugger: {
        onEvent: { addListener: () => {} },
        onDetach: { addListener: () => {} },
        attach: () => {
          entered();
          return new Promise((resolve) => {
            completeAttach = resolve;
          });
        },
        detach: async ({ tabId }) => detached.push(tabId),
      },
      tabs: { get: async () => ({ url: "https://example.com" }) },
      storage: { session: { set: async () => {} } },
      action: { setBadgeText: async () => {} },
    },
    ws,
  );
  controller.permissions = { authorize: async () => {}, end() {} };
  const attaching = controller.attach(7, controller.generation);
  const rejected = assert.rejects(attaching, /cancelled/);
  await started;
  await controller.disconnect();
  completeAttach();
  await rejected;
  assert.deepEqual(detached, [7]);
  assert.equal(controller.targets.size, 0);
});

test("failed debugger release remains retryable and is reported explicitly", async () => {
  let fail = true;
  const stored = {};
  const controller = new ExtensionController(
    {
      debugger: {
        onEvent: { addListener: () => {} },
        onDetach: { addListener: () => {} },
        detach: async () => {
          if (fail) throw new Error("Permission denied");
        },
      },
      storage: { session: { set: async (value) => Object.assign(stored, value) } },
      action: { setBadgeText: async () => {} },
    },
    ws,
  );
  controller.targets.set(7, { targetId: "shared" });
  await assert.rejects(controller.disconnect(), /Could not release/);
  assert.deepEqual(stored.atlasTabs, [7]);
  fail = false;
  await controller.disconnect();
  assert.deepEqual(stored.atlasTabs, []);
});

test("shared pages and new task URLs require approval before attachment or creation", async () => {
  const calls = [];
  const api = {
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
      attach: async () => calls.push("attach"),
    },
    tabs: {
      get: async () => ({ url: "https://private.example" }),
      create: async () => calls.push("create"),
    },
  };
  const controller = new ExtensionController(api, ws, {
    authorize: async () => {
      throw new Error("not allowed");
    },
  });
  await assert.rejects(controller.attach(7, 0), /not allowed/);
  await assert.rejects(controller.createTab("https://private.example"), /not allowed/);
  assert.deepEqual(calls, []);
});

test("document interception holds redirects until approval and never forwards the paused request", async () => {
  const calls = [],
    messages = [];
  let approve;
  const controller = new ExtensionController(
    {
      debugger: {
        onEvent: { addListener() {} },
        onDetach: { addListener() {} },
        sendCommand: async (_, method) => calls.push(method),
      },
    },
    ws,
    {
      authorize: () =>
        new Promise((r) => {
          approve = r;
        }),
    },
  );
  controller.send = (message) => messages.push(message);
  const operation = controller.event(
    { tabId: 7 },
    "Fetch.requestPaused",
    { requestId: "r", request: { url: "https://redirect.example/private" } },
    { targetId: "t" },
    0,
  );
  assert.deepEqual(calls, []);
  approve();
  await operation;
  assert.deepEqual(calls, ["Fetch.continueRequest"]);
  assert.deepEqual(messages, []);
  controller.permissions.authorize = async () => {
    throw new Error("not allowed");
  };
  await assert.rejects(
    controller.event(
      { tabId: 7 },
      "Fetch.requestPaused",
      { requestId: "r2", request: { url: "https://blocked.example" } },
      { targetId: "t" },
      0,
    ),
    /not allowed/,
  );
  assert.deepEqual(calls, ["Fetch.continueRequest", "Fetch.failRequest"]);
});
