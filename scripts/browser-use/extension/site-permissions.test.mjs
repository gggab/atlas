import assert from "node:assert/strict";
import { test } from "node:test";
import { SitePermissions } from "./site-permissions.js";

function fixture(local = {}) {
  let removed;
  const windows = [];
  const api = {
    extension: { isAllowedFileSchemeAccess: async () => false },
    storage: { local: { get: async () => local, set: async (v) => Object.assign(local, v) } },
    runtime: { getURL: (p) => `chrome-extension://fixture/${p}` },
    windows: {
      create: async (v) => {
        windows.push(v);
        return { id: 10 };
      },
      remove: async () => {},
      onRemoved: {
        addListener: (fn) => {
          removed = fn;
        },
      },
    },
  };
  const permissions = new SitePermissions(api);
  return { permissions, local, windows, close: () => removed(10) };
}

test("fresh and legacy consent installations ask per hostname before access", async () => {
  const { permissions: p, windows } = fixture({ browserDataConsent: 1 });
  await p.restore();
  p.begin();
  const access = p.authorize("https://example.com/private?secret=hidden");
  await new Promise((r) => setImmediate(r));
  assert.equal(p.status().allowAll, false);
  assert.equal(p.status().pending[0].host, "example.com");
  assert.equal(JSON.stringify(p.status()).includes("secret"), false);
  assert.equal(windows.length, 1);
  await p.respond(p.status().pending[0].id, "allow_once");
  await access;
  await p.authorize("http://example.com/other");
  p.end();
  p.begin();
  const again = p.authorize("https://example.com");
  const rejected = assert.rejects(again, /cancelled/i);
  p.end();
  await rejected;
});

test("local files use the browser switch independently of website allow-all", async () => {
  const { permissions: p, windows } = fixture();
  p.begin();
  p.policy.allowAll = true;
  await assert.rejects(p.authorize("file:///C:/fixture/page.html"), /Allow access to file URLs/);
  await assert.rejects(p.authorizeFiles(), /Allow access to file URLs/);
  p.api.extension.isAllowedFileSchemeAccess = async () => true;
  await p.authorize("file:///C:/fixture/page.html");
  await p.authorizeFiles();
  assert.equal(windows.length, 0);
  assert.deepEqual(p.status().sites, {});
  p.api.extension.isAllowedFileSchemeAccess = async () => false;
  await assert.rejects(p.authorize("file:///C:/fixture/page.html"), /Allow access to file URLs/);
  for (const url of ["chrome://settings", "javascript:alert(1)", "data:text/html,fixture"])
    await assert.rejects(p.authorize(url), /Only HTTP\(S\)/);
  p.end();
});

test("ending a task while checking file access cannot authorize a stale operation", async () => {
  const { permissions: p } = fixture();
  p.api.extension.isAllowedFileSchemeAccess = async () => {
    p.end();
    return true;
  };
  p.begin();
  await assert.rejects(p.authorize("file:///C:/fixture/page.html"), /cancelled/);
});

test("site decisions survive restart, subdomains ask separately, and deny overrides allow-all", async () => {
  const { permissions: p, local } = fixture();
  await p.restore();
  p.begin();
  const access = p.authorize("https://EXAMPLE.com");
  await p.respond(p.status().pending[0].id, "allow_site");
  await access;
  const q = fixture(local).permissions;
  await q.restore();
  q.begin();
  await q.authorize("https://example.com");
  const subdomain = q.authorize("https://private.example.com");
  const denied = assert.rejects(subdomain, /not allowed/i);
  await q.respond(q.status().pending[0].id, "deny");
  await denied;
  const other = q.authorize("https://other.example");
  await q.respond(q.status().pending[0].id, "allow_all");
  await other;
  await q.authorize("https://new.example");
  await assert.rejects(q.authorize("https://private.example.com"), /not allowed/i);
  q.end();
  p.end();
});

test("closing prompts and task teardown cannot grant access; stale decisions are rejected", async () => {
  const { permissions: p, close } = fixture();
  await p.restore();
  p.begin();
  const access = p.authorize("https://example.com");
  const rejected = assert.rejects(access, /cancelled/i);
  await new Promise((r) => setImmediate(r));
  const id = p.status().pending[0].id;
  close();
  await rejected;
  await assert.rejects(p.respond(id, "allow_all"), /no longer/i);
  assert.equal(p.status().allowAll, false);
  p.end();
});

test("revocation cancels waiting access and stops control before storage completes", async () => {
  const { permissions: p } = fixture();
  await p.restore();
  p.begin();
  let stopped = false,
    save;
  p.onRevoked = async () => {
    stopped = true;
  };
  p.api.storage.local.set = () =>
    new Promise((r) => {
      save = r;
    });
  const access = p.authorize("https://example.com");
  const rejected = assert.rejects(access, /cancelled/i);
  const update = p.reset();
  assert.equal(stopped, true);
  await rejected;
  await new Promise((r) => setImmediate(r));
  save();
  await update;
  assert.equal(p.status().allowAll, false);
});

test("simultaneous decisions preserve both sites and a later reset wins over a pending grant", async () => {
  const { permissions: p, local } = fixture();
  await p.restore();
  p.begin();
  const first = p.authorize("https://first.example"),
    second = p.authorize("https://second.example");
  const requests = p.status().pending;
  await Promise.all(requests.map((r) => p.respond(r.id, "allow_site")));
  await Promise.all([first, second]);
  assert.deepEqual(local.websiteAccess.sites, {
    "first.example": "allow",
    "second.example": "allow",
  });
  let finish;
  p.api.storage.local.set = (value) =>
    value.allowAll === true || value.websiteAccess.allowAll === true
      ? new Promise((r) => {
          finish = () => {
            Object.assign(local, value);
            r();
          };
        })
      : Promise.resolve(Object.assign(local, value));
  const next = p.authorize("https://new.example");
  const rejected = assert.rejects(next, /cancelled/);
  const grant = p.respond(p.status().pending[0].id, "allow_all");
  const stale = assert.rejects(grant, /no longer/);
  const reset = p.reset();
  finish();
  await Promise.all([reset, rejected, stale]);
  assert.equal(local.websiteAccess.allowAll, false);
  assert.deepEqual(local.websiteAccess.sites, {});
});

test("failed permission persistence is visible and does not allow new page access", async () => {
  const { permissions: p } = fixture();
  await p.restore();
  p.begin();
  p.api.storage.local.set = async () => {
    throw new Error("Storage unavailable");
  };
  await assert.rejects(p.reset(), /Storage unavailable/);
  p.begin();
  await assert.rejects(p.authorize("https://example.com"), /could not be updated/);
  p.end();
});
