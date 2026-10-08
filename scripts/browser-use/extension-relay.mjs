import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

// Use the WebSocket implementation already bundled with pinned Playwright.
// This private export is covered by the relay tests and must be checked on upgrades.
const require = createRequire(import.meta.url);
export const { ws, wsServer } = require(
  path.join(path.dirname(require.resolve("playwright-core/package.json")), "lib/utilsBundle.js"),
);

export class ExtensionRelay extends EventEmitter {
  constructor() {
    super();
    this.targets = new Map();
    this.sessions = new Map();
    this.pending = new Map();
    this.sequence = 0;
    this.transport = {
      send: (message) => {
        void this.dispatch(message);
      },
      close: () => {
        void this.close();
      },
    };
  }
  async start() {
    const secretPath = `/extension/${randomBytes(32).toString("hex")}`;
    this.server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.sockets = new wsServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    this.server.on("upgrade", (req, socket, head) => {
      // Browser pages cannot pair. The secret is per-worker, never the MCP token.
      if (
        req.url !== secretPath ||
        !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin ?? "") ||
        this.socket
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      this.sockets.handleUpgrade(req, socket, head, (client) => {
        this.socket = client;
        client.on("message", (data) => {
          try {
            this.receive(JSON.parse(data.toString()));
          } catch {
            client.close(1008, "Invalid extension message");
          }
        });
        client.on("error", () => client.terminate());
        client.on("close", () => {
          this.connected = false;
          for (const pending of this.pending.values())
            pending.reject(new Error("Extension disconnected"));
          this.pending.clear();
          this.transport.onclose?.("Extension disconnected; share the tab again");
          this.emit("disconnected");
        });
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.endpoint = `ws://127.0.0.1:${this.server.address().port}${secretPath}`;
    return this.endpoint;
  }
  receive(message) {
    if (message.type === "ping") return;
    if (message.type === "ready") {
      if (this.connected || !message.targetInfo?.targetId || message.targetInfo.type !== "page")
        throw new Error("Invalid handshake");
      this.connected = true;
      this.userAgent = String(message.userAgent ?? "Chrome/140.0.0.0");
      this.addTarget(message.targetInfo);
      this.emit("ready");
    } else if (message.type === "attached") {
      if (!this.connected) throw new Error("Not paired");
      this.addTarget(message.targetInfo);
    } else if (message.type === "event") {
      if (!this.targets.has(message.targetId)) throw new Error("Unshared target");
      const sessionId = message.sessionId ?? this.targets.get(message.targetId).sessionId;
      if (message.method === "Target.attachedToTarget")
        this.sessions.set(message.params.sessionId, message.targetId);
      if (message.method === "Target.detachedFromTarget")
        this.sessions.delete(message.params.sessionId);
      this.transport.onmessage?.({ sessionId, method: message.method, params: message.params });
    } else if (message.type === "detached") {
      const target = this.targets.get(message.targetId);
      if (target) {
        this.targets.delete(message.targetId);
        for (const [session, id] of this.sessions)
          if (id === message.targetId) this.sessions.delete(session);
        this.transport.onmessage?.({
          method: "Target.detachedFromTarget",
          params: { sessionId: target.sessionId, targetId: message.targetId },
        });
      }
    } else if (message.id) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve(message.result);
    } else throw new Error("Unknown message");
  }
  addTarget(info) {
    const sessionId = `atlas-tab-${++this.sequence}`;
    this.targets.set(info.targetId, { info, sessionId });
    this.sessions.set(sessionId, info.targetId);
    if (this.autoAttach) this.attachEvent(info.targetId);
  }
  attachEvent(targetId) {
    const { info, sessionId } = this.targets.get(targetId);
    this.transport.onmessage?.({
      method: "Target.attachedToTarget",
      params: { sessionId, targetInfo: { ...info, attached: true }, waitingForDebugger: false },
    });
  }
  rpc(method, params = {}) {
    if (!this.connected || this.socket?.readyState !== ws.OPEN)
      return Promise.reject(new Error("Extension is not connected"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Extension command timed out"));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async command(method, params = {}, sessionId) {
    if (!this.connected) throw new Error("Extension is not connected");
    if (!sessionId || sessionId === "atlas-browser") {
      switch (method) {
        case "Target.attachToBrowserTarget":
          return { sessionId: "atlas-browser" };
        case "Browser.getVersion":
          return {
            protocolVersion: "1.3",
            product: this.userAgent.match(/Chrome\/[^ ]+/)?.[0] ?? "Chrome/140.0.0.0",
            userAgent: this.userAgent,
            revision: "extension",
          };
        // Default browser downloads stay under browser/user ownership. No download override.
        case "Browser.setDownloadBehavior":
          return {};
        case "Target.getBrowserContexts":
          return { browserContextIds: [] };
        case "Target.getTargets":
          return { targetInfos: [...this.targets.values()].map((t) => t.info) };
        case "Target.setAutoAttach":
          this.autoAttach = params.autoAttach;
          if (this.autoAttach) for (const id of this.targets.keys()) this.attachEvent(id);
          return {};
        case "Target.getTargetInfo": {
          const target = params.targetId
            ? this.targets.get(params.targetId)
            : this.targets.values().next().value;
          if (!target) throw new Error("Target is not shared");
          return { targetInfo: target.info };
        }
        case "Target.attachToTarget": {
          const target = this.targets.get(params.targetId);
          if (!target) throw new Error("Target is not shared");
          // Playwright CDPSession multiplexes the already attached tab.
          const session = `atlas-cdp-${++this.sequence}`;
          this.sessions.set(session, params.targetId);
          return { sessionId: session };
        }
        case "Target.detachFromTarget":
          this.sessions.delete(params.sessionId);
          this.transport.onmessage?.({
            sessionId,
            method: "Target.detachedFromTarget",
            params: { sessionId: params.sessionId },
          });
          return {};
        case "Target.createTarget":
          return this.rpc("create", { url: params.url });
        case "Target.closeTarget":
          throw new Error("Shared browser pages are preserved; disconnect control instead");
        default:
          throw new Error(`Unsupported browser-wide extension command: ${method}`);
      }
    }
    const targetId = this.sessions.get(sessionId);
    if (!targetId || !this.targets.has(targetId)) throw new Error("Target is not shared");
    const rootSession = /^(atlas-tab-|atlas-cdp-)/.test(sessionId);
    return this.rpc("cdp", {
      targetId,
      sessionId: rootSession ? undefined : sessionId,
      method,
      params,
    });
  }
  async dispatch(message) {
    const { id, method, params, sessionId } = message;
    try {
      this.transport.onmessage?.({
        id,
        sessionId,
        result: await this.command(method, params, sessionId),
      });
    } catch (error) {
      this.transport.onmessage?.({ id, sessionId, error: { message: error.message } });
    }
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    this.connected = false;
    // Disconnecting never sends Browser.close, Page.close or chrome.tabs.remove.
    this.socket?.close(1000, "Atlas released control");
    const force = setTimeout(() => this.socket?.terminate(), 500);
    if (this.sockets) await new Promise((resolve) => this.sockets.close(resolve));
    clearTimeout(force);
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }
}
