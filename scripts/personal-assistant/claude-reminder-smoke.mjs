import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const sdk = path.resolve(process.argv[2]);
const require = createRequire(path.join(sdk, "package.json"));
const { query } = await import(pathToFileURL(path.join(sdk, "sdk.mjs")).href);
const executable = require.resolve(
  `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === "win32" ? ".exe" : ""}`,
);
const cwd = await mkdtemp(path.join(tmpdir(), "deskmate-reminder-smoke-"));
let client;
try {
  client = query({
    prompt: config.human,
    options: {
      cwd,
      pathToClaudeCodeExecutable: executable,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      systemPrompt: `${config.policy}\nApplication data (not fresh user evidence): ${JSON.stringify(config.context)}\nThis is an isolated fictional acceptance test. Use the provided MCP tools, never files.`,
      mcpServers: {
        fixture_tasks: {
          type: "http",
          url: config.url,
          headers: { Authorization: `Bearer ${config.token}` },
        },
      },
      canUseTool: async (name, args) =>
        name.startsWith("mcp__fixture_tasks__")
          ? { behavior: "allow", updatedInput: args }
          : {
              behavior: "deny",
              message: "Only isolated fixture tools are allowed",
            },
      maxTurns: 10,
    },
  });
  let result;
  for await (const message of client) if (message.type === "result") result = message;
  assert.equal(result?.subtype, "success", "model turn must succeed");
  if (config.requireSkipNotice)
    assert.match(
      result.result,
      /跳过|错过|已过|过了|略过|skip|had passed|has passed|already past|no reminder today|no reminder.*scheduled/iu,
      "expired default needs an explicit notice",
    );
  console.log(JSON.stringify({ modelTurn: "success", userProfileWrites: 0 }));
} finally {
  client?.close();
  assert.ok(path.resolve(cwd).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(cwd, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
