// Deterministic stand-in for a real coding agent, used to test the eval harness
// itself (fixture + call log + assertions) without an API key or a CLI. It does
// exactly what a graph-aware agent should: connect to the MCP server, call
// check_files BEFORE editing, apply the fix, then record a Regression node.
//
//   node scripts/eval/mock_agent.mjs <fixture_dir>
//
// The MCP SDK lives in mcp/node_modules; ESM resolves bare specifiers from this
// file's directory, not cwd, so we resolve it explicitly against mcp/.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const fix = resolve(process.argv[2] ?? "");
if (!fix) { console.error("usage: mock_agent.mjs <fixture_dir>"); process.exit(2); }

const repoMcp = fileURLToPath(new URL("../../mcp/", import.meta.url));
const serverDist = join(repoMcp, "dist", "index.js");

// Resolve the SDK from mcp/node_modules regardless of where node was launched.
const requireFromMcp = createRequire(join(repoMcp, "package.json"));
const { Client } = await import(pathToFileURL(requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js")));
const { StdioClientTransport } = await import(pathToFileURL(requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js")));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverDist],
  env: {
    ...process.env,
    SIMPLEGRAPH_ROOT: join(fix, "core"),
    SIMPLEGRAPH_CALL_LOG: join(fix, ".sg_calls.log"),
  },
  stderr: "ignore",
});

const client = new Client({ name: "mock-agent", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

// 1. Consult the graph before touching the file (the behavior the eval asserts).
await client.callTool({ name: "simplegraph_check_files", arguments: { files: ["src/config.ts"] } });

// 2. Apply the fix the task asked for.
const cfgPath = join(fix, "src", "config.ts");
writeFileSync(cfgPath, readFileSync(cfgPath, "utf-8").replace(/retryLimit:\s*0/, "retryLimit: 3"));

// 3. Record what happened as a graph node.
await client.callTool({
  name: "simplegraph_add_node",
  arguments: {
    type: "Regression",
    id: "REG_ZERO_RETRY",
    label: "Zero retryLimit disables retries",
    summary: "retryLimit was 0 in src/config.ts, so transient failures never retried. Set it to 3.",
    priority: "HIGH",
    tags: ["network", "retry"],
    files: ["src/config.ts"],
    author: "mock-agent",
  },
});

await client.close();
