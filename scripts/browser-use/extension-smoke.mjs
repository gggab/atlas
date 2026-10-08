import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionHost } from "./extension-host.mjs";
import { BrowserRuntime } from "./runtime.mjs";
import { ExtensionWorkerFixture } from "./extension-worker-fixture.mjs";

// Test-only browser/profile. Never inspect or attach a user's daily browser.
const directory = await mkdtemp(path.join(tmpdir(), "atlas-extension-smoke-"));
const extension = path.join(directory, "extension");
await cp(fileURLToPath(new URL("./extension/", import.meta.url)), extension, { recursive: true });
// This CDP fixture must never auto-connect to the user's real Atlas host.
await writeFile(
  path.join(extension, "config.js"),
  `export const HOST_NAME = "com.atlas.browser.fixture.unregistered";\nexport const APP_NAME = "Atlas";\n`,
);
const fixture = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    req.url === "/frame"
      ? '<label>Name<input aria-label="Name"></label>'
      : `<title>Atlas extension fixture</title><label>Name<input aria-label="Name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Save</button><output></output><iframe src="http://localhost:${fixture.address().port}/frame"></iframe>`,
  );
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${fixture.address().port}`;
let context, runtime, host, workerFixture;
try {
  console.log(
    `[extension:smoke] Launching isolated headed ${process.argv[2] === "chrome" ? "Chrome" : "Edge"} with Atlas extension`,
  );
  const chromeTest = process.argv[2] === "chrome";
  context = await chromium.launchPersistentContext(path.join(directory, "profile"), {
    channel: chromeTest ? "chrome" : "msedge",
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: chromeTest
      ? ["--enable-unsafe-extension-debugging"]
      : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  if (chromeTest) {
    // Branded Chrome no longer loads extensions from --load-extension.
    // This opt-in test flag/API operates only on our generated test profile.
    const client = await context.browser().newBrowserCDPSession();
    await client.send("Extensions.loadUnpacked", { path: extension });
    await client.detach();
  }
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  const extensionId = new URL(worker.url()).host;
  const shared = await context.newPage();
  await shared.goto(url);
  const unrelated = await context.newPage();
  await unrelated.goto(url + "/private");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  let allowed = true;
  host = new ExtensionHost({
    check: async () => {
      if (!allowed) throw new Error("Browser paused");
    },
    artifactsDir: path.join(directory, "artifacts"),
  });
  await host.start();
  console.log("[extension:smoke] Sharing an existing fixture tab through the real extension popup");
  const reply = await popup.evaluate(
    async ({ endpoint, url }) => {
      const tabs = await chrome.tabs.query({});
      const selected = tabs.find((tab) => tab.url === url + "/");
      return chrome.runtime.sendMessage({ action: "connect", endpoint, tabId: selected.id });
    },
    { endpoint: host.relay.endpoint, url },
  );
  assert.equal(reply.error, undefined);
  await host.connect();
  assert.equal((await host.list()).length, 1);
  assert.equal((await host.list())[0].url, url + "/");
  runtime = new BrowserRuntime({
    browserId: "extension",
    backend: (m, a) => host.call(m, a),
    resolvePage: (id) => host.resolvePage(id),
  });
  const run = async (code) => {
    const result = await runtime.execute(code);
    assert.equal(result.isError, false, JSON.stringify(result.content));
    return result;
  };
  await run(
    'let tab = await browser.tabs.selected(); await tab.playwright.getByRole("textbox", {name:"Name",exact:true}).fill("Atlas"); await tab.playwright.getByRole("button", {name:"Save",exact:true}).click();',
  );
  assert.equal(await shared.locator("output").innerText(), "Atlas");
  console.log("[extension:smoke] Input, frame reads, AX refs and screenshots");
  await run(
    'nodeRepl.write(await tab.playwright.frameLocator("iframe").getByRole("textbox", {name:"Name",exact:true}).count());',
  );
  await run("nodeRepl.write(await tab.getAXState());");
  assert.equal(
    (await run("await nodeRepl.emitImage(await tab.screenshot());")).content[0].type,
    "image",
  );
  const created = await run(
    "let created = await browser.tabs.new(); nodeRepl.write(await created.url());",
  );
  assert.equal(created.content.at(-1).text, "about:blank");
  assert.equal((await host.list()).length, 2);
  allowed = false;
  assert.equal((await runtime.execute("await tab.reload();")).isError, true);
  allowed = true;
  console.log(
    "[extension:smoke] Task cleanup closes owned tabs and preserves existing browser pages",
  );
  const pageCount = context.pages().length;
  assert.equal((await host.cleanup()).keepAlive, false);
  assert.equal(context.pages().length, pageCount - 1);
  const groupCount = await popup.evaluate(async () => (await chrome.tabGroups.query({})).length);
  assert.equal(groupCount, 0);
  assert.equal(shared.isClosed(), false);
  assert.equal(unrelated.isClosed(), false);
  for (let i = 0; i < 50; i++) {
    const status = await popup.evaluate(() => chrome.runtime.sendMessage({ action: "status" }));
    if (!status.connected) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const status = await popup.evaluate(() => chrome.runtime.sendMessage({ action: "status" }));
  assert.equal(status.connected, false);
  // getTargets().attached also includes this test's Playwright connection.
  // Check ownership specifically: this extension can no longer send commands.
  const released = await popup.evaluate(async (url) => {
    const selected = (await chrome.tabs.query({})).find((t) => t.url === url + "/");
    try {
      await chrome.debugger.sendCommand({ tabId: selected.id }, "Target.getTargetInfo");
      return false;
    } catch (error) {
      return /not attached/i.test(error.message);
    }
  }, url);
  assert.equal(released, true);
  console.log(
    "[extension:smoke] Bundled Node worker, authorization, deferred-call rejection and shutdown",
  );
  workerFixture = new ExtensionWorkerFixture();
  await workerFixture.run("");
  assert.ok(workerFixture.endpoint);
  const reconnected = await popup.evaluate(
    async ({ endpoint, url }) => {
      const selected = (await chrome.tabs.query({})).find((t) => t.url === url + "/");
      return chrome.runtime.sendMessage({ action: "connect", endpoint, tabId: selected.id });
    },
    { endpoint: workerFixture.endpoint, url },
  );
  assert.equal(reconnected.error, undefined);
  assert.equal(
    (
      await workerFixture.run(
        "let shared = await browser.tabs.selected(); let value = 40; nodeRepl.write(++value);",
      )
    ).isError,
    false,
  );
  assert.equal((await workerFixture.run("nodeRepl.write(++value);")).content[0].text, "42");
  assert.equal(
    (await workerFixture.run("await nodeRepl.emitImage(await shared.screenshot());")).content[0]
      .type,
    "image",
  );
  workerFixture.allowed = false;
  assert.equal((await workerFixture.run("await shared.reload();")).isError, true);
  workerFixture.allowed = true;
  await workerFixture.run(
    'let deferred = (async () => { await new Promise(r => setTimeout(r, 100)); try { await shared.reload(); return "incorrectly allowed"; } catch(e) { return e.message; } })(); undefined;',
  );
  assert.match(
    (await workerFixture.run("nodeRepl.write(await deferred);")).content[0].text,
    /completed call/,
  );
  assert.equal((await workerFixture.run("", true)).keepAlive, false);
  await workerFixture.close();
  workerFixture = null;
  assert.equal(context.pages().length, pageCount - 1);
  assert.equal(shared.isClosed(), false);
  assert.equal(unrelated.isClosed(), false);
  console.log(
    "[extension:smoke] PASS: real extension, existing-tab isolation, facade and preservation",
  );
} finally {
  await workerFixture?.close();
  await runtime?.close();
  await host?.close();
  await context?.close();
  await new Promise((resolve) => fixture.close(resolve));
  // Only our verified generated temp root is eligible for cleanup.
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith("atlas-extension-smoke-"));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
