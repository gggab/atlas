import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs the bundled worker with its production headed browser and private pipes.
const directory = await mkdtemp(path.join(tmpdir(), "atlas-worker-smoke-"));
const bundle = fileURLToPath(new URL("../../src-tauri/resources/browser-use/", import.meta.url));
const child = spawn(
  path.join(bundle, process.platform === "win32" ? "node.exe" : "node"),
  [path.join(bundle, "worker.mjs")],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);
const config = {
  browser: process.argv[2] ?? "edge",
  profileDir: path.join(directory, "profile"),
  artifactsDir: path.join(directory, "artifacts"),
};
let authorized = true,
  pending,
  currentCall,
  sequence = 0,
  stderr = "";
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.rpc) {
    assert.equal(message.call_id, currentCall);
    send({ rpc: message.rpc, ...(authorized ? { result: true } : { error: "Browser paused" }) });
  } else if (message.result) {
    pending?.resolve(message.result);
    pending = null;
  } else if (message.fatal) {
    pending?.reject(new Error(message.fatal));
    pending = null;
  }
});
const exited = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => {
    pending?.reject(new Error(`Worker exited ${code}: ${stderr}`));
    resolve(code);
  });
});
async function run(code, cleanup = false) {
  assert.equal(pending, null);
  currentCall = `smoke-${++sequence}`;
  const answer = new Promise((resolve, reject) => {
    pending = { resolve, reject };
  });
  send({ code, cleanup, config, call_id: currentCall });
  const timeout = setTimeout(() => pending?.reject(new Error("Worker smoke timeout")), 30_000);
  try {
    return await answer;
  } finally {
    clearTimeout(timeout);
  }
}
pending = null;
try {
  assert.equal(
    (await run("let tab = await browser.tabs.selected(); let counter = 40;")).isError,
    false,
  );
  assert.equal((await run("nodeRepl.write(++counter);")).content[0].text, "41");
  const blank = await run(
    "let blank = await browser.tabs.new(); nodeRepl.write(await blank.url());",
  );
  assert.equal(blank.content.at(-1).text, "about:blank");
  const image = await run("await nodeRepl.emitImage(await tab.screenshot());");
  assert.equal(image.content[0].type, "image");
  authorized = false;
  const revoked = await run("await tab.reload();");
  assert.equal(revoked.isError, true);
  assert.match(revoked.content[0].text, /Browser paused/);
  authorized = true;
  // Delayed code from an old call must not inherit a later call's authority.
  assert.equal(
    (
      await run(
        'let deferred = (async () => { await new Promise(r => setTimeout(r, 100)); try { await tab.reload(); return "incorrectly allowed"; } catch(e) { return e.message; } })(); undefined;',
      )
    ).isError,
    false,
  );
  const stale = await run("nodeRepl.write(await deferred);");
  assert.match(stale.content[0].text, /completed call/);
  await run("await tab.markHandoff();");
  const retained = await run("", true);
  assert.equal(retained.keepAlive, true);
  assert.equal(retained.tabs.length, 1);
  assert.equal(retained.tabs[0].disposition, "handoff");
  assert.equal((await run("await tab.title();")).isError, false);
  await run("await tab.markDeliverable();");
  assert.equal((await run("", true)).keepAlive, true);
  await run("await tab.markTemporary();");
  const cleaned = await run("", true);
  assert.equal(cleaned.keepAlive, false);
  assert.deepEqual(cleaned.tabs, []);
  send({ shutdown: true });
  const stopTimeout = setTimeout(() => child.kill(), 10_000);
  try {
    assert.equal(await exited, 0);
  } finally {
    clearTimeout(stopTimeout);
  }
  assert.equal(stderr, "");
  console.log(
    `${config.browser}: bundled worker, headed browser, persistent REPL, revocation, temporary-page cleanup, handoff/results retention and shutdown passed`,
  );
} finally {
  if (child.exitCode === null) {
    send({ shutdown: true });
    child.stdin.end();
    await exited;
  }
  lines.close();
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(directory, { recursive: true, force: true });
}
