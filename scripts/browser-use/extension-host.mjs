import { chromium } from "playwright-core";
import { BrowserHost } from "./host.mjs";
import { ExtensionRelay } from "./extension-relay.mjs";
import { once } from "node:events";

export class ExtensionHost extends BrowserHost {
  constructor(config) {
    super({ ...config, browser: "chrome" });
    this.pairing = config.pairing ?? (() => {});
  }
  async start() {
    await this.check();
    this.relay = new ExtensionRelay();
    this.relay.on("disconnected", () => this.disconnected?.());
    this.relay.on("ready", () => this.connected?.());
    await this.relay.start();
    this.pairing(this.relay.endpoint);
  }
  async connect() {
    await this.check();
    if (this.context) return;
    if (!this.relay.connected)
      await Promise.race([
        once(this.relay, "ready"),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Browser profile is disconnected. Check Atlas Settings > Browser control.",
                ),
              ),
            15_000,
          );
          timer.unref();
        }),
      ]);
    this.connection = await chromium.connectOverCDP(this.relay.transport, {
      noDefaults: true,
      timeout: 15_000,
    });
    this.context = this.connection.contexts()[0];
    this.context.setDefaultTimeout(15_000);
    this.context.setDefaultNavigationTimeout(30_000);
    for (const page of this.context.pages()) this.register(page);
    this.context.on("page", (page) => this.register(page));
    this.connection.on("disconnected", () => {
      this.pages.clear();
      this.changed([]);
    });
  }
  async call(method, args) {
    if (method === "close")
      throw new Error("Shared tabs are preserved. Use browser_reset to disconnect control.");
    if (method === "visibility")
      throw new Error(
        "Window minimize/restore is unavailable in extension mode; manage the window manually.",
      );
    if (method === "mark") {
      await this.check();
      const page = await this.resolvePage(args.id);
      const client = await this.context.newCDPSession(page);
      try {
        const { targetInfo } = await client.send("Target.getTargetInfo");
        await this.relay.rpc("mark", {
          targetId: targetInfo.targetId,
          disposition: args.disposition,
        });
      } finally {
        await client.detach();
      }
    }
    return super.call(method, args);
  }
  async close() {
    // Closing a connectOverCDP connection disconnects; never close its context.
    try {
      if (this.relay?.connected) await this.relay.rpc("cleanup");
    } finally {
      await this.relay?.close();
      await this.connection?.close();
      this.pages.clear();
    }
  }
  async cleanup() {
    await this.check();
    // Pending user pairing stays available across an agent's explanatory reply.
    if (!this.relay?.connected && !this.context) return { keepAlive: true, tabs: [] };
    await this.close();
    return { keepAlive: false, tabs: [] };
  }
}
