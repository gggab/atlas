import { createInterface } from "node:readline";
import { BrowserRuntime } from "./runtime.mjs";
import { BrowserHost } from "./host.mjs";
import { ExtensionHost } from "./extension-host.mjs";
import { AsyncLocalStorage } from "node:async_hooks";

// Private parent/child NDJSON transport. Tokens never enter the REPL. User code
// and browser content are never written to stderr or application logs.
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let seq = 0;
const pending = new Map();
const calls = new AsyncLocalStorage();
let activeCall;
const check = () =>
  new Promise((resolve, reject) => {
    const callId = calls.getStore();
    if (!callId || callId !== activeCall) {
      reject(new Error("Browser operation belongs to a completed call; await all actions"));
      return;
    }
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ rpc: id, method: "check", call_id: callId });
  });
let host,
  runtime,
  busy = false,
  launching,
  closing = false;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await launching?.catch(() => {});
  await runtime?.close();
  await host?.close();
  process.exit(0);
};
lines.on("line", async (line) => {
  let input;
  try {
    input = JSON.parse(line);
  } catch {
    send({ fatal: "Malformed browser worker request" });
    return;
  }
  if (input.rpc) {
    const waiter = pending.get(input.rpc);
    pending.delete(input.rpc);
    if (input.error) waiter?.reject(new Error(input.error));
    else waiter?.resolve(input.result);
    return;
  }
  if (input.shutdown) {
    await shutdown();
    return;
  }
  if (busy) {
    send({
      result: {
        isError: true,
        content: [{ type: "text", text: "Browser runtime already executing" }],
      },
    });
    return;
  }
  busy = true;
  activeCall = input.call_id;
  await calls.run(input.call_id, async () => {
    try {
      if (input.cleanup) {
        send({ result: host ? await host.cleanup() : { keepAlive: false, tabs: [] } });
        return;
      }
      if (!host) {
        const Host = input.config.browser === "extension" ? ExtensionHost : BrowserHost;
        host = new Host({
          ...input.config,
          check,
          changed: (tabs) => send({ tabs }),
          pairing: (url) => send({ pairing: url }),
        });
        host.disconnected = () => send({ disconnected: true });
        host.connected = () => send({ connected: true });
        launching = host.start();
        await launching;
        if (closing) return;
      }
      if (host instanceof ExtensionHost) {
        if (!input.code) {
          send({
            result: {
              content: [
                {
                  type: "text",
                  text: "Authorized browser connection requested. A new Agent task tab is opened automatically.",
                },
              ],
            },
          });
          return;
        }
        await host.connect();
      }
      if (!runtime) {
        runtime = new BrowserRuntime({
          backend: (method, args) => host.call(method, args),
          resolvePage: (id) => host.resolvePage(id),
          browserId: input.config.browser,
        });
      }
      send({ result: await runtime.execute(input.code) });
    } catch (error) {
      if (!runtime && !(host instanceof ExtensionHost)) send({ fatal: error.message });
      else send({ result: { isError: true, content: [{ type: "text", text: error.message }] } });
    } finally {
      busy = false;
      activeCall = null;
    }
  });
});
lines.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
