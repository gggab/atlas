import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { BrowserRuntime } from "./runtime.mjs";

function fixture({ href } = {}) {
  const calls = [];
  const navigations = [];
  let currentUrl = "http://localhost/example";
  let allowed = true;
  const page = {
    url: () => currentUrl,
    goto: async (url) => {
      navigations.push(url);
      currentUrl = url;
    },
    title: async () => "Example",
    on: () => {},
    context: () => ({
      newCDPSession: async () => ({
        send: async () => ({
          nodes: [{ backendDOMNodeId: 1, role: { value: "button" }, name: { value: "Save" } }],
        }),
        detach: async () => {},
      }),
    }),
    locator: (selector) => ({
      click: async () => calls.push(selector),
      innerText: async () => "Saved",
      ariaSnapshot: async () => '- button "Save"',
      getAttribute: async (name) => (name === "href" ? href : null),
    }),
    getByRole: () => page.locator("a"),
    frames: () => [page],
  };
  const backend = async (method, args) => {
    if (method === "list") return [{ id: "t1", title: "Example", url: page.url() }];
    if (method === "authorize") {
      if (!allowed) throw new Error("Browser control paused");
      return { id: args.id };
    }
    throw new Error(`Unexpected method ${method}`);
  };
  const runtime = new BrowserRuntime({ backend, resolvePage: async () => page });
  return {
    runtime,
    calls,
    navigations,
    pause: () => {
      allowed = false;
    },
  };
}

test("top-level await and handles persist across calls", async () => {
  const { runtime, calls } = fixture();
  try {
    await runtime.execute('let tab = await cua.getTab("t1"); let count = 2;');
    const result = await runtime.execute(
      'await tab.playwright.locator("button").click(); nodeRepl.write(++count);',
    );
    assert.equal(result.isError, false);
    assert.equal(result.content.at(-1).text, "3");
    assert.deepEqual(calls, ["button"]);
  } finally {
    await runtime.close();
  }
});

test("the documented link workflow preserves full addresses and resolves relative links without scheme concatenation", async () => {
  const instructions = await readFile(
    new URL("../../src-tauri/resources/browser-use-instructions.md", import.meta.url),
    "utf8",
  );
  const example = [...instructions.matchAll(/```js\r?\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .find((code) => code.includes('getAttribute("href")'));
  assert.ok(example, "Ship an executable link-navigation example with the browser instructions");
  const query = "?tracking=" + "x".repeat(200) + "&priceTId=tail-value&spm=a%2Bb";
  for (const [href, expected] of [
    ["https://shop.example/detail" + query, "https://shop.example/detail" + query],
    ["http://shop.example/detail" + query, "http://shop.example/detail" + query],
    ["//ads.example/redirect" + query, "http://ads.example/redirect" + query],
    ["../detail" + query, "http://localhost/detail" + query],
    [null, /no href/i],
    ["javascript:alert(1)", /HTTP\(S\)/i],
  ]) {
    const { runtime, navigations } = fixture({ href });
    try {
      await runtime.execute("let tab = await browser.tabs.selected();");
      const result = await runtime.execute(example);
      if (expected instanceof RegExp) {
        assert.equal(result.isError, true);
        assert.match(result.content.at(-1).text, expected);
        assert.deepEqual(navigations, []);
      } else {
        assert.equal(result.isError, false, JSON.stringify(result.content));
        assert.deepEqual(navigations, [expected]);
        assert.ok(result.content.some((item) => item.text === expected));
      }
    } finally {
      await runtime.close();
    }
  }
});

test("an existing locator checks current authorization before input", async () => {
  const { runtime, calls, pause } = fixture();
  try {
    await runtime.execute(
      'let tab = await cua.getTab("t1"); let button = tab.playwright.locator("button");',
    );
    pause();
    const result = await runtime.execute("await button.click();");
    assert.equal(result.isError, true);
    assert.match(result.content.at(-1).text, /paused/);
    assert.deepEqual(calls, []);
  } finally {
    await runtime.close();
  }
});

test("independent runtimes never share variables", async () => {
  const a = fixture().runtime;
  const b = fixture().runtime;
  try {
    await a.execute("let privateValue = 42;");
    const result = await b.execute("nodeRepl.write(typeof privateValue);");
    assert.equal(result.content.at(-1).text, "undefined");
  } finally {
    await a.close();
    await b.close();
  }
});

test("images become MCP image content and code errors retain emitted evidence", async () => {
  const { runtime } = fixture();
  try {
    const result = await runtime.execute(
      'await nodeRepl.emitImage(Buffer.from([1,2,3])); throw new Error("failed after image");',
    );
    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, "image");
    assert.equal(result.content[0].data, "AQID");
    assert.match(result.content.at(-1).text, /failed after image/);
  } finally {
    await runtime.close();
  }
});

test("browser discovery does not navigate and unknown browsers fail explicitly", async () => {
  const { runtime, calls } = fixture();
  try {
    const result = await runtime.execute("nodeRepl.write(await cua.listTabs());");
    assert.equal(result.isError, false);
    assert.match(result.content.at(-1).text, /Example/);
    assert.deepEqual(calls, []);
    const unknown = await runtime.execute('await cua.getBrowser({id:"chrome"});');
    assert.equal(unknown.isError, true);
    assert.match(unknown.content.at(-1).text, /not connected/);
  } finally {
    await runtime.close();
  }
});
