import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bundled private-pipe test driver. No vendor/model or real credentials.
export class ExtensionWorkerFixture {
  constructor() {
    const bundle = fileURLToPath(
      new URL("../../src-tauri/resources/browser-use/", import.meta.url),
    );
    this.child = spawn(
      path.join(bundle, process.platform === "win32" ? "node.exe" : "node"),
      [path.join(bundle, "worker.mjs")],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    this.allowed = true;
    this.sequence = 0;
    this.exit = new Promise((resolve) => this.child.once("exit", resolve));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.rpc)
        this.send({
          rpc: message.rpc,
          ...(this.allowed && message.call_id === this.callId
            ? { result: true }
            : { error: "Browser paused or completed call" }),
        });
      else if (message.pairing) this.endpoint = message.pairing;
      else if (message.result) {
        this.pending?.resolve(message.result);
        this.pending = null;
      } else if (message.fatal) {
        this.pending?.reject(new Error(message.fatal));
        this.pending = null;
      }
    });
    this.child.on("error", (error) => this.pending?.reject(error));
    this.child.on("exit", () => this.pending?.reject(new Error("Worker exited during operation")));
  }
  send(message) {
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  async run(code, cleanup = false) {
    if (this.pending) throw new Error("Worker test already running");
    this.callId = `extension-fixture-${++this.sequence}`;
    const result = new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    this.send({ code, cleanup, call_id: this.callId, config: { browser: "extension" } });
    const timeout = setTimeout(
      () => this.pending?.reject(new Error("Extension worker test timed out")),
      20_000,
    );
    try {
      return await result;
    } finally {
      clearTimeout(timeout);
      this.pending = null;
    }
  }
  async close() {
    this.send({ shutdown: true });
    const timer = setTimeout(() => this.child.kill(), 3000);
    await this.exit;
    clearTimeout(timer);
    this.lines.close();
  }
}
