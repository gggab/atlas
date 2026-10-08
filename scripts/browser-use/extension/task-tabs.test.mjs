import assert from "node:assert/strict";
import { test } from "node:test";
import { ExtensionController } from "./controller.js";
import { ws } from "../extension-relay.mjs";

function fixture() {
  const pages = new Map([[7, { id: 7, windowId: 1, url: "https://example.com", groupId: -1 }]]);
  const stored = {},
    removed = [],
    groups = new Map();
  let next = 8;
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
      group: async ({ tabIds, groupId = 3 }) => {
        for (const id of [tabIds].flat()) pages.get(id).groupId = groupId;
        groups.set(groupId, {});
        return groupId;
      },
      query: async ({ groupId }) => [...pages.values()].filter((p) => p.groupId === groupId),
      ungroup: async (ids) => {
        for (const id of ids) pages.get(id).groupId = -1;
        groups.delete(3);
      },
      remove: async (id) => {
        removed.push(id);
        pages.delete(id);
        if (![...pages.values()].some((p) => p.groupId === 3)) groups.delete(3);
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
  const controller = new ExtensionController(api, ws);
  controller.windowId = 1;
  return { controller, pages, removed, groups, stored };
}

test("task cleanup closes only owned tabs, ignores deliverables and removes the group", async () => {
  const { controller, pages, removed, groups } = fixture();
  await controller.attach(7, controller.generation);
  const created = await controller.createTab("about:blank");
  await controller.mark(created.targetId, "deliverable");
  // An ordinary tab moved into the visual group does not become owned.
  pages.get(7).groupId = 3;
  await controller.disconnect();
  assert.deepEqual(removed, [8]);
  assert.ok(pages.has(7));
  assert.equal(groups.size, 0);
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

test("only explicit handoff survives completion and manual takeover retains task pages", async () => {
  const { controller, pages, groups } = fixture();
  const first = await controller.createTab("about:blank");
  await controller.mark(first.targetId, "handoff");
  await controller.createTab("https://example.com/task");
  await controller.disconnect();
  assert.ok(pages.has(8));
  assert.equal(pages.has(9), false);
  assert.match(groups.get(3).title, /Waiting/);
  const again = await controller.createTab("about:blank");
  await controller.createTab("about:blank");
  await controller.disconnect({ takeover: true, tabId: 10 });
  assert.ok(pages.has(10));
  assert.equal(pages.has(11), false);
  assert.ok(again.targetId);
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
  await controller.allowResume();
  assert.equal(stored.atlasHandoff.ready, true);
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
  await controller.createTab("about:blank");
  await controller.disconnect();
  assert.equal(groups.size, 0);
  await controller.createTab("about:blank");
  controller.api.tabs.remove = async () => {
    throw new Error("Permission denied");
  };
  await assert.rejects(controller.disconnect(), /Permission denied/);
});
