import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import https from "node:https";

const executable = path.resolve(process.argv[2]);
const dir = await mkdtemp(path.join(tmpdir(), "deskmate-background-native-"));
const launcher = `const fs=require('node:fs');const c=require('node:child_process').spawn(process.argv[1],['--background-probe-server','--probe-dir',process.argv[2]],{detached:true,windowsHide:true,stdio:['ignore',fs.openSync(process.argv[2]+'/stdout.log','w'),fs.openSync(process.argv[2]+'/stderr.log','w')]});c.unref();console.log(c.pid)`;
const launched = spawnSync(process.execPath, ["-e", launcher, executable, dir], {
  encoding: "utf8",
  windowsHide: true,
});
assert.equal(launched.status, 0);
const pid = Number(launched.stdout.trim());
assert.ok(Number.isInteger(pid) && pid > 0);
let endpoint;
const certificate = () =>
  `-----BEGIN CERTIFICATE-----\n${endpoint.certificate.match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(route, body, auth = true) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: endpoint.port,
        path: route,
        method: body === undefined ? "GET" : "POST",
        ca: certificate(),
        headers: {
          ...(auth ? { Authorization: `Bearer ${endpoint.token}` } : {}),
          "Content-Type": "application/json",
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (s) => {
          text += s;
        });
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode,
              value:
                text && response.headers["content-type"]?.includes("json")
                  ? JSON.parse(text)
                  : text || null,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("fixture request timeout")));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
try {
  for (let i = 0; i < 200; i++) {
    try {
      endpoint = JSON.parse(await readFile(path.join(dir, "endpoint.json"), "utf8"));
      break;
    } catch {
      await sleep(100);
    }
  }
  assert.ok(endpoint, "detached backend must start after its launcher exits");
  const duplicate = spawnSync(executable, ["--background-probe-server", "--probe-dir", dir], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  assert.ok(
    duplicate.status !== null && duplicate.status !== 0,
    "a second backend must fail instead of opening the same store",
  );
  assert.equal(
    JSON.parse(await readFile(path.join(dir, "endpoint.json"), "utf8")).boot,
    endpoint.boot,
  );
  assert.equal((await request("/health", undefined, false)).status, 401);
  assert.equal((await request("/invoke", { command: "window_zoom", args: {} })).status, 403);
  const failure = await request("/invoke", { command: "tasks_snapshot", args: { fail: true } });
  assert.deepEqual(failure.value, {
    ok: false,
    value: { kind: "auth", message: "fictional authentication required" },
  });
  const task = await request("/invoke", {
    command: "tasks_upsert",
    args: {
      input: {
        idempotencyKey: "fixture-reminder",
        scopeKey: "fixture",
        kind: "reminder",
        title: "Fictional reminder",
        prompt: "No user data",
        dueAt: Date.now() + 1000,
        maxRuns: 1,
        timeoutSeconds: 30,
      },
    },
  });
  assert.equal(task.value.ok, true);
  await new Promise((resolve) => {
    const req = https.request({
      hostname: "127.0.0.1",
      port: endpoint.port,
      path: "/invoke",
      method: "POST",
      ca: certificate(),
      headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
    });
    req.on("error", () => resolve());
    req.end(JSON.stringify({ command: "agents_send", args: {} }));
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 300);
  });
  await sleep(2300);
  const snapshot = (await request("/invoke", { command: "tasks_snapshot", args: {} })).value.value;
  assert.equal(snapshot.started, 1);
  assert.equal(snapshot.finished, 1);
  assert.equal(snapshot.notifications.length, 1);
  assert.equal(snapshot.tasks[0].id, task.value.value.id);
  assert.equal((await request("/pending")).value.events.length, 1);
  assert.equal(
    (
      await request("/invoke", {
        command: "agents_respond_permission",
        args: { requestId: "probe-request" },
      })
    ).value.ok,
    true,
  );
  assert.equal((await request("/pending")).value.events.length, 0);
  // An attached Windows test child failed native window creation; match the independent server launch.
  const client = spawnSync(executable, ["--background-probe-client", "--probe-dir", dir], {
    encoding: "utf8",
    windowsHide: true,
    detached: true,
    timeout: 25000,
  });
  assert.equal(client.status, 0, `native client failed: ${client.stderr}`);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "client-result.json"), "utf8")), {
    ok: true,
  });
  assert.equal(
    (await request("/health")).status,
    200,
    "exiting the native client must leave the backend running",
  );
  if (process.platform === "darwin") process.kill(pid, "SIGTERM");
  else await request("/shutdown", {});
  await sleep(1500);
  await assert.rejects(readFile(path.join(dir, "endpoint.json")), { code: "ENOENT" });
  console.log(
    "NATIVE_BACKGROUND_OK detachedOwner=1 secondOwnerRejected=1 durableReminder=1 continuedMockAgent=1 duplicateDispatch=0 pendingApproval=0 nativeClientRelay=1 clientExitPreservesBackend=1 stoppedEndpointRemoved=1",
  );
} catch (error) {
  for (const name of [
    "stdout.log",
    "stderr.log",
    "client-lifecycle.log",
    "client-lifecycle.state",
  ]) {
    try {
      console.error(`${name}: ${(await readFile(path.join(dir, name), "utf8")).slice(-4000)}`);
    } catch {}
  }
  throw error;
} finally {
  if (endpoint) {
    try {
      await request("/shutdown", {});
      await sleep(1500);
    } catch {}
  }
  const target = path.resolve(dir);
  assert.ok(target.startsWith(path.resolve(tmpdir()) + path.sep + "deskmate-background-native-"));
  await rm(target, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
}
