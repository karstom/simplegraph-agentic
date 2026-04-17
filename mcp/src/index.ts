#!/usr/bin/env node
// simplegraph-agentic MCP server
// Exposes memory graph tools to MCP-compatible AI agents (Claude, Cursor, etc.)
//
// Usage: SIMPLEGRAPH_ROOT=/path/to/project/core node dist/index.js
//
// Tools exposed:
//   simplegraph_index        — Get the graph index and task routing table
//   simplegraph_nodes        — Get nodes by category
//   simplegraph_check_files  — Check files for known issues (call before editing)
//   simplegraph_anti_patterns — Get anti-patterns (call before generating code)
//   simplegraph_search        — Search across all nodes
//   simplegraph_add_node      — Add a new node (after fixing a bug / making a decision)
//   simplegraph_update_node   — Update a node field (e.g. increment REGRESSED_N_TIMES)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import { parseNodes, formatNode, type GraphNode } from "./parser.js";

// ── Config ────────────────────────────────────────────────────────────────────

const GRAPH_ROOT = process.env.SIMPLEGRAPH_ROOT
  ? path.resolve(process.env.SIMPLEGRAPH_ROOT)
  : path.resolve(process.cwd(), "core");

// ── File I/O ──────────────────────────────────────────────────────────────────

function readGraphFile(name: string): string {
  try {
    return fs.readFileSync(path.join(GRAPH_ROOT, name), "utf-8");
  } catch {
    return "";
  }
}

function writeGraphFile(name: string, content: string): void {
  const fullPath = path.join(GRAPH_ROOT, name);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function getAllNodes(): GraphNode[] {
  const coreFiles = ["regressions.md", "invariants.md", "decisions.md", "watchlists.md"];
  const nodes: GraphNode[] = [];

  for (const f of coreFiles) {
    nodes.push(...parseNodes(readGraphFile(f), f));
  }

  // Scan components/ directory
  const compDir = path.join(GRAPH_ROOT, "components");
  if (fs.existsSync(compDir)) {
    for (const file of fs.readdirSync(compDir)) {
      if (file.endsWith(".md")) {
        const rel = `components/${file}`;
        nodes.push(...parseNodes(readGraphFile(rel), rel));
      }
    }
  }

  return nodes;
}

function targetFileForType(type: string, id: string): string {
  switch (type.toLowerCase()) {
    case "component":  return `components/${id.toLowerCase()}.md`;
    case "invariant":  return "invariants.md";
    case "regression": return "regressions.md";
    case "decision":   return "decisions.md";
    case "watchlist":  return "watchlists.md";
    default:           return "watchlists.md";
  }
}

// ── Response helpers ──────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true as const };
}

function summarizeNodes(nodes: GraphNode[]): string {
  return nodes.map(n => {
    const lines = [
      `### ${n.id}`,
      `**Type:** ${n.type} | **Priority:** ${n.priority}`,
      `**Label:** ${n.label}`,
      `**Summary:** ${n.summary}`,
    ];
    if (n.regressedNTimes !== undefined)
      lines.push(`**REGRESSED_N_TIMES:** ${n.regressedNTimes}`);
    if (n.edges.length)
      lines.push(`**Edges:** ${n.edges.join(" · ")}`);
    if (n.files.length)
      lines.push(`**Files:** ${n.files.map(f => `\`${f}\``).join(", ")}`);
    lines.push(`**LastUpdated:** ${n.lastUpdated} | **Source:** ${n.sourceFile}`);
    return lines.join("\n");
  }).join("\n\n---\n\n");
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "simplegraph-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "simplegraph_index",
      description:
        "Get the memory graph index with quick-scan node table and task routing. " +
        "Call at task start to understand what's in the graph before loading detail files.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "simplegraph_nodes",
      description:
        "Get all nodes from a category (regressions, invariants, decisions, watchlists, " +
        "anti_patterns, components). Returns structured summaries, edges, and file references.",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["regressions", "invariants", "decisions", "watchlists", "anti_patterns", "components"],
            description: "The node category to retrieve",
          },
        },
        required: ["category"],
      },
    },
    {
      name: "simplegraph_check_files",
      description:
        "CALL THIS BEFORE EDITING ANY FILE. Returns any regressions, watchlists, or " +
        "invariants that reference the files you plan to modify. Prevents reintroducing " +
        "known bugs and flags high-risk code areas.",
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "File paths you plan to modify (relative paths, basenames, or full paths all work)",
          },
        },
        required: ["files"],
      },
    },
    {
      name: "simplegraph_anti_patterns",
      description:
        "Get the anti-patterns list for this codebase. CALL THIS BEFORE GENERATING CODE " +
        "to avoid patterns that have been explicitly banned due to past failures.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "simplegraph_search",
      description:
        "Search across all nodes by keyword. Useful for finding nodes related to a " +
        "specific file, service name, error type, or concept.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keywords to search for in node IDs, labels, summaries, edges, and file references",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "simplegraph_add_node",
      description:
        "Add a new node to the memory graph. Call this after fixing a bug (add Regression), " +
        "making an architectural decision (add Decision), or identifying a danger zone (add Watchlist). " +
        "Include this in the same commit as the code change.",
      inputSchema: {
        type: "object",
        properties: {
          type:            { type: "string", enum: ["Component", "Invariant", "Regression", "Decision", "Watchlist"] },
          id:              { type: "string", description: "UPPER_SNAKE_CASE unique ID (e.g. REG_MY_BUG, INV_MY_RULE)" },
          label:           { type: "string", description: "Short human-readable label" },
          summary:         { type: "string", description: "2-4 sentences: what happened, why it matters, how it was fixed" },
          priority:        { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
          files:           { type: "array", items: { type: "string" }, description: "Affected file paths" },
          edges:           { type: "array", items: { type: "string" }, description: "Edge strings: 'VIOLATED_BY → INV_X: explanation'" },
          regressedNTimes: { type: "number", description: "For Regression nodes: how many times this has occurred" },
        },
        required: ["type", "id", "label", "summary", "priority"],
      },
    },
    {
      name: "simplegraph_update_node",
      description:
        "Update a field on an existing node. Use value='increment' for REGRESSED_N_TIMES " +
        "when a bug recurs. Also useful for updating Priority or Summary.",
      inputSchema: {
        type: "object",
        properties: {
          id:    { type: "string", description: "Node ID to update" },
          field: {
            type: "string",
            enum: ["Summary", "Priority", "LastUpdated", "REGRESSED_N_TIMES", "Files"],
            description: "Field to update",
          },
          value: {
            type: "string",
            description: "New value. For REGRESSED_N_TIMES, use 'increment' to add 1. For LastUpdated, use 'today'.",
          },
        },
        required: ["id", "field", "value"],
      },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {

      case "simplegraph_index": {
        const content = readGraphFile("graph_index.md");
        if (!content) return fail(
          `graph_index.md not found at ${GRAPH_ROOT}. ` +
          `Set SIMPLEGRAPH_ROOT env var to your project's core/ directory.`
        );
        return ok(content);
      }

      case "simplegraph_nodes": {
        const { category } = args as { category: string };
        if (category === "anti_patterns") {
          const content = readGraphFile("anti_patterns.md");
          return ok(content || "No anti_patterns.md found.");
        }
        if (category === "components") {
          const nodes = getAllNodes().filter(n => n.type.toLowerCase() === "component");
          return ok(nodes.length ? summarizeNodes(nodes) : "No component nodes found.");
        }
        const fileMap: Record<string, string> = {
          regressions: "regressions.md",
          invariants:  "invariants.md",
          decisions:   "decisions.md",
          watchlists:  "watchlists.md",
        };
        const file = fileMap[category];
        if (!file) return fail(`Unknown category: ${category}`);
        const nodes = parseNodes(readGraphFile(file), file);
        return ok(nodes.length ? summarizeNodes(nodes) : `No nodes found in ${file}.`);
      }

      case "simplegraph_check_files": {
        const { files } = args as { files: string[] };
        if (!files.length) return ok("No files provided.");

        const allNodes = getAllNodes();
        const hits = allNodes.filter(node =>
          node.files.some(nodeFile =>
            files.some(target => {
              const nBase = path.basename(nodeFile).toLowerCase();
              const tBase = path.basename(target).toLowerCase();
              return (
                nodeFile.includes(target) ||
                target.includes(nodeFile) ||
                nBase === tBase
              );
            })
          )
        );

        if (!hits.length) return ok("✓ No known issues for these files. Proceed carefully.");

        const high = hits.filter(n => n.priority === "HIGH");
        const other = hits.filter(n => n.priority !== "HIGH");
        const sorted = [...high, ...other];

        return ok(
          `⚠ Found ${hits.length} node(s) referencing these files` +
          (high.length ? ` (${high.length} HIGH priority)` : "") +
          `:\n\n${summarizeNodes(sorted)}`
        );
      }

      case "simplegraph_anti_patterns": {
        const content = readGraphFile("anti_patterns.md");
        return ok(content || "No anti_patterns.md found.");
      }

      case "simplegraph_search": {
        const { query } = args as { query: string };
        const q = query.toLowerCase();
        const hits = getAllNodes().filter(n =>
          n.id.toLowerCase().includes(q) ||
          n.label.toLowerCase().includes(q) ||
          n.summary.toLowerCase().includes(q) ||
          n.files.some(f => f.toLowerCase().includes(q)) ||
          n.edges.some(e => e.toLowerCase().includes(q))
        );
        if (!hits.length) return ok(`No nodes found matching "${query}".`);
        return ok(`Found ${hits.length} node(s) matching "${query}":\n\n${summarizeNodes(hits)}`);
      }

      case "simplegraph_add_node": {
        const {
          type, id, label, summary, priority,
          files = [], edges = [], regressedNTimes,
        } = args as {
          type: string; id: string; label: string; summary: string;
          priority: string; files?: string[]; edges?: string[];
          regressedNTimes?: number;
        };

        // Validate ID isn't already used
        const existing = getAllNodes().find(n => n.id === id);
        if (existing) return fail(`Node ${id} already exists in ${existing.sourceFile}. Use simplegraph_update_node instead.`);

        const today = new Date().toISOString().slice(0, 10);
        const nodeText = formatNode({ id, type, priority, label, summary, files, edges, lastUpdated: today, regressedNTimes });
        const targetFile = targetFileForType(type, id);
        const existing_content = readGraphFile(targetFile);

        writeGraphFile(
          targetFile,
          existing_content
            ? `${existing_content.trimEnd()}\n\n---\n\n${nodeText}\n`
            : `${nodeText}\n`
        );

        return ok(
          `✓ Added NODE: ${id} to ${targetFile}.\n\n` +
          `Next steps:\n` +
          `1. Update graph_index.md to include ${id} in the Quick Index.\n` +
          `2. Run bash core/scripts/consistency_check.sh to verify no broken edges.\n` +
          `3. Commit both the code change and the graph update together.`
        );
      }

      case "simplegraph_update_node": {
        const { id, field, value } = args as { id: string; field: string; value: string };

        const allNodes = getAllNodes();
        const node = allNodes.find(n => n.id === id);
        if (!node) return fail(`Node ${id} not found. Use simplegraph_search to find it.`);

        const filePath = path.join(GRAPH_ROOT, node.sourceFile);
        let content = fs.readFileSync(filePath, "utf-8");

        const today = new Date().toISOString().slice(0, 10);
        const resolvedValue = value === "today" ? today : value;

        if (field === "REGRESSED_N_TIMES" && value === "increment") {
          const current = node.regressedNTimes ?? 0;
          const next = current + 1;
          // Update the counter; auto-upgrade to HIGH if >= 2
          content = content.replace(
            new RegExp(`(## NODE: ${id}[\\s\\S]*?\\*\\*REGRESSED_N_TIMES:\\*\\*\\s*)\\d+`),
            `$1${next}`
          );
          if (next >= 2) {
            content = content.replace(
              new RegExp(`(## NODE: ${id}[\\s\\S]*?\\*\\*Priority:\\*\\*\\s*)\\S+`),
              `$1HIGH`
            );
          }
          fs.writeFileSync(filePath, content);
          return ok(`✓ REGRESSED_N_TIMES for ${id}: ${current} → ${next}${next >= 2 ? " (Priority auto-upgraded to HIGH)" : ""}.`);
        }

        // Generic field update
        const fieldPattern = new RegExp(`(## NODE: ${id}[\\s\\S]*?\\*\\*${field}:\\*\\*\\s*).+`);
        if (!fieldPattern.test(content)) {
          return fail(`Field **${field}:** not found in NODE: ${id}. Check the field name.`);
        }
        content = content.replace(fieldPattern, `$1${resolvedValue}`);
        fs.writeFileSync(filePath, content);
        return ok(`✓ Updated **${field}** for NODE: ${id} → "${resolvedValue}" in ${node.sourceFile}.`);
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return fail((e as Error).message);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`simplegraph-mcp v0.1.0 ready\nGRAPH_ROOT: ${GRAPH_ROOT}\n`);
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e.message}\n`);
  process.exit(1);
});
