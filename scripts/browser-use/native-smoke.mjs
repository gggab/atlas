import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { ExtensionHost } from "./extension-host.mjs";
import { BrowserRuntime } from "./runtime.mjs";

// Windows integration fixture: only this registry host and generated profile.
// The real desktop executable handles native frames before GUI initialization.
assert.equal(process.platform, "win32", "Run this native-host fixture on Windows");
const root = fileURLToPath(new URL("../../", import.meta.url));
const binary = process.env.ATLAS_BROWSER_TEST_BINARY ?? path.join(root, "target/debug/atlas.exe");
await readFile(binary);
const folder = await mkdtemp(path.join(tmpdir(), "atlas-extension-native-smoke-"));
const secret = randomBytes(32).toString("hex");
const pending = new Map();
const sockets = new Set();
let sequence = 0,
  peer,
  context,
  host,
  runtime;
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  const lines = createInterface({ input: socket });
  let admitted = false;
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (!admitted) {
      assert.equal(message.secret, secret);
      assert.match(message.clientId, /^[a-f0-9-]{36}$/);
      assert.equal(message.version, "0.3.1");
      admitted = true;
      peer = socket;
      socket.write('{"type":"bridgeReady"}\n');
    } else if (message.id) pending.get(message.id)?.(message);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const descriptor = path.join(folder, "connection.json");
await writeFile(
  descriptor,
  JSON.stringify({ address: `127.0.0.1:${server.address().port}`, secret }),
);
const manifest = path.join(folder, "host.json");
const extension = path.join(folder, "extension");
const extensionId = "falkhmhmbghdjcabgojjooddbhjpmmfd";
const name = `com.atlas.browser.fixture.${randomBytes(8).toString("hex")}`;
const browser = process.argv[2] === "chrome" ? "chrome" : "edge";
const vendor = browser === "chrome" ? "Google\\Chrome" : "Microsoft\\Edge";
const key = `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${name}`;
let registered = false;
const reg = (args) => execFileSync("reg.exe", args, { windowsHide: true, stdio: "pipe" });
try {
  await cp(path.join(root, "scripts/browser-use/extension"), extension, { recursive: true });
  await writeFile(
    path.join(extension, "config.js"),
    `export const HOST_NAME = ${JSON.stringify(name)};\nexport const APP_NAME = "Atlas";\n`,
  );
  let exists = false;
  try {
    reg(["QUERY", key]);
    exists = true;
  } catch {}
  assert.equal(exists, false, "Never overwrite an existing native fixture registration");
  await writeFile(
    manifest,
    JSON.stringify({
      name,
      description: "Atlas native fixture",
      path: binary,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    }),
  );
  reg(["ADD", key, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"]);
  registered = true;
  console.log(`[native:smoke] Real ${browser}, native desktop host and isolated task profile`);
  context = await chromium.launchPersistentContext(path.join(folder, "profile"), {
    channel: browser === "chrome" ? "chrome" : "msedge",
    headless: false,
    env: { ...process.env, ATLAS_BROWSER_NATIVE_FIXTURE: descriptor },
    ignoreDefaultArgs: ["--disable-extensions"],
    args:
      browser === "chrome"
        ? ["--enable-unsafe-extension-debugging"]
        : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  if (browser === "chrome") {
    const cdp = await context.browser().newBrowserCDPSession();
    await cdp.send("Extensions.loadUnpacked", { path: extension });
    await cdp.detach();
  }
  const background = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  assert.equal(new URL(background.url()).host, extensionId);
  const personal = await context.newPage();
  await personal.goto("about:blank");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  // Fresh installation connects using its packaged host; no popup action is needed.
  await popup.getByRole("heading", { name: "Atlas connected" }).waitFor({ timeout: 10_000 });
  const authorized = await popup.evaluate(() => chrome.runtime.sendMessage({ action: "status" }));
  assert.equal(authorized.error ?? undefined, undefined, JSON.stringify(authorized));
  assert.equal(authorized.appConnected, true, JSON.stringify(authorized));
  const screenshots = path.join(root, "artifacts/browser-extension");
  await mkdir(screenshots, { recursive: true });
  await popup.getByRole("heading", { name: "Atlas connected" }).waitFor();
  await popup.emulateMedia({ colorScheme: "light" });
  await popup
    .locator("body")
    .screenshot({ path: path.join(screenshots, `popup-${browser}-light.png`) });
  await popup.emulateMedia({ colorScheme: "dark" });
  await popup
    .locator("body")
    .screenshot({ path: path.join(screenshots, `popup-${browser}-dark.png`) });
  await popup.emulateMedia({ colorScheme: "light" });
  const baseline = context.pages().length;
  async function start(title) {
    host = new ExtensionHost({ check: async () => {} });
    await host.start();
    const id = String(++sequence);
    const result = new Promise((resolve) => pending.set(id, resolve));
    peer.write(
      JSON.stringify({
        id,
        type: "start",
        endpoint: host.relay.endpoint,
        title,
        sessionId: "fixture-session",
      }) + "\n",
    );
    const timer = setTimeout(() => pending.get(id)?.({ error: "Native fixture timeout" }), 20_000);
    let reply;
    try {
      reply = await result;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    await host.connect();
    runtime = new BrowserRuntime({
      browserId: "extension",
      backend: (m, a) => host.call(m, a),
      resolvePage: (id) => host.resolvePage(id),
    });
    return (await host.list())[0];
  }
  await start("Fixture task");
  assert.equal((await host.list()).length, 1);
  assert.equal(context.pages().length, baseline + 1);
  const groups = await popup.evaluate(() => chrome.tabGroups.query({}));
  assert.equal(groups.length, 1);
  assert.match(groups[0].title, /Fixture task/);
  await host.cleanup();
  await runtime.close();
  runtime = null;
  assert.equal(context.pages().length, baseline);
  assert.equal((await popup.evaluate(() => chrome.tabGroups.query({}))).length, 0);
  assert.equal(
    (await popup.evaluate(() => chrome.runtime.sendMessage({ action: "status" }))).appConnected,
    true,
  );
  await start("Second task");
  const result = await runtime.execute(
    "let tab = await browser.tabs.selected(); await tab.markHandoff();",
  );
  assert.equal(result.isError, false, JSON.stringify(result));
  await host.cleanup();
  await runtime.close();
  runtime = null;
  assert.equal(context.pages().length, baseline + 1);
  assert.match((await popup.evaluate(() => chrome.tabGroups.query({})))[0].title, /Waiting/);
  await popup.getByRole("heading", { name: "Waiting for you" }).waitFor();
  await popup
    .locator("body")
    .screenshot({ path: path.join(screenshots, `popup-${browser}-handoff.png`) });
  const resumed = await popup.evaluate(() => chrome.runtime.sendMessage({ action: "allowResume" }));
  assert.equal(resumed.error ?? undefined, undefined);
  await start("Resume task");
  assert.equal(
    context.pages().length,
    baseline + 1,
    "Resume the retained page instead of duplicating it",
  );
  await host.cleanup();
  await runtime.close();
  runtime = null;
  assert.equal(context.pages().length, baseline);
  assert.equal(personal.isClosed(), false);
  assert.equal((await popup.evaluate(() => chrome.tabGroups.query({}))).length, 0);
  console.log(
    "[native:smoke] PASS: native authorization, automatic grouped tabs, repeated tasks, handoff/resume and cleanup",
  );
} finally {
  console.log("[native:smoke] Releasing fixture host, browser and broker");
  await runtime?.close();
  await host?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await context?.close();
  if (registered) reg(["DELETE", key, "/f"]);
  assert.equal(path.dirname(folder), path.resolve(tmpdir()));
  assert.ok(path.basename(folder).startsWith("atlas-extension-native-smoke-"));
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
