import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// Only the SDK control channel is used. No prompt is yielded and no model turn
// or browser action is requested. Connection tokens stay in this private pipe.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const expectedTools = config.expectedTools ?? {
  fixed: ["browser_repl", "browser_reset", "browser_start", "browser_status"],
  missing_metadata: [],
};
const names = Object.keys(expectedTools);
const sdkDirectory = path.resolve(process.argv[2]);
const require = createRequire(path.join(sdkDirectory, "package.json"));
const { query } = await import(pathToFileURL(path.join(sdkDirectory, "sdk.mjs")).href);
const executable = require.resolve(
  `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === "win32" ? ".exe" : ""}`,
);
const directory = await mkdtemp(path.join(tmpdir(), "atlas-claude-discovery-"));
let release;
const waiting = new Promise((resolve) => {
  release = resolve;
});
async function* noPrompt() {
  await waiting;
  yield* [];
}
let client, timer;
try {
  client = query({
    prompt: noPrompt(),
    options: {
      cwd: directory,
      pathToClaudeCodeExecutable: executable,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      mcpServers: Object.fromEntries(
        names.map((name) => [
          name,
          {
            type: "http",
            url: config[name],
            headers: { Authorization: `Bearer ${config.token}` },
          },
        ]),
      ),
    },
  });
  const status = await Promise.race([
    (async () => {
      const deadline = Date.now() + 35_000;
      while (Date.now() < deadline) {
        const servers = await client.mcpServerStatus();
        if (
          names.every((name) => {
            const server = servers.find((item) => item.name === name);
            return server && server.status !== "pending";
          })
        )
          return servers;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("Claude did not finish MCP discovery");
    })(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Claude discovery timed out")), 45_000);
    }),
  ]);
  const result = names.map((name) => {
    const server = status.find((item) => item.name === name);
    const tools = (server?.tools ?? []).map((tool) => tool.name).sort();
    if (expectedTools[name].length) assert.equal(server?.status, "connected");
    assert.deepEqual(tools, [...expectedTools[name]].sort(), name);
    return { name, status: server?.status, tools };
  });
  console.log(JSON.stringify({ servers: result, modelTurns: 0 }));
} finally {
  clearTimeout(timer);
  release();
  client?.close();
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  // close() terminates the CLI asynchronously; Windows may briefly hold cwd.
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
