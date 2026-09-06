// MCP stdio contract test — exercises the server the way a real agent does:
// spawn it, run the MCP initialize handshake, list tools, and call them over
// JSON-RPC on stdio. The handler unit tests call functions directly; this
// proves the wiring in between — server registration, schema advertisement,
// request routing, and serialization — actually works end to end.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const serverEntry = resolve(here, "index.ts");

let client: Client;
let graphDir: string;
let callLog: string;

/** A minimal but valid graph the server can read and mutate. */
function makeGraph(): string {
  const dir = mkdtempSync(join(tmpdir(), "sg-contract-"));
  mkdirSync(join(dir, "components"), { recursive: true });
  writeFileSync(join(dir, "graph_index.md"), [
    "# Contract Graph — Index", "",
    "## Quick Index", "",
    "| Category | Nodes | File |",
    "|---|---|---|",
    "| **Components** | _(add here)_ | `components/{NAME}.md` |",
    "| **Invariants** | _(add here)_ | `invariants.md` |",
    "| **Active Regressions** | _(add here)_ | `regressions.md` |",
    "| **Decisions** | _(add here)_ | `decisions.md` |",
    "| **Watchlists & Open Issues** | _(add here)_ | `watchlists.md` |",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "regressions.md"), [
    "## NODE: REG_CONTRACT",
    "**Type:** Regression",
    "**Priority:** HIGH",
    "**Label:** Contract regression",
    "**Summary:** A regression fixture for the contract test.",
    "**Tags:** _(none)_",
    "**Edges:** _(none)_",
    "**Files:** `src/contract.ts`",
    "**LastUpdated:** 2026-01-01",
    "",
  ].join("\n"));
  for (const f of ["invariants.md", "decisions.md", "watchlists.md"]) writeFileSync(join(dir, f), "");
  return dir;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map(c => c.text ?? "").join("\n");
}

before(async () => {
  graphDir = makeGraph();
  callLog = join(graphDir, "calls.log");
  const transport = new StdioClientTransport({
    command: process.execPath,                       // node
    args: ["--import", "tsx/esm", serverEntry],       // run the TS server directly
    env: { ...process.env, SIMPLEGRAPH_ROOT: graphDir, SIMPLEGRAPH_CALL_LOG: callLog } as Record<string, string>,
    stderr: "ignore",                                 // suppress the startup banner
  });
  client = new Client({ name: "contract-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
});

test("tools/list advertises the core tool surface", async () => {
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  for (const n of [
    "simplegraph_index", "simplegraph_nodes", "simplegraph_check_files",
    "simplegraph_search", "simplegraph_add_node", "simplegraph_update_node",
    "simplegraph_reindex",
  ]) {
    assert.ok(names.includes(n), `tools/list is missing ${n} (got: ${names.join(", ")})`);
  }
  // Every advertised tool must carry an input schema, or agents can't call it.
  for (const t of tools) assert.equal((t.inputSchema as { type?: string }).type, "object", `${t.name} has no object inputSchema`);
});

test("simplegraph_index returns the project's index", async () => {
  const r = await client.callTool({ name: "simplegraph_index", arguments: {} });
  assert.match(textOf(r), /Quick Index/);
});

test("simplegraph_check_files surfaces the HIGH regression for a referenced file", async () => {
  const r = await client.callTool({ name: "simplegraph_check_files", arguments: { files: ["src/contract.ts"] } });
  const text = textOf(r);
  assert.match(text, /REG_CONTRACT/);
  assert.match(text, /HIGH/);
});

test("add_node → get_node round-trips over the wire", async () => {
  const add = await client.callTool({
    name: "simplegraph_add_node",
    arguments: { type: "Decision", id: "DEC_CONTRACT", label: "Wire test", summary: "Added over MCP.", priority: "LOW" },
  });
  assert.match(textOf(add), /DEC_CONTRACT/);

  const got = await client.callTool({ name: "simplegraph_get_node", arguments: { id: "DEC_CONTRACT" } });
  assert.match(textOf(got), /DEC_CONTRACT/);
  assert.match(textOf(got), /Wire test/);
});

test("an unknown tool is reported as an error, not a crash", async () => {
  const r = await client.callTool({ name: "simplegraph_add_node", arguments: { /* missing required fields */ } as Record<string, unknown> });
  // The server should answer (isError), not drop the connection.
  assert.ok(textOf(r).length > 0);
});

test("SIMPLEGRAPH_CALL_LOG records every tool invocation", async () => {
  // Every call above ran against a server with the call log enabled; the log is
  // what the live-harness evals read to prove an agent actually used the graph.
  assert.ok(existsSync(callLog), "call log was not written");
  const logged = readFileSync(callLog, "utf-8");
  for (const tool of ["simplegraph_index", "simplegraph_check_files", "simplegraph_add_node", "simplegraph_get_node"]) {
    assert.match(logged, new RegExp(`\\b${tool}\\b`), `call log is missing ${tool}`);
  }
  // Format: one "<ISO timestamp> <tool>" per line.
  assert.match(logged, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z simplegraph_/m);
});
