import assert from "node:assert/strict";
import { test } from "node:test";
import { ExtensionController } from "./controller.js";
import { ExtensionRelay, ws } from "../extension-relay.mjs";

async function connect(controller, sessionId) {
  const relay = new ExtensionRelay();
  await relay.start();
  const ready = new Promise((resolve) => relay.once("ready", resolve));
  try {
    await controller.connect(relay.endpoint, undefined, "Task", sessionId);
    await ready;
    return relay;
  } catch (error) {
    await relay.close();
    throw error;
  }
}

test("the same session discovers retained pages and reuses its group across turns", async () => {
  const { controller, pages, stored, groups } = fixture();
  const first = await connect(controller, "owner");
  let second;
  try {
    await controller.mark("t8", "keep");
    const result = await controller.createTab("https://example.com/result");
    await controller.mark(result.targetId, "deliverable");
    const groupId = pages.get(8).groupId;
    // Group membership alone does not authorize a personal page.
    pages.get(7).groupId = groupId;
    await controller.disconnect();
    await controller.recover();
    second = await connect(controller, "owner");
    assert.deepEqual([...controller.targets.keys()], [8, 9]);
    assert.equal(pages.size, 3, "Reconnect must not create a duplicate blank tab");
    assert.equal(controller.records.get(8).disposition, "keep");
    assert.equal(controller.records.get(9).disposition, "deliverable");
    await controller.createTab("about:blank");
    assert.equal(pages.get(10).groupId, groupId);
    assert.equal(groups.size, 1);
    await controller.disconnect();
    assert.equal(pages.has(10), false, "New unmarked pages still close");
    assert.deepEqual(
      stored.atlasSessions[0].tabs.map((record) => record.tabId),
      [8, 9],
    );
    assert.ok(pages.has(7));
  } finally {
    await controller.disconnect();
    await second?.close();
    await first.close();
  }
});

test("another session gets a separate group and cannot discover retained pages", async () => {
  const { controller, pages } = fixture();
  const first = await connect(controller, "owner");
  let second;
  try {
    await controller.mark("t8", "keep");
    const originalGroup = pages.get(8).groupId;
    await controller.disconnect();
    second = await connect(controller, "other");
    assert.deepEqual([...controller.targets.keys()], [9]);
    assert.notEqual(pages.get(9).groupId, originalGroup);
    await controller.disconnect();
    assert.equal(pages.has(9), false);
    assert.equal(pages.get(8).groupId, originalGroup);
  } finally {
    await controller.disconnect();
    await second?.close();
    await first.close();
  }
});

test("retained records survive extension recovery but reused tab IDs are never attached", async () => {
  const { controller, pages } = fixture();
  const first = await connect(controller, "owner");
  let second;
  try {
    await controller.mark("t8", "keep");
    await controller.disconnect();
    await controller.recover();
    controller.api.debugger.getTargets = async () =>
      [...pages.values()].map((tab) => ({
        tabId: tab.id,
        id: tab.id === 8 ? "reused" : `t${tab.id}`,
      }));
    second = await connect(controller, "owner");
    assert.deepEqual([...controller.targets.keys()], [9]);
    assert.notEqual(pages.get(9).groupId, pages.get(8).groupId);
    assert.ok(pages.has(8));
  } finally {
    await controller.disconnect();
    await second?.close();
    await first.close();
  }
});

test("concurrent tab creation still uses a single session group", async () => {
  const { controller, groups, pages } = fixture();
  await Promise.all([controller.createTab("about:blank"), controller.createTab("about:blank")]);
  assert.equal(groups.size, 1);
  assert.equal(pages.get(8).groupId, pages.get(9).groupId);
  await controller.disconnect();
});

test("handoff continuation restores ordinary retained pages without creating another group", async () => {
  const { controller, pages } = fixture();
  const first = await connect(controller, "owner");
  let second;
  try {
    await controller.mark("t8", "keep");
    const handoff = await controller.createTab("about:blank");
    await controller.mark(handoff.targetId, "handoff");
    const groupId = pages.get(8).groupId;
    await controller.disconnect();
    assert.equal(await controller.allowResume("owner"), true);
    second = await connect(controller, "owner");
    assert.deepEqual([...controller.targets.keys()], [9, 8]);
    assert.equal(pages.get(9).groupId, groupId);
    assert.equal(pages.get(8).groupId, groupId);
    await controller.disconnect();
    assert.equal(pages.has(9), false, "Resumed handoff pages return to the closing default");
    assert.ok(pages.has(8), "Ordinary keep decisions survive continuation");
  } finally {
    await controller.disconnect();
    await second?.close();
    await first.close();
  }
});

test("reconnecting a retained page rechecks current website authorization", async () => {
  const { controller, pages, stored } = fixture();
  const first = await connect(controller, "owner");
  try {
    pages.get(8).url = "https://example.com/retained";
    await controller.mark("t8", "keep");
    await controller.disconnect();
    controller.permissions.authorize = async (url) => {
      if (url.startsWith("https://example.com")) throw new Error("Access is not allowed");
    };
    await assert.rejects(connect(controller, "owner"), /Access is not allowed/);
    assert.equal(controller.targets.size, 0);
    assert.ok(pages.has(8));
    assert.equal(stored.atlasSessions[0].tabs[0].tabId, 8);
  } finally {
    await controller.disconnect();
    await first.close();
  }
});

test("releasing a handoff leaves ordinary retained pages in their reusable session group", async () => {
  const { controller, pages, groups } = fixture();
  const first = await connect(controller, "owner");
  let second;
  try {
    await controller.mark("t8", "keep");
    const handoff = await controller.createTab("about:blank");
    await controller.mark(handoff.targetId, "handoff");
    const groupId = pages.get(8).groupId;
    await controller.disconnect();
    await controller.discardHandoff();
    assert.equal(pages.has(9), false);
    assert.equal(pages.get(8).groupId, groupId);
    assert.doesNotMatch(groups.get(groupId).title, /Waiting/);
    second = await connect(controller, "owner");
    assert.deepEqual([...controller.targets.keys()], [8]);
    assert.equal(pages.size, 2);
  } finally {
    await controller.disconnect();
    await second?.close();
    await first.close();
  }
});

function fixture() {
  const pages = new Map([[7, { id: 7, windowId: 1, url: "https://example.com", groupId: -1 }]]);
  const stored = {},
    removed = [],
    groups = new Map();
  let next = 8;
  let nextGroup = 3;
  const api = {
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
      attach: async () => {},
      detach: async () => {},
      getTargets: async () =>
        [...pages.values()].map((tab) => ({ tabId: tab.id, id: `t${tab.id}` })),
      sendCommand: async ({ tabId }) => ({
        targetInfo: { targetId: `t${tabId}`, type: "page", url: pages.get(tabId).url },
      }),
    },
    tabs: {
      get: async (id) => {
        if (!pages.has(id)) throw new Error("No tab with given id");
        return pages.get(id);
      },
      create: async ({ url }) => {
        const tab = { id: next++, windowId: 1, url, groupId: -1 };
        pages.set(tab.id, tab);
        return tab;
      },
      group: async ({ tabIds, groupId = nextGroup++ }) => {
        for (const id of [tabIds].flat()) pages.get(id).groupId = groupId;
        groups.set(groupId, {});
        return groupId;
      },
      query: async ({ groupId }) => [...pages.values()].filter((p) => p.groupId === groupId),
      ungroup: async (ids) => {
        const affected = new Set(ids.map((id) => pages.get(id).groupId));
        for (const id of ids) pages.get(id).groupId = -1;
        for (const groupId of affected)
          if (![...pages.values()].some((page) => page.groupId === groupId)) groups.delete(groupId);
      },
      remove: async (id) => {
        const groupId = pages.get(id)?.groupId;
        removed.push(id);
        pages.delete(id);
        if (![...pages.values()].some((p) => p.groupId === groupId)) groups.delete(groupId);
      },
    },
    tabGroups: {
      update: async (id, value) => {
        groups.set(id, value);
      },
    },
    storage: {
      session: { set: async (value) => Object.assign(stored, value), get: async () => stored },
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
  controller.windowId = 1;
  return { controller, pages, removed, groups, stored };
}

test("unmarked owned tabs close, explicit keep/result tabs stay in their original group, and user tabs survive", async () => {
  const { controller, pages, removed, groups, stored } = fixture();
  await controller.attach(7, controller.generation);
  await controller.mark("t7", "temporary");
  const temporary = await controller.createTab("about:blank");
  await controller.mark(temporary.targetId, "temporary");
  const result = await controller.createTab("about:blank");
  await controller.mark(result.targetId, "deliverable");
  const kept = await controller.createTab("about:blank");
  await controller.mark(kept.targetId, "temporary");
  await controller.mark(kept.targetId, "keep");
  await controller.createTab("about:blank");
  // An ordinary tab moved into the visual group does not become owned.
  pages.get(7).groupId = 3;
  await controller.disconnect();
  assert.deepEqual(removed, [8, 11]);
  assert.deepEqual([...pages.keys()], [7, 9, 10]);
  assert.equal(groups.size, 1);
  assert.equal(pages.get(9).groupId, 3);
  assert.equal(pages.get(10).groupId, 3);
  assert.equal(controller.targets.size, 0);
  assert.equal(controller.records.size, 0);
  assert.deepEqual(stored.atlasHandoff.tabs, []);
});

test("new task tabs accept their pending URL but unshared pending tabs stay private", async () => {
  const { controller, pages } = fixture();
  const create = controller.api.tabs.create;
  controller.api.tabs.create = async (options) => {
    const tab = await create(options);
    tab.pendingUrl = options.url;
    tab.url = "";
    return tab;
  };
  assert.ok((await controller.createTab("about:blank")).targetId);
  assert.ok((await controller.createTab("https://example.com/task")).targetId);
  pages.get(7).pendingUrl = "https://example.com/private";
  pages.get(7).url = "";
  await assert.rejects(controller.attach(7, controller.generation), /HTTP\(S\)/);
  await controller.disconnect();
});

test("handoff keeps its resume state separately from Agent-retained pages", async () => {
  const { controller, pages, groups } = fixture();
  const first = await controller.createTab("about:blank");
  await controller.mark(first.targetId, "handoff");
  const temporary = await controller.createTab("https://example.com/task");
  await controller.mark(temporary.targetId, "temporary");
  await controller.disconnect();
  assert.ok(pages.has(8));
  assert.equal(pages.has(9), false);
  assert.match(groups.get(3).title, /Waiting/);
  const again = await controller.createTab("about:blank");
  const anotherTemporary = await controller.createTab("about:blank");
  await controller.mark(anotherTemporary.targetId, "temporary");
  await controller.disconnect({ takeover: true, tabId: 10 });
  assert.ok(pages.has(10));
  assert.equal(pages.has(11), false);
  assert.ok(again.targetId);
});

test("startup recovery honors saved keep and close decisions without retaining control", async () => {
  const { controller, pages, stored, removed } = fixture();
  const kept = await controller.createTab("about:blank");
  await controller.mark(kept.targetId, "deliverable");
  const temporary = await controller.createTab("about:blank");
  await controller.mark(temporary.targetId, "temporary");
  controller.records.clear();
  await controller.recover();
  assert.deepEqual(removed, [9]);
  assert.ok(pages.has(8));
  assert.deepEqual(stored.atlasTask.tabs, []);
});

test("kept pages and handoffs remain in the original group but only handoffs can resume", async () => {
  const { controller, pages, stored, groups } = fixture();
  const handoff = await controller.createTab("about:blank");
  await controller.mark(handoff.targetId, "handoff");
  const kept = await controller.createTab("about:blank");
  await controller.mark(kept.targetId, "keep");
  await controller.disconnect();
  assert.deepEqual(
    stored.atlasHandoff.tabs.map((tab) => tab.tabId),
    [8],
  );
  assert.equal(pages.get(8).groupId, 3);
  assert.equal(pages.get(9).groupId, 3);
  assert.match(groups.get(3).title, /Waiting/);
});

test("a retained handoff cannot be automatically inherited by another Agent session", async () => {
  const { controller, stored } = fixture();
  stored.atlasHandoff = { sessionId: "owner", tabs: [{ tabId: 7, targetId: "t7", owned: true }] };
  await assert.rejects(
    controller.connect(
      "ws://127.0.0.1:1234/extension/" + "a".repeat(64),
      undefined,
      "Task",
      "other",
    ),
    /Another session/,
  );
});

test("an Agent cannot automatically retake control while the user is completing verification", async () => {
  const { controller, stored } = fixture();
  stored.atlasHandoff = { sessionId: "owner", tabs: [{ tabId: 7, targetId: "t7", owned: true }] };
  await assert.rejects(
    controller.connect(
      "ws://127.0.0.1:1234/extension/" + "a".repeat(64),
      undefined,
      "Task",
      "owner",
    ),
    /Waiting for user/,
  );
  assert.equal(await controller.allowResume("other"), false);
  assert.equal(stored.atlasHandoff.ready, undefined);
  assert.equal(await controller.allowResume("owner"), true);
  assert.equal(stored.atlasHandoff.ready, true);
  assert.equal(await controller.allowResume("owner", false), true);
  assert.equal(
    stored.atlasHandoff.ready,
    false,
    "Later questions or pause instructions revoke unused continuation",
  );
});

test("a chat continuation waits for takeover cleanup and cannot authorize a later handoff", async () => {
  const { controller, stored } = fixture();
  let finish;
  controller.disconnecting = new Promise((r) => {
    finish = r;
  });
  const intent = controller.allowResume("owner");
  stored.atlasHandoff = { sessionId: "owner", tabs: [{ tabId: 7, targetId: "t7" }], ready: false };
  finish();
  assert.equal(await intent, true);
  assert.equal(stored.atlasHandoff.ready, true);
  controller.disconnecting = null;
  stored.atlasHandoff = null;
  assert.equal(await controller.allowResume("owner"), false);
  stored.atlasHandoff = { sessionId: "owner", tabs: [{ tabId: 7, targetId: "t7" }], ready: false };
  assert.equal(stored.atlasHandoff.ready, false);
});

test("startup recovery never closes recorded tab IDs without the same debugger target", async () => {
  const { controller, pages, stored, removed } = fixture();
  stored.atlasTask = { tabs: [{ tabId: 7, targetId: "old-target", owned: true }], groupId: 3 };
  await controller.recover();
  assert.deepEqual(removed, []);
  assert.ok(pages.has(7));
});

test("handoff preserves and resumes user-owned page identity without granting deletion ownership", async () => {
  const { controller, stored, pages, removed } = fixture();
  await controller.attach(7, controller.generation);
  await controller.mark("t7", "handoff");
  await controller.disconnect();
  assert.equal(stored.atlasHandoff.tabs[0].tabId, 7);
  await controller.discardHandoff();
  assert.deepEqual(removed, []);
  assert.ok(pages.has(7));
});

test("cleanup removes an empty task group and reports a failed owned-tab close", async () => {
  const { controller, pages, groups } = fixture();
  pages.delete(7);
  const temporary = await controller.createTab("about:blank");
  await controller.mark(temporary.targetId, "temporary");
  await controller.disconnect();
  assert.equal(groups.size, 0);
  const failed = await controller.createTab("about:blank");
  await controller.mark(failed.targetId, "temporary");
  controller.api.tabs.remove = async () => {
    throw new Error("Permission denied");
  };
  await assert.rejects(controller.disconnect(), /Permission denied/);
});
