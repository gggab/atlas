import { chromium } from "playwright-core";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export class BrowserHost {
  constructor({ browser, profileDir, artifactsDir, check, changed = () => {} }) {
    if (!["chrome", "edge"].includes(browser)) throw new Error("Choose chrome or edge");
    Object.assign(this, { browser, profileDir, artifactsDir, check, changed });
    this.pages = new Map();
    this.history = [];
    this.dispositions = new Map();
  }
  async start({ headless = false } = {}) {
    await this.check();
    await mkdir(this.artifactsDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      channel: this.browser === "edge" ? "msedge" : "chrome",
      headless,
      viewport: null,
      acceptDownloads: true,
      downloadsPath: this.artifactsDir,
      chromiumSandbox: true,
    });
    this.context.setDefaultTimeout(15_000);
    this.context.setDefaultNavigationTimeout(30_000);
    for (const page of this.context.pages()) this.register(page);
    this.context.on("page", (page) => this.register(page));
    this.context.on("close", () => {
      this.pages.clear();
      this.changed([]);
    });
  }
  register(page) {
    for (const [id, existing] of this.pages) if (existing === page) return id;
    const id = randomUUID();
    this.pages.set(id, page);
    page.on("close", () => {
      this.pages.delete(id);
      this.dispositions.delete(id);
      this.notify();
    });
    page.on("framenavigated", async (frame) => {
      if (frame !== page.mainFrame()) return;
      this.history.push({
        id,
        url: page.url(),
        title: await page.title().catch(() => ""),
        dateVisited: new Date().toISOString(),
      });
      if (this.history.length > 300) this.history.shift();
      this.notify();
    });
    // This listener prevents Playwright's automatic dialog dismissal.
    page.on("dialog", (dialog) => {
      page.__atlasDialog = dialog;
    });
    this.notify();
    return id;
  }
  async resolvePage(id) {
    await this.check();
    const page = this.pages.get(id);
    if (!page || page.isClosed())
      throw new Error("Browser tab was closed; refresh the tab inventory");
    return page;
  }
  async list() {
    const items = [];
    for (const [id, page] of this.pages) {
      if (!page.isClosed())
        items.push({
          id,
          url: page.url(),
          title: await page.title().catch(() => ""),
          disposition: this.dispositions.get(id) ?? "temporary",
        });
    }
    return items;
  }
  notify() {
    this.list()
      .then(this.changed)
      .catch(() => {});
  }
  async call(method, args = {}) {
    await this.check();
    if (method === "list") return this.list();
    if (method === "artifact") {
      const filename = path
        .basename(args.filename || "download")
        .replace(/[<>:"/\\|?*]/g, "_")
        .slice(0, 120);
      return path.join(this.artifactsDir, `${randomUUID()}-${filename}`);
    }
    if (method === "authorize") {
      await this.resolvePage(args.id);
      return { id: args.id };
    }
    if (method === "create") {
      const page = await this.context.newPage();
      const id = this.register(page);
      if (args.url !== undefined) await page.goto(args.url, { waitUntil: "domcontentloaded" });
      if (args.visible) await page.bringToFront();
      return { id };
    }
    if (method === "close") {
      await (await this.resolvePage(args.id)).close();
      return null;
    }
    if (method === "mark") {
      await this.resolvePage(args.id);
      if (!["temporary", "deliverable", "handoff"].includes(args.disposition))
        throw new Error("Invalid tab disposition");
      this.dispositions.set(args.id, args.disposition);
      this.notify();
      return null;
    }
    if (method === "name") {
      this.name = String(args.name).slice(0, 120);
      return null;
    }
    if (method === "history") {
      const limit = Math.min(Math.max(args.limit ?? 100, 1), 300);
      return this.history
        .filter(
          (item) =>
            (!args.from || item.dateVisited >= new Date(args.from).toISOString()) &&
            (!args.to || item.dateVisited <= new Date(args.to).toISOString()) &&
            (!args.queries ||
              args.queries.some((query) => `${item.title} ${item.url}`.includes(query))),
        )
        .slice(-limit)
        .reverse();
    }
    if (method === "visibility") {
      const page = this.pages.values().next().value;
      if (!page) throw new Error("No browser window is open");
      const client = await this.context.newCDPSession(page);
      try {
        const { windowId } = await client.send("Browser.getWindowForTarget");
        await client.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: args.visible ? "normal" : "minimized" },
        });
      } finally {
        await client.detach();
      }
      return null;
    }
    throw new Error(`Unsupported browser operation: ${method}`);
  }
  async close() {
    await this.context?.close();
  }
  async cleanup() {
    await this.check();
    const temporaryPages = [...this.pages].filter(
      ([id, page]) =>
        !page.isClosed() && (this.dispositions.get(id) ?? "temporary") === "temporary",
    );
    for (const [, page] of temporaryPages) {
      if (!page.isClosed()) {
        await this.check();
        await page.close();
      }
    }
    const tabs = await this.list();
    if (!tabs.length) await this.close();
    return { keepAlive: tabs.length > 0, tabs };
  }
}
