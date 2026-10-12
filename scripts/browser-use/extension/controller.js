export function validateEndpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/extension\/[a-f0-9]{64}$/.test(url.pathname)
  )
    throw new Error("Paste the local connection address from Atlas Browser controls.");
  return url.href;
}

export class ExtensionController {
  constructor(api, Socket = WebSocket, permissions) {
    this.api = api;
    this.Socket = Socket;
    this.targets = new Map();
    this.records = new Map();
    this.sessions = new Map();
    this.creating = new Set();
    this.childSessions = new Map();
    this.frames = new Map();
    this.generation = 0;
    this.permissions = permissions;
    this.checks = new Set();
    api.debugger.onEvent.addListener((source, method, params) => {
      const target = this.targets.get(source.tabId);
      if (!target) return;
      const generation = this.generation;
      const check = this.event(source, method, params, target, generation);
      this.checks.add(check);
      void check
        .catch((error) => {
          if (generation !== this.generation) return;
          this.accessError = error.message;
          void this.disconnect({ takeover: true, tabId: source.tabId }).catch((failure) => {
            this.lastError = failure.message;
          });
        })
        .finally(() => {
          this.checks.delete(check);
        });
    });
    api.debugger.onDetach.addListener((source, reason) => {
      const target = this.targets.get(source.tabId);
      if (!target) return;
      this.targets.delete(source.tabId);
      if (reason === "target_closed") this.records.delete(source.tabId);
      this.send({ type: "detached", targetId: target.targetId });
      void this.persist();
      if (reason === "canceled_by_user")
        void this.disconnect({ takeover: true, tabId: source.tabId }).catch((error) => {
          this.lastError = error.message;
        });
    });
  }
  async authorize(url, generation = this.generation) {
    if (!this.permissions) throw new Error("Website authorization is unavailable");
    await this.permissions.authorize(url);
    if (generation !== this.generation) throw new Error("Connection was cancelled");
  }
  async inspect(source, generation) {
    const { frameTree } = await this.api.debugger.sendCommand(source, "Page.getFrameTree");
    const visit = async (tree) => {
      if (!tree) return;
      await this.authorize(tree.frame.url, generation);
      for (const child of tree.childFrames ?? []) await visit(child);
    };
    await visit(frameTree);
  }
  async intercept(source) {
    await this.api.debugger.sendCommand(source, "Fetch.enable", {
      patterns: [{ resourceType: "Document", requestStage: "Request" }],
    });
    await this.api.debugger.sendCommand(source, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }, { exclude: true }],
    });
  }
  async event(source, method, params, target, generation) {
    if (method === "Fetch.requestPaused") {
      try {
        await this.authorize(params.request.url, generation);
        await this.api.debugger.sendCommand(source, "Fetch.continueRequest", {
          requestId: params.requestId,
        });
      } catch (error) {
        if (generation === this.generation)
          await this.api.debugger.sendCommand(source, "Fetch.failRequest", {
            requestId: params.requestId,
            errorReason: "BlockedByClient",
          });
        throw error;
      }
      return;
    }
    if (method.startsWith("Fetch.")) return;
    if (method.startsWith("Target.target")) return;
    if (method === "Target.attachedToTarget") {
      if (params.targetInfo.type !== "iframe") return;
      const child = { tabId: source.tabId, sessionId: params.sessionId };
      await this.authorize(params.targetInfo.url || "about:blank", generation);
      await this.intercept(child);
      await this.inspect(child, generation);
      this.childSessions.set(params.sessionId, source.tabId);
      this.frames.set(params.sessionId, { source, params });
    }
    if (method === "Page.frameNavigated") await this.authorize(params.frame.url, generation);
    if (method === "Network.requestWillBeSent" && params.type === "Document")
      await this.authorize(params.request.url, generation);
    if (method === "Target.detachedFromTarget") {
      this.childSessions.delete(params.sessionId);
      this.frames.delete(params.sessionId);
    }
    if (source.sessionId && !this.childSessions.has(source.sessionId)) return;
    if (generation !== this.generation || target.targetId === "pending") return;
    this.send({
      type: "event",
      targetId: target.targetId,
      sessionId: source.sessionId,
      method,
      params,
    });
  }
  send(message) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }
  async persist() {
    await this.api.storage.session.set({
      atlasTabs: [...this.targets.keys()],
      atlasTask: {
        tabs: [...this.records.values()],
        groupId: this.groupId,
        sessionId: this.sessionId,
      },
      atlasSessions: [...this.sessions.values()],
    });
  }
  async recover() {
    const {
      atlasTabs = [],
      atlasTask,
      atlasSessions = [],
    } = await this.api.storage.session.get(["atlasTabs", "atlasTask", "atlasSessions"]);
    this.sessions = new Map(atlasSessions.map((session) => [session.sessionId, session]));
    this.sessionId = atlasTask?.sessionId;
    const identities = atlasTask?.tabs?.length ? await this.api.debugger.getTargets() : [];
    for (const record of atlasTask?.tabs ?? []) {
      // Session storage and target identity prevent closing a reused tab ID.
      if (
        identities.some((target) => target.tabId === record.tabId && target.id === record.targetId)
      )
        this.records.set(record.tabId, record);
    }
    this.groupId = this.records.size > 0 ? atlasTask?.groupId : undefined;
    this.handoffTabs = new Set(
      [...this.records.values()]
        .filter((record) => record.disposition === "handoff")
        .map((record) => record.tabId),
    );
    await this.release(atlasTabs);
    await this.cleanTabs();
  }
  async release(tabs) {
    const results = await Promise.allSettled(
      tabs.map((tabId) => this.api.debugger.detach({ tabId })),
    );
    const failed = tabs.filter(
      (_, i) =>
        results[i].status === "rejected" &&
        !/not attached|No tab with given id|No target with given id|Target closed/i.test(
          results[i].reason?.message ?? "",
        ),
    );
    await this.api.storage.session.set({ atlasTabs: failed });
    if (failed.length) {
      for (const tabId of failed) this.targets.set(tabId, { targetId: "pending" });
      await this.api.action.setBadgeText({ text: "!" });
      throw new Error(
        "Could not release browser debugging. Reload Atlas Browser in Extensions before continuing.",
      );
    }
    this.lastError = null;
  }
  async attach(tabId, generation, allowBlank = false) {
    const tab = await this.api.tabs.get(tabId);
    // Chrome may expose only pendingUrl immediately after an owned tab is created.
    const url = tab.url || (allowBlank ? tab.pendingUrl : "");
    if (!/^https?:\/\//.test(url ?? "") && !(allowBlank && url === "about:blank"))
      throw new Error("Select an HTTP(S) web page before sharing it.");
    await this.authorize(url, generation);
    if (generation !== this.generation) throw new Error("Connection was cancelled");
    await this.api.debugger.attach({ tabId }, "1.3");
    if (generation !== this.generation) {
      await this.release([tabId]);
      throw new Error("Connection was cancelled");
    }
    // Record immediately so startup recovery also covers a failed handshake.
    this.targets.set(tabId, { targetId: "pending" });
    await this.persist();
    await this.intercept({ tabId });
    await this.inspect({ tabId }, generation);
    while (this.checks.size) await Promise.all(this.checks);
    const { targetInfo } = await this.api.debugger.sendCommand({ tabId }, "Target.getTargetInfo");
    await this.authorize(targetInfo.url || "about:blank", generation);
    if (generation !== this.generation) throw new Error("Connection was cancelled");
    this.targets.set(tabId, targetInfo);
    this.records.set(tabId, { ...this.records.get(tabId), tabId, targetId: targetInfo.targetId });
    await this.persist();
    return { ...targetInfo, atlasDisposition: this.records.get(tabId).disposition };
  }
  async createTab(value = "about:blank") {
    const generation = this.generation;
    const previous = [...this.creating];
    const work = (async () => {
      // Serialize group creation even when a caller opens several pages concurrently.
      await Promise.allSettled(previous);
      if (generation !== this.generation) throw new Error("Connection was cancelled");
      const url = new URL(value);
      if (
        !["http:", "https:", "about:"].includes(url.protocol) ||
        (url.protocol === "about:" && url.href !== "about:blank") ||
        url.username ||
        url.password
      )
        throw new Error("Only HTTP(S) or blank tabs may be created");
      await this.authorize(url.href, generation);
      const tab = await this.api.tabs.create({
        url: url.href,
        ...(this.windowId !== undefined ? { windowId: this.windowId } : {}),
      });
      this.windowId = tab.windowId;
      this.records.set(tab.id, { tabId: tab.id, owned: true, disposition: "temporary" });
      await this.persist();
      const targetInfo = await this.attach(tab.id, generation, true);
      this.groupId = await this.api.tabs.group({
        tabIds: tab.id,
        ...(this.groupId !== undefined ? { groupId: this.groupId } : {}),
      });
      await this.api.tabGroups.update(this.groupId, {
        title: `Atlas · ${this.title || "Agent working"}`.slice(0, 100),
        color: "blue",
        collapsed: false,
      });
      await this.persist();
      return targetInfo;
    })();
    this.creating.add(work);
    try {
      return await work;
    } finally {
      this.creating.delete(work);
    }
  }
  async mark(targetId, disposition) {
    if (!["temporary", "keep", "deliverable", "handoff"].includes(disposition))
      throw new Error("Invalid tab disposition");
    const record = [...this.records.values()].find((record) => record.targetId === targetId);
    if (!record || !this.targets.has(record.tabId)) throw new Error("Target is not shared");
    record.disposition = disposition;
    await this.persist();
  }
  async cleanTabs() {
    const failures = [];
    const hadRecords = this.records.size > 0;
    const handoff = [...this.records.values()].filter((record) => record.disposition === "handoff");
    const retained = [];
    for (const [tabId, record] of this.records) {
      if (record.owned && (record.disposition ?? "temporary") === "temporary") {
        try {
          await this.api.tabs.remove(tabId);
        } catch (error) {
          if (!/No tab with given id|No target with given id|Target closed/i.test(error.message)) {
            failures.push(error);
            continue;
          }
        }
      }
      if (
        record.disposition !== "handoff" &&
        (!record.owned || (record.disposition ?? "temporary") !== "temporary")
      )
        retained.push(record);
      this.records.delete(tabId);
    }
    if (hadRecords) {
      await this.api.storage.session.set({
        atlasHandoff: {
          tabs: handoff,
          groupId: this.groupId,
          sessionId: this.sessionId,
          ready: false,
        },
      });
      this.onHandoff?.(handoff.length ? this.sessionId : null);
    }
    let groupId = this.groupId;
    if (groupId !== undefined) {
      try {
        const tabs = await this.api.tabs.query({ groupId });
        if (!tabs.length) groupId = undefined;
        const handoff = tabs.filter((tab) => this.handoffTabs?.has(tab.id));
        if (handoff.length)
          await this.api.tabGroups.update(this.groupId, {
            title: "Atlas · Waiting for handoff",
            color: "orange",
          });
      } catch (error) {
        if (!/No group with id|No tab group with id/i.test(error.message)) failures.push(error);
        else groupId = undefined;
      }
    }
    if (hadRecords && this.sessionId) {
      if (retained.length || groupId !== undefined)
        this.sessions.set(this.sessionId, { sessionId: this.sessionId, groupId, tabs: retained });
      else this.sessions.delete(this.sessionId);
    }
    if (!failures.length) this.groupId = undefined;
    await this.persist();
    if (failures.length) throw new Error(`Task page cleanup failed: ${failures[0].message}`);
  }
  async connect(endpoint, tabId, title = "Agent working", sessionId = "manual") {
    if (this.lastError) throw new Error(this.lastError);
    this.accessError = null;
    if (this.socket || this.disconnecting)
      throw new Error("Disconnect the current Atlas session before connecting another.");
    endpoint = validateEndpoint(endpoint);
    const generation = ++this.generation;
    this.permissions?.begin();
    this.title = String(title).slice(0, 100);
    this.sessionId = sessionId;
    this.groupId = undefined;
    let resume;
    const { atlasHandoff, atlasSessions = [] } = await this.api.storage.session.get([
      "atlasHandoff",
      "atlasSessions",
    ]);
    this.sessions = new Map(atlasSessions.map((session) => [session.sessionId, session]));
    if (atlasHandoff?.tabs?.length && atlasHandoff.sessionId !== sessionId)
      throw new Error(
        "Another session is waiting for handoff. Resume that session or release its waiting pages in Atlas Browser first.",
      );
    if (atlasHandoff?.tabs?.length && !atlasHandoff.ready)
      throw new Error(
        "Waiting for user takeover. After verification, send continue in the original Atlas chat.",
      );
    const session = this.sessions.get(sessionId);
    const candidates = [
      ...(atlasHandoff?.tabs ?? []).map((record) => ({ ...record, disposition: "temporary" })),
      ...(session?.tabs ?? []),
    ];
    // Group membership never grants access; validate only this session's recorded targets.
    const identities = candidates.length ? await this.api.debugger.getTargets() : [];
    resume = candidates.filter((record) =>
      identities.some((target) => target.tabId === record.tabId && target.id === record.targetId),
    );
    for (const record of resume) this.records.set(record.tabId, record);
    this.groupId =
      session?.groupId ?? (atlasHandoff?.tabs?.length ? atlasHandoff.groupId : undefined);
    if (this.groupId !== undefined) {
      const grouped = await this.api.tabs.query({ groupId: this.groupId });
      if (!grouped.some((tab) => resume.some((record) => record.tabId === tab.id)))
        this.groupId = undefined;
    }
    tabId ??= resume[0]?.tabId;
    resume = resume.filter((record) => record.tabId !== tabId);
    this.windowId = tabId === undefined ? undefined : (await this.api.tabs.get(tabId)).windowId;
    if (generation !== this.generation) throw new Error("Connection was cancelled");
    this.socket = new this.Socket(endpoint);
    this.socket.onclose = () => {
      void this.disconnect().catch((error) => {
        this.lastError = error.message;
      });
    };
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Atlas connection timed out. Prepare a new connection in Atlas.")),
          10_000,
        );
        this.socket.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        this.socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("Cannot connect to Atlas. Prepare a new connection in Atlas."));
        };
      });
      const targetInfo =
        tabId === undefined
          ? await this.createTab()
          : await this.attach(tabId, generation, this.records.has(tabId));
      const others = [];
      for (const record of resume) others.push(await this.attach(record.tabId, generation, true));
      this.socket.onmessage = (event) => {
        try {
          void this.handle(JSON.parse(event.data));
        } catch {
          void this.disconnect().catch((error) => {
            this.lastError = error.message;
          });
        }
      };
      this.send({ type: "ready", targetInfo, userAgent: globalThis.navigator?.userAgent });
      for (const targetInfo of others) this.send({ type: "attached", targetInfo });
      if (atlasHandoff?.tabs?.length) {
        await this.api.storage.session.set({ atlasHandoff: null });
        this.onHandoff?.(null);
      }
      const owned = [...this.records.values()].filter((record) => record.owned);
      if (owned.length) {
        this.groupId = await this.api.tabs.group({
          tabIds: owned.map((record) => record.tabId),
          ...(this.groupId !== undefined ? { groupId: this.groupId } : {}),
        });
        await this.api.tabGroups.update(this.groupId, {
          title: `Atlas · ${this.title}`.slice(0, 100),
          color: "blue",
          collapsed: false,
        });
        await this.persist();
      }
      this.heartbeat = setInterval(() => this.send({ type: "ping" }), 20_000);
      await this.api.action.setBadgeText({ text: "ON" });
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }
  async handle({ id, method, params }) {
    try {
      let result;
      if (method === "cdp") {
        const entry = [...this.targets].find(([, target]) => target.targetId === params.targetId);
        if (!entry || (params.sessionId && this.childSessions.get(params.sessionId) !== entry[0]))
          throw new Error("Target is not shared");
        if (
          params.method === "Target.getTargetInfo" &&
          params.params?.targetId &&
          params.params.targetId !== params.targetId
        )
          throw new Error("Target is not shared");
        if (
          !/^(Accessibility|Animation|Audits|CSS|DOM|DOMSnapshot|Emulation|Fetch|Input|Inspector|Log|Network|Overlay|Page|Performance|Runtime|Security|Target)\./.test(
            params.method,
          ) ||
          [
            "Page.close",
            "Target.createTarget",
            "Target.closeTarget",
            "Target.attachToTarget",
            "Target.detachFromTarget",
            "Target.getTargets",
            "Target.setDiscoverTargets",
            "Network.setRequestInterception",
            "Network.getAllCookies",
            "Network.getCookies",
            "Network.setCookie",
            "Network.setCookies",
            "Network.deleteCookies",
            "Network.clearBrowserCookies",
          ].includes(params.method) ||
          params.method.startsWith("Fetch.")
        )
          throw new Error("Command exceeds shared tab access");
        const generation = this.generation;
        await Promise.all(this.checks);
        const tab = await this.api.tabs.get(entry[0]);
        await this.authorize(tab.url || tab.pendingUrl || "about:blank", generation);
        const source = {
          tabId: entry[0],
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        };
        await this.inspect(source, generation);
        if (params.method === "Page.navigate") await this.authorize(params.params.url, generation);
        if (generation !== this.generation || !this.targets.has(entry[0]))
          throw new Error("Connection was cancelled");
        if (params.method === "Target.setAutoAttach") {
          // Keep extension-owned interception attached; replay approved frames to the client.
          if (params.params.autoAttach)
            for (const { source: parent, params: child } of this.frames.values()) {
              if (parent.tabId === entry[0] && parent.sessionId === params.sessionId)
                this.send({
                  type: "event",
                  targetId: params.targetId,
                  sessionId: parent.sessionId,
                  method: "Target.attachedToTarget",
                  params: child,
                });
            }
          result = {};
        } else result = await this.api.debugger.sendCommand(source, params.method, params.params);
      } else if (method === "create") {
        const targetInfo = await this.createTab(params.url);
        this.send({ type: "attached", targetInfo });
        result = { targetId: targetInfo.targetId };
      } else if (method === "mark") {
        await this.mark(params.targetId, params.disposition);
      } else if (method === "cleanup") {
        await this.disconnect({ replyId: id });
        return;
      } else throw new Error("Unsupported extension operation");
      this.send({ id, result: result ?? {} });
    } catch (error) {
      this.send({ id, error: error.message });
    }
  }
  async discardHandoff() {
    if (this.socket || this.disconnecting) throw new Error("Take over the current task first");
    const { atlasHandoff } = await this.api.storage.session.get("atlasHandoff");
    const targets = await this.api.debugger.getTargets();
    const matching = (atlasHandoff?.tabs ?? []).filter((record) =>
      targets.some((target) => target.tabId === record.tabId && target.id === record.targetId),
    );
    const owned = matching.filter((record) => record.owned);
    for (const record of owned) await this.api.tabs.remove(record.tabId);
    if (matching.length && atlasHandoff.groupId !== undefined) {
      const tabs = await this.api.tabs.query({ groupId: atlasHandoff.groupId });
      if (tabs.length)
        await this.api.tabGroups.update(atlasHandoff.groupId, {
          title: "Atlas · Retained pages",
          color: "blue",
        });
    }
    await this.api.storage.session.set({ atlasHandoff: null });
    this.onHandoff?.(null);
  }
  async allowResume(sessionId, ready = true) {
    if (this.disconnecting) await this.disconnecting;
    if (this.socket) return false;
    const { atlasHandoff } = await this.api.storage.session.get("atlasHandoff");
    if (!atlasHandoff?.tabs?.length || atlasHandoff.sessionId !== sessionId) return false;
    await this.api.storage.session.set({ atlasHandoff: { ...atlasHandoff, ready } });
    return true;
  }
  async disconnect({ takeover = false, tabId, replyId } = {}) {
    if (this.disconnecting) return this.disconnecting;
    ++this.generation;
    this.permissions?.end();
    const socket = this.socket;
    this.socket = null;
    clearInterval(this.heartbeat);
    if (socket) {
      socket.onclose = null;
    }
    const tabs = [...this.targets.keys()];
    this.targets.clear();
    this.childSessions.clear();
    this.frames.clear();
    this.disconnecting = (async () => {
      await Promise.allSettled(this.creating);
      if (takeover) {
        const needed =
          tabId === undefined
            ? [...this.records.values()].find((record) => record.owned)
            : this.records.get(tabId);
        if (needed) needed.disposition = "handoff";
      }
      this.handoffTabs = new Set(
        [...this.records.values()]
          .filter((record) => record.disposition === "handoff")
          .map((record) => record.tabId),
      );
      try {
        await this.release(tabs);
        await this.cleanTabs();
        await this.api.action.setBadgeText({ text: "" });
        if (replyId && socket?.readyState === 1)
          socket.send(JSON.stringify({ id: replyId, result: {} }));
      } catch (error) {
        this.lastError = error.message;
        if (replyId && socket?.readyState === 1)
          socket.send(JSON.stringify({ id: replyId, error: error.message }));
        throw error;
      } finally {
        socket?.close();
      }
    })();
    try {
      await this.disconnecting;
    } finally {
      this.disconnecting = null;
    }
  }
}
