// Decisions live in this browser profile; only the extension UI can change them.
export class SitePermissions {
  constructor(api) {
    this.api = api;
    this.policy = { allowAll: false, sites: {} };
    this.once = new Set();
    this.pending = new Map();
    this.epoch = 0;
    api.windows.onRemoved.addListener((id) => {
      if (id === this.windowId) {
        this.windowId = undefined;
        this.cancel();
      }
    });
  }
  async restore() {
    const { websiteAccess } = await this.api.storage.local.get("websiteAccess");
    if (websiteAccess?.version === 1) {
      this.policy.allowAll = websiteAccess.allowAll === true;
      for (const [host, decision] of Object.entries(websiteAccess.sites ?? {}))
        if (["allow", "block"].includes(decision) && this.host(`https://${host}`) === host)
          this.policy.sites[host] = decision;
    }
  }
  host(value) {
    const url = new URL(value);
    if (url.href === "about:blank" || url.href === "about:srcdoc") return null;
    if (!["http:", "https:", "file:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Only HTTP(S) websites or file URLs can be authorized");
    return url.protocol === "file:" ? null : url.hostname;
  }
  async authorizeFiles() {
    if (!(await this.api.extension.isAllowedFileSchemeAccess()))
      throw new Error(
        'File access is disabled. Open the browser Extensions page, select DeskMate Browser > Details, and turn on "Allow access to file URLs", then retry.',
      );
  }
  begin() {
    this.end();
    this.active = true;
  }
  cancel() {
    ++this.epoch;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Website authorization was cancelled"));
    }
    this.pending.clear();
  }
  end() {
    this.active = false;
    this.once.clear();
    this.cancel();
    const id = this.windowId;
    this.windowId = undefined;
    if (id !== undefined)
      void this.api.windows.remove(id).catch((error) => {
        this.error = error.message;
      });
  }
  async authorize(value) {
    if (!this.active) throw new Error("Website authorization was cancelled");
    if (this.updating)
      throw new Error("Website access is being updated. Try again when it finishes.");
    if (this.policyError) throw new Error(this.policyError);
    const host = this.host(value);
    if (new URL(value).protocol === "file:") {
      const epoch = this.epoch;
      await this.authorizeFiles();
      if (!this.active || epoch !== this.epoch)
        throw new Error("Website authorization was cancelled");
    }
    if (!host) return;
    if (this.policy.sites[host] === "block") throw new Error(`Access to ${host} is not allowed`);
    if (this.once.has(host) || this.policy.sites[host] === "allow" || this.policy.allowAll) return;
    const existing = [...this.pending.values()].find((request) => request.host === host);
    if (existing) return existing.promise;
    const id = crypto.randomUUID();
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const request = { id, host, promise, resolve, reject };
    request.timer = setTimeout(() => {
      this.pending.delete(id);
      reject(
        new Error(`Website authorization timed out for ${host}. Try again after reviewing access.`),
      );
    }, 55_000);
    this.pending.set(id, request);
    void this.openPrompt().catch((error) => {
      if (this.pending.delete(id)) {
        clearTimeout(request.timer);
        reject(error);
      }
    });
    return promise;
  }
  async openPrompt() {
    if (this.windowId !== undefined || this.opening) return;
    const epoch = this.epoch;
    this.opening = this.api.windows.create({
      url: this.api.runtime.getURL("popup.html#website-access"),
      type: "popup",
      width: 420,
      height: 700,
      focused: true,
    });
    try {
      const window = await this.opening;
      if (epoch !== this.epoch || !this.pending.size) await this.api.windows.remove(window.id);
      else this.windowId = window.id;
    } finally {
      this.opening = null;
    }
  }
  async save(update) {
    const previous = this.saving;
    const operation = (async () => {
      if (previous) await Promise.allSettled([previous]);
      const policy = update({ ...this.policy, sites: { ...this.policy.sites } });
      await this.api.storage.local.set({ websiteAccess: { version: 1, ...policy } });
      this.policy = policy;
    })();
    this.saving = operation;
    try {
      await operation;
    } finally {
      if (this.saving === operation) this.saving = null;
    }
  }
  async respond(id, choice) {
    const request = this.pending.get(id);
    if (!request) throw new Error("This website request is no longer active");
    if (!["allow_once", "allow_site", "allow_all", "deny"].includes(choice))
      throw new Error("Invalid website authorization choice");
    const epoch = this.epoch;
    if (choice !== "allow_once")
      await this.save((policy) => {
        if (choice === "allow_site") policy.sites[request.host] = "allow";
        if (choice === "deny") policy.sites[request.host] = "block";
        if (choice === "allow_all") policy.allowAll = true;
        return policy;
      });
    if (epoch !== this.epoch || !this.pending.has(id))
      throw new Error("This website request is no longer active");
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (choice === "deny") request.reject(new Error(`Access to ${request.host} is not allowed`));
    else {
      this.once.add(request.host);
      request.resolve();
    }
    if (choice === "allow_all") {
      for (const other of this.pending.values()) {
        clearTimeout(other.timer);
        if (this.policy.sites[other.host] === "block")
          other.reject(new Error(`Access to ${other.host} is not allowed`));
        else other.resolve();
      }
      this.pending.clear();
    }
    if (!this.pending.size && this.windowId !== undefined) {
      const windowId = this.windowId;
      this.windowId = undefined;
      await this.api.windows.remove(windowId);
    }
  }
  async revoke(host) {
    if (this.host(`https://${host}`) !== host) throw new Error("Invalid website hostname");
    this.end();
    const stopped = this.onRevoked?.();
    await this.update(
      () =>
        this.save((policy) => {
          delete policy.sites[host];
          return policy;
        }),
      stopped,
    );
  }
  async reset() {
    this.end();
    const stopped = this.onRevoked?.();
    await this.update(() => this.save(() => ({ allowAll: false, sites: {} })), stopped);
  }
  async update(save, stopped) {
    this.updating = (this.updating ?? 0) + 1;
    try {
      await Promise.all([save(), stopped]);
      this.policyError = null;
    } catch (error) {
      this.policyError = `Website access could not be updated: ${error.message}. Retry resetting website access.`;
      throw error;
    } finally {
      this.updating--;
    }
  }
  status() {
    return {
      ...this.policy,
      pending: [...this.pending.values()].map(({ id, host }) => ({ id, host })),
    };
  }
}
