// The native port carries bootstrap metadata only. CDP stays on the task relay.
import { HOST_NAME } from "./config.js";
export class NativeConnection {
  constructor(api, controller) {
    this.api = api;
    this.controller = controller;
    this.connected = false;
    api.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "atlas-native-reconnect") void this.connect();
    });
  }
  async restore() {
    const settings = await this.api.storage.local.get(["clientId", "browserDataConsent"]);
    this.dataConsent = settings.browserDataConsent === 1;
    this.enabled = true;
    this.hostName = HOST_NAME;
    this.clientId = settings.clientId ?? crypto.randomUUID();
    await this.api.storage.local.set({ clientId: this.clientId });
    const { shareNextTab } = await this.api.storage.session.get("shareNextTab");
    this.shareNextTab = Number.isInteger(shareNextTab) ? shareNextTab : undefined;
    if (this.enabled) await this.connect();
  }
  requireConsent() {
    if (!this.dataConsent)
      throw new Error("Open Atlas Browser and give consent before sharing page data.");
  }
  async setConsent(accepted) {
    if (typeof accepted !== "boolean") throw new Error("Consent must be a boolean");
    const decision = (this.consentDecision = (this.consentDecision ?? 0) + 1);
    let stopped;
    if (!accepted) {
      this.dataConsent = false;
      this.shareNextTab = undefined;
      // Cancel in-flight attachments and close the relay before storage writes.
      stopped = this.controller.disconnect();
    }
    const previous = this.consentPending;
    const update = (async () => {
      // Each caller receives its own error; serialize retries and decisions from multiple popups.
      if (previous) await Promise.allSettled([previous]);
      await Promise.all([
        stopped,
        this.api.storage.local.set({ browserDataConsent: accepted ? 1 : null }),
        accepted ? undefined : this.api.storage.session.set({ shareNextTab: null }),
      ]);
      if (accepted && decision === this.consentDecision) {
        this.dataConsent = true;
        this.error = null;
      }
    })();
    this.consentPending = update;
    try {
      await update;
    } finally {
      if (this.consentPending === update) this.consentPending = null;
    }
  }
  async reconnect() {
    this.port?.disconnect();
    this.port = null;
    this.connected = false;
    this.error = null;
    await this.connect();
    for (let i = 0; i < 100 && !this.connected && this.port; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (!this.connected)
      throw new Error(this.error ?? "Open Atlas, then check Settings > Browser control.");
  }
  async connect() {
    if (!this.enabled || this.port) return;
    await this.api.alarms.create("atlas-native-reconnect", { periodInMinutes: 0.5 });
    try {
      this.port = this.api.runtime.connectNative(this.hostName);
      const port = this.port;
      port.onMessage.addListener((message) => {
        void this.receive(port, message);
      });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.error =
          this.error ??
          this.api.runtime.lastError?.message ??
          "Atlas connection closed. Reopen Atlas to reconnect.";
        this.port = null;
        this.connected = false;
      });
      port.postMessage({
        clientId: this.clientId,
        browser: /Edg\//.test(globalThis.navigator?.userAgent ?? "") ? "edge" : "chrome",
        version: this.api.runtime.getManifest().version,
      });
    } catch (error) {
      this.port = null;
      this.connected = false;
      this.error = error.message;
    }
  }
  async receive(port, message) {
    if (this.port !== port) return;
    if (message.type === "bridgeReady") {
      this.connected = true;
      this.error = null;
      return;
    }
    if (message.type === "error") {
      this.error = message.error;
      return;
    }
    if (message.type === "unbound") {
      this.port = null;
      this.connected = false;
      port.disconnect();
      await this.controller.disconnect();
      return;
    }
    if (message.type !== "start" || typeof message.id !== "string") return;
    try {
      if (!this.connected || !this.enabled) throw new Error("Automatic connection is disabled");
      this.requireConsent();
      await this.controller.connect(
        message.endpoint,
        this.shareNextTab,
        message.title,
        message.sessionId,
      );
      this.requireConsent();
      this.shareNextTab = undefined;
      await this.api.storage.session.set({ shareNextTab: null });
      this.error = null;
      port.postMessage({ id: message.id, result: true });
    } catch (error) {
      this.error = error.message;
      if (this.port === port) port.postMessage({ id: message.id, error: error.message });
    }
  }
  async share(tabId) {
    this.requireConsent();
    const tab = await this.api.tabs.get(tabId);
    this.requireConsent();
    if (!/^https?:\/\//.test(tab.url ?? "")) throw new Error("Choose an HTTP(S) web page first");
    if (this.controller.socket)
      throw new Error("Take over the active task before sharing another tab");
    this.shareNextTab = tabId;
    await this.api.storage.session.set({ shareNextTab: tabId });
  }
  status() {
    return {
      automatic: !!this.enabled,
      dataConsent: !!this.dataConsent,
      appConnected: this.connected,
      hostName: this.hostName,
      connectionError: this.error,
      shareNextTab: this.shareNextTab,
    };
  }
}
