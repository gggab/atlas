import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  `export const HOST_NAME = "com.atlas.browser.fixture.unregistered";\nexport const APP_NAME = "DeskMate";\n`,
);
let blockedRequests = 0;
let uploaded;
const linkQuery = "?tracking=" + "x".repeat(200) + "&priceTId=tail-value&spm=a%2Bb";
const instructions = await readFile(
  new URL("../../src-tauri/resources/browser-use-instructions.md", import.meta.url),
  "utf8",
);
const linkWorkflow = [...instructions.matchAll(/```js\r?\n([\s\S]*?)```/g)]
  .map((match) => match[1])
  .find((code) => code.includes('getAttribute("href")'));
assert.ok(linkWorkflow);
const fixture = createServer((req, res) => {
  if (req.url === "/upload" && req.method === "POST") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      uploaded = Buffer.concat(chunks).toString();
      res.end("uploaded");
    });
    return;
  }
  if (req.url === "/files") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<title>Upload fixture</title><input type=\"file\" aria-label=\"Upload\" onchange=\"this.files[0].text().then(body => fetch('/upload', {method:'POST', body})).then(() => document.querySelector('output').textContent='uploaded')\"><output></output>",
    );
    return;
  }
  if (req.url === "/links") {
    res.setHeader("Content-Type", "text/html");
    const href = `http://127.0.0.1:${fixture.address().port}/ad${linkQuery}`;
    res.end(`<a href="${href.replaceAll("&", "&amp;")}">Observed product name</a>`);
    return;
  }
  if (req.url === "/ad" + linkQuery) {
    res.writeHead(302, { Location: "/detail" + linkQuery });
    res.end();
    return;
  }
  if (req.url === "/detail" + linkQuery) {
    res.setHeader("Content-Type", "text/html");
    res.end("<title>Observed product</title><p>Reviews fixture</p><p>Size chart fixture</p>");
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: `http://localhost:${fixture.address().port}/blocked` });
    res.end();
    return;
  }
  if (req.url === "/blocked") blockedRequests++;
  res.setHeader("Content-Type", "text/html");
  res.end(
    req.url === "/simple" || req.url === "/blocked"
      ? "<title>Website approval fixture</title><p>Fixture page</p>"
      : req.url === "/frame"
        ? '<label>Name<input aria-label="Name"></label>'
        : `<title>DeskMate extension fixture</title><label>Name<input aria-label="Name"></label><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Save</button><output></output><iframe src="http://localhost:${fixture.address().port}/frame"></iframe>`,
  );
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${fixture.address().port}`;
let context, runtime, host, workerFixture;
try {
  console.log(
    `[extension:smoke] Launching isolated headed ${process.argv[2] === "chrome" ? "Chrome" : "Edge"} with DeskMate extension`,
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
  let popup = await context.newPage();
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
  const approvalOpened = context.waitForEvent("page", { timeout: 10_000 });
  const connecting = popup
    .evaluate(
      async ({ endpoint, url }) => {
        const tabs = await chrome.tabs.query({});
        const selected = tabs.find((tab) => tab.url === url + "/");
        return chrome.runtime.sendMessage({ action: "connect", endpoint, tabId: selected.id });
      },
      { endpoint: host.relay.endpoint, url },
    )
    .catch((error) => ({ error: error.message }));
  const approval = await approvalOpened;
  await approval.waitForURL(`chrome-extension://${extensionId}/popup.html#website-access`);
  await approval
    .locator("#website-host")
    .filter({ hasText: "127.0.0.1" })
    .waitFor({ timeout: 10_000 });
  async function approve(hostname, choice = "allow_site") {
    await popup.locator("#website-host").filter({ hasText: hostname }).waitFor();
    await popup.locator(`[data-choice="${choice}"]`).click();
  }
  await popup.locator("#website-host").filter({ hasText: "127.0.0.1" }).waitFor();
  const screenshots = fileURLToPath(new URL("../../../output/playwright/", import.meta.url));
  await mkdir(screenshots, { recursive: true });
  for (const colorScheme of ["light", "dark"]) {
    await popup.emulateMedia({ colorScheme });
    await popup.locator("body").screenshot({
      path: path.join(
        screenshots,
        `website-approval-${process.argv[2] ?? "edge"}-${colorScheme}.png`,
      ),
    });
  }
  await approval.locator('[data-choice="allow_site"]').click();
  await approve("localhost");
  const reply = await connecting;
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
    'let tab = await browser.tabs.selected(); await tab.playwright.getByRole("textbox", {name:"Name",exact:true}).fill("DeskMate"); await tab.playwright.getByRole("button", {name:"Save",exact:true}).click();',
  );
  assert.equal(await shared.locator("output").innerText(), "DeskMate");
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
  console.log(
    "[extension:smoke] Full observed redirect link, task grouping and destination content",
  );
  await run(
    `let sourceTab = tab; tab = created; await tab.goto(${JSON.stringify(url + "/links")});`,
  );
  const groupedLinkTab = await popup.evaluate(async (url) => {
    const selected = (await chrome.tabs.query({})).find((tab) => tab.url === url + "/links");
    return selected.groupId;
  }, url);
  assert.notEqual(groupedLinkTab, -1);
  const followed = await run(linkWorkflow);
  assert.ok(followed.content.some((item) => item.text === url + "/detail" + linkQuery));
  assert.ok(
    followed.content.some(
      (item) => item.text?.includes("Reviews fixture") && item.text.includes("Size chart fixture"),
    ),
  );
  await run("tab = sourceTab;");
  await run(
    "let disposable = await browser.tabs.new(); await disposable.markTemporary(); let resultPage = await browser.tabs.new(); await resultPage.markDeliverable(); let keptPage = await browser.tabs.new(); await keptPage.markKeep();",
  );
  await run(
    `await created.goto(${JSON.stringify(url + "/simple#undecided")}); await resultPage.goto(${JSON.stringify(url + "/simple#result")}); await keptPage.goto(${JSON.stringify(url + "/simple#kept")});`,
  );
  allowed = false;
  assert.equal((await runtime.execute("await tab.reload();")).isError, true);
  allowed = true;
  console.log("[extension:smoke] Cleanup honors Agent keep/close decisions and releases control");
  const pageCount = context.pages().length;
  assert.equal((await host.cleanup()).keepAlive, false);
  assert.equal(context.pages().length, pageCount - 2);
  // The task's CDP handles close on disconnect; verify the independent browser context.
  assert.equal(
    context.pages().some((page) => page.url() === url + "/simple#undecided"),
    false,
  );
  for (const fragment of ["result", "kept"])
    assert.ok(context.pages().some((page) => page.url() === url + "/simple#" + fragment));
  const retainedGroups = await popup.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return ["result", "kept"].map(
      (fragment) => tabs.find((tab) => tab.url === url + "/simple#" + fragment).groupId,
    );
  }, url);
  assert.deepEqual(retainedGroups, [groupedLinkTab, groupedLinkTab]);
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
    const controlled = (await chrome.tabs.query({})).filter((tab) =>
      [url + "/", url + "/simple#result", url + "/simple#kept"].includes(tab.url),
    );
    for (const tab of controlled) {
      try {
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Target.getTargetInfo");
        return false;
      } catch (error) {
        if (!/not attached/i.test(error.message)) return false;
      }
    }
    return controlled.length === 3;
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
  const inventory = await workerFixture.run(
    "nodeRepl.write(JSON.stringify(await browser.tabs.list()));",
  );
  assert.equal(inventory.isError, false, JSON.stringify(inventory.content));
  const restored = JSON.parse(inventory.content[0].text);
  assert.equal(
    restored.length,
    3,
    "The same session discovers shared and retained pages without a blank tab",
  );
  assert.equal(restored.find((tab) => tab.url === url + "/simple#kept").disposition, "keep");
  assert.equal(
    restored.find((tab) => tab.url === url + "/simple#result").disposition,
    "deliverable",
  );
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
  assert.equal(
    (
      await workerFixture.run(
        `let later = await browser.tabs.new(); await later.goto(${JSON.stringify(url + "/simple#later-task")});`,
      )
    ).isError,
    false,
  );
  const laterGroup = await popup.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url + "/simple#later-task").groupId,
    url,
  );
  assert.equal(
    laterGroup,
    groupedLinkTab,
    "Later turns in the same session reuse the original group",
  );
  assert.equal((await workerFixture.run("", true)).keepAlive, false);
  await workerFixture.close();
  workerFixture = null;
  assert.equal(context.pages().length, pageCount - 2);
  assert.equal(
    context.pages().some((page) => page.url() === url + "/simple#later-task"),
    false,
  );
  for (const fragment of ["result", "kept"])
    assert.ok(context.pages().some((page) => page.url() === url + "/simple#" + fragment));
  assert.equal(shared.isClosed(), false);
  assert.equal(unrelated.isClosed(), false);
  console.log(
    "[extension:smoke] Resetting website permissions and denying a new redirect hostname",
  );
  const reset = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ action: "resetWebsiteAccess" }),
  );
  assert.equal(reset.error ?? undefined, undefined);
  await shared.goto(url + "/simple");
  host = new ExtensionHost({ check: async () => {} });
  await host.start();
  const retry = popup.evaluate(
    async ({ endpoint, url }) => {
      const selected = (await chrome.tabs.query({})).find((t) => t.url === url + "/simple");
      return chrome.runtime.sendMessage({ action: "connect", endpoint, tabId: selected.id });
    },
    { endpoint: host.relay.endpoint, url },
  );
  await approve("127.0.0.1", "allow_once");
  assert.equal((await retry).error, undefined);
  await host.connect();
  runtime = new BrowserRuntime({
    browserId: "extension",
    backend: (m, a) => host.call(m, a),
    resolvePage: (id) => host.resolvePage(id),
  });
  const navigation = runtime.execute(
    `let task = await browser.tabs.selected(); await task.goto(${JSON.stringify(url + "/redirect")});`,
  );
  await approve("localhost", "deny");
  assert.equal((await navigation).isError, true);
  assert.equal(blockedRequests, 0, "A declined redirect never reaches its HTTP endpoint");
  const deniedStatus = await popup.evaluate(() => chrome.runtime.sendMessage({ action: "status" }));
  assert.equal(deniedStatus.websiteAccess.sites.localhost, "block");
  assert.equal(shared.isClosed(), false);
  console.log(
    "[extension:smoke] PASS: real extension, existing-tab isolation, facade and preservation",
  );
  await runtime.close();
  await host.close();

  console.log("[extension:smoke] Native file-access switch, local pages and website upload");
  const settings = await context.newPage();
  await settings.goto(`${chromeTest ? "chrome" : "edge"}://extensions/?id=${extensionId}`);
  // Chrome permits debugger-installed unpacked extensions to reload only in Developer mode.
  if (chromeTest) {
    const developerMode = settings.locator("#devMode");
    if (!(await developerMode.evaluate((toggle) => toggle.checked))) await developerMode.click();
  }
  const fileSwitch = chromeTest
    ? settings.locator("#allow-on-file-urls cr-toggle")
    : settings.getByText(/^(Allow access to file URLs|允许访问文件 URL)$/);
  await fileSwitch.waitFor();
  async function setFileAccess(enabled) {
    const current = chromeTest
      ? await fileSwitch.evaluate((toggle) => toggle.checked)
      : await settings.evaluate(
          async (id) => (await chrome.developerPrivate.getExtensionInfo(id)).fileAccess.isActive,
          extensionId,
        );
    if (current !== enabled) {
      const restarted = context.waitForEvent("serviceworker", {
        predicate: (worker) => new URL(worker.url()).host === extensionId,
        timeout: 15_000,
      });
      if (chromeTest) await fileSwitch.click();
      // Edge's Fluent control is encapsulated; change the same native setting in this fixture profile.
      else
        await settings.evaluate(
          ({ id, enabled }) =>
            chrome.developerPrivate.updateExtensionConfiguration({
              extensionId: id,
              fileAccess: enabled,
            }),
          { id: extensionId, enabled },
        );
      await restarted;
      await fileSwitch.waitFor();
    }
    // Changing the browser switch reloads the extension and closes its old UI.
    if (!popup.isClosed()) await popup.close();
    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForFunction(
      (enabled) => chrome.extension.isAllowedFileSchemeAccess().then((value) => value === enabled),
      enabled,
    );
  }
  const localFile = path.join(directory, "Local page.html");
  const uploadFile = path.join(directory, "upload.txt");
  await writeFile(localFile, "<title>Local file fixture</title><p>Local page verified</p>");
  await writeFile(uploadFile, "file upload verified");
  const localUrl = pathToFileURL(localFile).href;
  const localPage = await context.newPage();
  await localPage.goto(localUrl);
  async function connectFileTask(pageUrl) {
    host = new ExtensionHost({
      check: async () => {
        if (!allowed) throw new Error("Browser paused");
      },
      artifactsDir: path.join(directory, "artifacts"),
    });
    await host.start();
    const status = await popup.evaluate(() => chrome.runtime.sendMessage({ action: "status" }));
    const connecting = popup.evaluate(
      async ({ endpoint, pageUrl }) => {
        const selected = (await chrome.tabs.query({})).find((tab) => tab.url === pageUrl);
        return chrome.runtime.sendMessage({ action: "connect", endpoint, tabId: selected.id });
      },
      { endpoint: host.relay.endpoint, pageUrl },
    );
    if (pageUrl.startsWith(url) && status.websiteAccess.sites["127.0.0.1"] !== "allow") {
      await approve("127.0.0.1", "allow_site");
    }
    const reply = await connecting;
    assert.equal(reply.error, undefined);
    await host.connect();
    runtime = new BrowserRuntime({
      browserId: "extension",
      backend: (m, a) => host.call(m, a),
      resolvePage: (id) => host.resolvePage(id),
    });
    await run("let tab = await browser.tabs.selected();");
  }
  await setFileAccess(false);
  const shareDenied = await popup.evaluate(async (localUrl) => {
    const selected = (await chrome.tabs.query({})).find((tab) => tab.url === localUrl);
    return chrome.runtime.sendMessage({ action: "shareNextTab", tabId: selected.id });
  }, localUrl);
  assert.match(shareDenied.error, /Allow access to file URLs/);
  await shared.goto(url + "/files");
  await connectFileTask(url + "/files");
  const denied = await runtime.execute(`await tab.goto(${JSON.stringify(localUrl)});`);
  assert.equal(denied.isError, true);
  assert.match(denied.content.at(-1).text, /Allow access to file URLs/);
  assert.equal(shared.url(), url + "/files");
  const uploadCode = `let chooser = tab.playwright.waitForEvent("filechooser"); await tab.playwright.getByLabel("Upload").click(); await (await chooser).setFiles(${JSON.stringify(uploadFile)});`;
  const uploadDenied = await runtime.execute(uploadCode);
  assert.equal(uploadDenied.isError, true);
  assert.match(uploadDenied.content.at(-1).text, /Allow access to file URLs/);
  assert.equal(uploaded, undefined);
  await runtime.close();
  await host.close();
  await setFileAccess(true);
  await connectFileTask(localUrl);
  assert.ok(
    (await run("nodeRepl.write(await tab.playwright.domSnapshot());")).content[0].text.includes(
      "Local page verified",
    ),
  );
  await run(
    `let createdFile = await cua.createBrowserTab("extension", ${JSON.stringify(localUrl)}, {visible:true});`,
  );
  await run(`await tab.goto(${JSON.stringify(url + "/files")});`);
  await run(uploadCode);
  await localPage.locator("output").filter({ hasText: "uploaded" }).waitFor();
  assert.equal(uploaded, "file upload verified");
  allowed = false;
  assert.equal((await runtime.execute("await tab.reload();")).isError, true);
  allowed = true;
  await setFileAccess(false);
  await runtime.close();
  await host.close();
  await connectFileTask(url + "/files");
  const revoked = await runtime.execute(uploadCode);
  assert.equal(revoked.isError, true);
  assert.match(revoked.content.at(-1).text, /Allow access to file URLs/);
  console.log(
    "[extension:smoke] PASS: file switch, disabled/enabled/revoked access, file pages, upload and pause",
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
