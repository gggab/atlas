import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserHost } from "./host.mjs";
import { BrowserRuntime } from "./runtime.mjs";

const browser = process.argv[2] ?? "edge";
const headless = !process.argv.includes("--headed");
const server = createServer((_req, res) => {
  if (_req.url === "/file") {
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Content-Disposition": 'attachment; filename="result.txt"',
    });
    res.end("download verified");
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><title>Atlas Browser Smoke</title>
    <label>Name <input id="name"></label><button id="save" onclick="document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value">Save</button>
    <p id="result">Not saved</p><a href="/file">Download</a>
    <input type="file" aria-label="Upload"><iframe srcdoc="<button>Frame button</button>"></iframe>
    <button onclick="confirm('Confirm test')">Confirm</button>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const directory = await mkdtemp(path.join(tmpdir(), "atlas-browser-smoke-"));
let authorized = true;
const config = {
  browser,
  profileDir: path.join(directory, "profile"),
  artifactsDir: path.join(directory, "artifacts"),
  check: async () => {
    if (!authorized) throw new Error("Browser paused");
  },
};
let host, runtime;
const run = async (code) => {
  let timeout;
  const result = await Promise.race([
    runtime.execute(code),
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Browser smoke operation timed out: ${code.slice(0, 70)}`)),
        30_000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(result.isError, false, result.content.map((item) => item.text).join("\n"));
  return result;
};
try {
  host = new BrowserHost(config);
  await host.start({ headless });
  runtime = new BrowserRuntime({
    backend: (m, a) => host.call(m, a),
    resolvePage: (id) => host.resolvePage(id),
    browserId: browser,
  });
  await run(`let tab = await cua.createBrowserTab("${browser}", "${url}");`);
  await run(
    'await tab.playwright.getByLabel("Name").fill("Atlas"); await tab.playwright.getByRole("button",{name:"Save",exact:true}).click(); nodeRepl.write(await tab.playwright.locator("#result").innerText());',
  );
  assert.equal(
    (await run('nodeRepl.write(await tab.playwright.locator("#result").innerText());')).content.at(
      -1,
    ).text,
    "Saved Atlas",
  );
  const ax = await run("await tab.getAXState({disableDiffing:true});");
  assert.match(ax.content[0].text, /button "Save"/);
  const nameIndex = Number(/\[(\d+)\] textbox "Name/.exec(ax.content[0].text)[1]);
  const saveIndex = Number(/\[(\d+)\] button "Save"/.exec(ax.content[0].text)[1]);
  await run(`await tab.setValue(${nameIndex}, "AX input"); await tab.click(${saveIndex});`);
  assert.equal(
    (await run('nodeRepl.write(await tab.playwright.locator("#result").innerText());')).content[0]
      .text,
    "Saved AX input",
  );
  await run(
    'await tab.playwright.locator("body").filter({has:tab.playwright.locator("#save")}).getByRole("button",{name:"Save",exact:true}).click();',
  );
  const image = await run("await nodeRepl.emitImage(await tab.screenshot());");
  assert.equal(image.content[0].type, "image");
  assert.ok(image.content[0].data.length > 100);
  await run(
    'nodeRepl.write(await tab.playwright.frameLocator("iframe").getByRole("button").innerText());',
  );
  const download = await run(
    'let download = tab.playwright.waitForEvent("download"); await tab.playwright.getByRole("link",{name:"Download"}).click(); nodeRepl.write(await (await download).path());',
  );
  console.log(`${browser}: form, AX and download completed`);
  assert.equal(await readFile(download.content[0].text, "utf8"), "download verified");
  const upload = path.join(directory, "upload.txt");
  await writeFile(upload, "upload verified");
  await run(
    `let chooser = tab.playwright.waitForEvent("filechooser"); await tab.playwright.getByLabel("Upload").click(); await (await chooser).setFiles(${JSON.stringify(upload)});`,
  );
  assert.equal(
    (await run('nodeRepl.write(await tab.playwright.getByLabel("Upload").getAttribute("type"));'))
      .content[0].text,
    "file",
  );
  const page = [...host.pages.values()].find((p) => p.url() === url + "/");
  assert.equal(
    await page.locator('input[type="file"]').evaluate((input) => input.files[0].name),
    "upload.txt",
  );
  const dialogEvent = page.waitForEvent("dialog");
  const dialogAction = run(
    'let dialogClick = tab.playwright.getByRole("button",{name:"Confirm",exact:true}).click(); let dialog; for(let i=0; i<100; ++i) { dialog = await tab.getJsDialog(); if(dialog) break; await tab.playwright.waitForTimeout(50); } if(!dialog) throw new Error("Dialog did not appear"); nodeRepl.write(dialog.message); await dialog.accept(); await dialogClick;',
  );
  await dialogEvent;
  assert.equal((await dialogAction).content[0].text, "Confirm test");
  await host.context.addCookies([
    {
      name: "persistent_login_test",
      value: "present",
      url,
      expires: Math.floor(Date.now() / 1000) + 3600,
    },
  ]);
  authorized = false;
  assert.equal(
    (
      await runtime.execute(
        'await tab.playwright.getByRole("button",{name:"Save",exact:true}).click();',
      )
    ).isError,
    true,
  );
  authorized = true;
  console.log(`${browser}: upload, dialog and revocation completed`);
  await run(
    "await tab.markHandoff(); let resultPage = await browser.tabs.new(); await resultPage.markDeliverable(); let temporaryPage = await browser.tabs.new();",
  );
  console.log(`${browser}: retention marks set`);
  const retained = await host.cleanup();
  console.log(`${browser}: temporary pages cleaned; handoff/results retained`);
  assert.equal(retained.keepAlive, true);
  assert.equal(retained.tabs.length, 2);
  await run("await tab.markTemporary(); await resultPage.markTemporary();");
  assert.equal((await host.cleanup()).keepAlive, false);
  console.log(`${browser}: all temporary pages and browser closed`);
  assert.equal(await readFile(download.content[0].text, "utf8"), "download verified");
  await runtime.close();
  await host.close();
  host = new BrowserHost(config);
  await host.start({ headless });
  assert.ok(
    (await host.context.cookies(url)).some((cookie) => cookie.name === "persistent_login_test"),
  );
  console.log(
    `${browser}: form, AX input, screenshot, iframe, upload/download, dialog, temporary-page cleanup, retained pages, saved downloads and profile persistence passed`,
  );
} finally {
  await runtime?.close();
  await host?.close();
  await new Promise((resolve) => server.close(resolve));
  // This directory is generated by mkdtemp inside OS temp and contains no user profile.
  assert.ok(
    path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep),
    "Unexpected smoke directory; refusing cleanup",
  );
  await rm(directory, { recursive: true, force: true });
}
