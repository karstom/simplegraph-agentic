#!/usr/bin/env node
// simplegraph-agentic MCP server
// Exposes memory graph tools to MCP-compatible AI agents (Claude, Cursor, etc.)
//
// Env vars:
//   SIMPLEGRAPH_ROOT    — path to project's core/ directory (required)
//   SIMPLEGRAPH_SHARED  — path to shared team graph's core/ directory (optional)
//
// Multi-project (Claude Desktop): register one named server entry per project.
// Cursor/VS Code: use ${workspaceFolder}/core — automatically project-scoped.

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

// Optional second graph (shared/ cross-repo nodes). Read-only from this server.
const SHARED_ROOT = process.env.SIMPLEGRAPH_SHARED
  ? path.resolve(process.env.SIMPLEGRAPH_SHARED)
  : null;

// ── File I/O ──────────────────────────────────────────────────────────────────

function readGraphFile(name: string, root: string = GRAPH_ROOT): string {
  try {
    return fs.readFileSync(path.join(root, name), "utf-8");
  } catch {
    return "";
  }
}

function writeGraphFile(name: string, content: string, root: string = GRAPH_ROOT): void {
  // Writes always go to the primary project root, never the shared root.
  const fullPath = path.join(root, name);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function getNodesFromRoot(root: string, tag?: string): GraphNode[] {
  const coreFiles = ["regressions.md", "invariants.md", "decisions.md", "watchlists.md"];
  const nodes: GraphNode[] = [];

  for (const f of coreFiles) {
    const content = readGraphFile(f, root);
    const parsed = parseNodes(content, f);
    // Tag shared nodes so they're identifiable in output
    if (tag) parsed.forEach(n => { n.sourceFile = `[${tag}] ${n.sourceFile}`; });
    nodes.push(...parsed);
  }

  const compDir = path.join(root, "components");
  if (fs.existsSync(compDir)) {
    for (const file of fs.readdirSync(compDir)) {
      if (file.endsWith(".md")) {
        const rel = `components/${file}`;
        const parsed = parseNodes(readGraphFile(rel, root), rel);
        if (tag) parsed.forEach(n => { n.sourceFile = `[${tag}] ${n.sourceFile}`; });
        nodes.push(...parsed);
      }
    }
  }

  return nodes;
}

function getAllNodes(): GraphNode[] {
  const nodes = getNodesFromRoot(GRAPH_ROOT);
  if (SHARED_ROOT) {
    nodes.push(...getNodesFromRoot(SHARED_ROOT, "shared"));
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

type TextContent = { type: "text"; text: string };
export type ToolResult = { content: TextContent[]; isError?: true };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

function summarizeNodes(nodes: GraphNode[]): string {
  return nodes.map(n => {
    const lines = [
      `### ${n.id}`,
      `**Type:** ${n.type} | **Priority:** ${n.priority}`,
      `**Label:** ${n.label}`,
      `**Summary:** ${n.summary}`,
    ];
    if (n.tags.length)
      lines.push(`**Tags:** ${n.tags.join(", ")}`);
    if (n.regressedNTimes !== undefined)
      lines.push(`**REGRESSED_N_TIMES:** ${n.regressedNTimes}`);
    if (n.rootCause)
      lines.push(`**RootCause:** ${n.rootCause}`);
    if (n.edges.length)
      lines.push(`**Edges:** ${n.edges.join(" · ")}`);
    if (n.files.length)
      lines.push(`**Files:** ${n.files.map(f => `\`${f}\``).join(", ")}`);
    lines.push(`**LastUpdated:** ${n.lastUpdated} | **Source:** ${n.sourceFile}`);
    return lines.join("\n");
  }).join("\n\n---\n\n");
}

// ── Recurrence Root-Cause Gate ────────────────────────────────────────────────

function buildGateMessage(nodeId: string, nextValue: number): string {
  return (
    `⚠ RECURRENCE ROOT-CAUSE GATE\n\n` +
    `This regression has now recurred ${nextValue} times (REGRESSED_N_TIMES would reach ${nextValue}).\n` +
    `The increment has NOT been applied.\n\n` +
    `Before recording this recurrence, re-invoke simplegraph_update_node with a\n` +
    `\`root_cause\` argument answering all three of:\n\n` +
    `1. SOURCE OF TRUTH — What is the authoritative source for this state, and why\n` +
    `   isn't the code reading it directly instead of maintaining a local mirror?\n\n` +
    `2. VIOLATED INVARIANT — Which rule is being broken? If no Invariant node exists\n` +
    `   for this yet, add one with simplegraph_add_node before proceeding.\n\n` +
    `3. WHY PRIOR FIXES WERE SYMPTOMATIC — What did fixes 1..${nextValue - 1} treat instead of\n` +
    `   the root cause? (e.g. "each fix added another place to stamp the same flag")\n\n` +
    `⛔ Same-class patches (another guard/stamp/preserve site for the same derived\n` +
    `flag) are not acceptable until this is filled.`
  );
}

// Insert or update the **RootCause:** field in a specific node's block.
// Placed immediately after **REGRESSED_N_TIMES:** to keep format consistent.
function insertRootCauseInContent(content: string, nodeId: string, rootCause: string): string {
  const nodeMarker = `## NODE: ${nodeId}`;
  const nodeStart = content.indexOf(nodeMarker);
  if (nodeStart === -1) return content;

  // Isolate this node's block so we never touch adjacent nodes
  const nextNodeIdx = content.indexOf("\n## NODE:", nodeStart + 1);
  const nodeEnd = nextNodeIdx !== -1 ? nextNodeIdx : content.length;

  const before = content.slice(0, nodeStart);
  let nodeBlock = content.slice(nodeStart, nodeEnd);
  const after = content.slice(nodeEnd);

  if (/\*\*RootCause:\*\*/.test(nodeBlock)) {
    nodeBlock = nodeBlock.replace(/\*\*RootCause:\*\*[^\n]+/, `**RootCause:** ${rootCause}`);
  } else {
    // Insert on line immediately after **REGRESSED_N_TIMES:** N
    nodeBlock = nodeBlock.replace(
      /(\*\*REGRESSED_N_TIMES:\*\*[^\n]+)/,
      `$1\n**RootCause:** ${rootCause}`
    );
  }

  return before + nodeBlock + after;
}

// ── Exported handler functions (testable with any graphRoot) ──────────────────

export function handleUpdateNode(
  args: { id: string; field: string; value: string; root_cause?: string },
  graphRoot: string,
  sharedRoot: string | null = null
): ToolResult {
  const { id, field, value, root_cause } = args;

  const localNodes = getNodesFromRoot(graphRoot);
  const sharedNodes = sharedRoot ? getNodesFromRoot(sharedRoot, "shared") : [];
  const allNodes = [...localNodes, ...sharedNodes];

  const node = allNodes.find(n => n.id === id);
  if (!node) return fail(`Node ${id} not found. Use simplegraph_search to find it.`);

  const isShared = node.sourceFile.startsWith("[shared]");
  if (isShared) return fail(`Node ${id} is in the shared read-only graph. Update it in its source repo.`);

  const filePath = path.join(graphRoot, node.sourceFile);
  let content = fs.readFileSync(filePath, "utf-8");

  const today = new Date().toISOString().slice(0, 10);
  const resolvedValue = value === "today" ? today : value;

  if (field === "REGRESSED_N_TIMES" && value === "increment") {
    const current = node.regressedNTimes ?? 0;
    const next = current + 1;

    // Gate: second recurrence and beyond require root_cause
    if (next >= 2) {
      const rc = root_cause?.trim();
      if (!rc) {
        return ok(buildGateMessage(id, next));
      }
    }

    // Apply the increment
    content = content.replace(
      new RegExp(`(## NODE: ${id}[\\s\\S]*?\\*\\*REGRESSED_N_TIMES:\\*\\*\\s*)\\d+`),
      `$1${next}`
    );

    // Auto-upgrade priority to HIGH at >= 2
    if (next >= 2) {
      content = content.replace(
        new RegExp(`(## NODE: ${id}[\\s\\S]*?\\*\\*Priority:\\*\\*\\s*)\\S+`),
        `$1HIGH`
      );
    }

    // Write root_cause into the node when provided
    const rc = root_cause?.trim();
    if (rc) {
      content = insertRootCauseInContent(content, id, rc);
    }

    fs.writeFileSync(filePath, content);

    const upgraded = next >= 2 ? " (Priority auto-upgraded to HIGH)" : "";
    const gateNote = rc ? ". Root-Cause Gate satisfied — RootCause field written." : ".";
    return ok(`✓ REGRESSED_N_TIMES for ${id}: ${current} → ${next}${upgraded}${gateNote}`);
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

export function handleAddNode(
  args: {
    type: string; id: string; label: string; summary: string; priority: string;
    tags?: string[]; files?: string[]; edges?: string[];
    regressedNTimes?: number; root_cause?: string;
  },
  graphRoot: string,
  sharedRoot: string | null = null
): ToolResult {
  const { type, id, label, summary, priority, tags = [], files = [], edges = [], regressedNTimes, root_cause } = args;

  // Gate: creating a Regression with regressedNTimes >= 2 (re-importing history) requires root_cause
  if (type.toLowerCase() === "regression" && regressedNTimes !== undefined && regressedNTimes >= 2) {
    const rc = root_cause?.trim();
    if (!rc) {
      return ok(buildGateMessage(id, regressedNTimes));
    }
  }

  const localNodes = getNodesFromRoot(graphRoot);
  const sharedNodes = sharedRoot ? getNodesFromRoot(sharedRoot, "shared") : [];
  const allNodes = [...localNodes, ...sharedNodes];

  // Validate ID uniqueness
  const existing = allNodes.find(n => n.id === id);
  if (existing) return fail(`Node ${id} already exists in ${existing.sourceFile}. Use simplegraph_update_node instead.`);

  // Validate edge targets reference existing nodes
  if (edges.length > 0) {
    const knownIds = new Set(allNodes.map(n => n.id));
    const broken = edges.flatMap(e => {
      const m = e.match(/→\s*([A-Z][A-Z0-9_]*)/);
      return m && !knownIds.has(m[1]) ? [m[1]] : [];
    });
    if (broken.length > 0)
      return fail(`Edge target(s) not found: ${broken.join(", ")}. Create those nodes first or check IDs with simplegraph_search.`);
  }

  const rc = root_cause?.trim() || undefined;
  const today = new Date().toISOString().slice(0, 10);
  const nodeText = formatNode({ id, type, priority, label, summary, tags, files, edges, lastUpdated: today, regressedNTimes, rootCause: rc });
  const targetFile = targetFileForType(type, id);
  const existingContent = readGraphFile(targetFile, graphRoot);

  writeGraphFile(
    targetFile,
    existingContent
      ? `${existingContent.trimEnd()}\n\n---\n\n${nodeText}\n`
      : `${nodeText}\n`,
    graphRoot
  );

  return ok(
    `✓ Added NODE: ${id} to ${targetFile}.\n\n` +
    `Next steps:\n` +
    `1. Call simplegraph_update_index({id:"${id}", type:"${type}", file:"${targetFile}"}) to add it to graph_index.md.\n` +
    `2. Run bash core/scripts/consistency_check.sh to verify no broken edges.\n` +
    `3. Commit both the code change and the graph update together.`
  );
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "simplegraph-mcp", version: "0.3.0" },
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
        "Include this in the same commit as the code change. " +
        "NOTE: creating a Regression node with regressedNTimes ≥ 2 (re-importing history) requires " +
        "root_cause — same three-question gate as simplegraph_update_node.",
      inputSchema: {
        type: "object",
        properties: {
          type:            { type: "string", enum: ["Component", "Invariant", "Regression", "Decision", "Watchlist"] },
          id:              { type: "string", description: "UPPER_SNAKE_CASE unique ID (e.g. REG_MY_BUG, INV_MY_RULE)" },
          label:           { type: "string", description: "Short human-readable label" },
          summary:         { type: "string", description: "2-4 sentences: what happened, why it matters, how it was fixed" },
          priority:        { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
          tags:            { type: "array", items: { type: "string" }, description: "Lowercase tags for similarity search, e.g. ['auth', 'token', 'session']" },
          files:           { type: "array", items: { type: "string" }, description: "Affected file paths" },
          edges:           { type: "array", items: { type: "string" }, description: "Edge strings: 'VIOLATED_BY → INV_X: explanation'" },
          regressedNTimes: { type: "number", description: "For Regression nodes: how many times this has occurred" },
          root_cause:      { type: "string", description: "Required when regressedNTimes ≥ 2. Must answer: (1) authoritative source of truth, (2) specific invariant violated, (3) why prior fixes were symptomatic." },
        },
        required: ["type", "id", "label", "summary", "priority"],
      },
    },
    {
      name: "simplegraph_update_node",
      description:
        "Update a field on an existing node. Use value='increment' for REGRESSED_N_TIMES " +
        "when a bug recurs. Also useful for updating Priority or Summary.\n\n" +
        "RECURRENCE ROOT-CAUSE GATE (hard block, not a warning): when incrementing " +
        "REGRESSED_N_TIMES to a value ≥ 2 (second recurrence or beyond), you MUST supply " +
        "a non-empty `root_cause` or the increment will be refused and the value will NOT " +
        "change. root_cause must answer all three: (1) the authoritative source of truth " +
        "for the state this regression corrupts — why isn't the code reading it directly? " +
        "(2) which invariant is being violated — add an Invariant node first if none exists. " +
        "(3) why every prior fix was symptomatic — what did each patch treat instead of the " +
        "root cause? Once supplied, root_cause is written to the node as a permanent record.",
      inputSchema: {
        type: "object",
        properties: {
          id:         { type: "string", description: "Node ID to update" },
          field: {
            type: "string",
            enum: ["Summary", "Priority", "Tags", "LastUpdated", "REGRESSED_N_TIMES", "Files"],
            description: "Field to update",
          },
          value: {
            type: "string",
            description: "New value. For REGRESSED_N_TIMES, use 'increment' to add 1. For LastUpdated, use 'today'.",
          },
          root_cause: {
            type: "string",
            description: "Required when incrementing REGRESSED_N_TIMES to ≥ 2. " +
              "Answer all three: source of truth, violated invariant, why prior fixes were symptomatic. " +
              "Omitting this blocks the increment — the counter will NOT advance.",
          },
        },
        required: ["id", "field", "value"],
      },
    },
    {
      name: "simplegraph_get_node",
      description:
        "Fetch a single node by its exact ID. Returns the full raw node record. " +
        "Use this when you know the exact ID; use simplegraph_search for keyword lookups.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Exact node ID (UPPER_SNAKE_CASE)" },
        },
        required: ["id"],
      },
    },
    {
      name: "simplegraph_scratchpad",
      description:
        "Read, append to, or clear the session scratchpad (.scratchpad.md). " +
        "The scratchpad is gitignored — use it for mid-session notes not yet ready to commit as nodes.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["read", "append", "clear"],
            description: "read: get contents; append: add text; clear: empty the scratchpad",
          },
          text: { type: "string", description: "Text to append (required for action='append')" },
        },
        required: ["action"],
      },
    },
    {
      name: "simplegraph_archive_regression",
      description:
        "Move a resolved Regression node from regressions.md to archive/resolved_regressions.md. " +
        "Call this when a bug has been permanently fixed.",
      inputSchema: {
        type: "object",
        properties: {
          id:         { type: "string", description: "Regression node ID to archive" },
          resolution: { type: "string", description: "One sentence describing how it was resolved (appended to summary)" },
        },
        required: ["id"],
      },
    },
    {
      name: "simplegraph_update_index",
      description:
        "Add a node to the graph_index.md Quick Index table. Call this immediately after " +
        "simplegraph_add_node to keep the index current.",
      inputSchema: {
        type: "object",
        properties: {
          id:   { type: "string", description: "Node ID to add (UPPER_SNAKE_CASE)" },
          type: { type: "string", enum: ["Component", "Invariant", "Regression", "Decision", "Watchlist"] },
          file: { type: "string", description: "Relative path to the node's file, e.g. components/AUTH.md or regressions.md" },
        },
        required: ["id", "type", "file"],
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
        let result = content;
        if (SHARED_ROOT) {
          const shared = readGraphFile("graph_index.md", SHARED_ROOT);
          if (shared) result += `\n\n---\n\n**Shared graph** (${SHARED_ROOT}):\n\n${shared}`;
        }
        return ok(result);
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
        const typeMap: Record<string, string> = {
          regressions: "regression",
          invariants:  "invariant",
          decisions:   "decision",
          watchlists:  "watchlist",
        };
        const typeName = typeMap[category];
        if (!typeName) return fail(`Unknown category: ${category}`);
        const nodes = getAllNodes().filter(n => n.type.toLowerCase() === typeName);
        return ok(nodes.length ? summarizeNodes(nodes) : `No nodes found for category: ${category}.`);
      }

      case "simplegraph_check_files": {
        const { files } = args as { files: string[] };
        if (!files.length) return ok("No files provided.");

        const allNodes = getAllNodes();
        const hits = allNodes.filter(node =>
          node.files.some(nodeFile =>
            files.some(target => {
              const n = nodeFile.replace(/\\/g, "/").toLowerCase();
              const t = target.replace(/\\/g, "/").toLowerCase();
              return n.includes(t) || t.includes(n);
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
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = getAllNodes().filter(n => {
          const haystack = [n.id, n.label, n.summary, ...n.tags, ...n.files, ...n.edges].join(" ").toLowerCase();
          return terms.every(t => haystack.includes(t));
        });
        if (!hits.length) return ok(`No nodes found matching "${query}".`);
        return ok(`Found ${hits.length} node(s) matching "${query}":\n\n${summarizeNodes(hits)}`);
      }

      case "simplegraph_add_node": {
        const {
          type, id, label, summary, priority,
          tags, files, edges, regressedNTimes, root_cause,
        } = args as {
          type: string; id: string; label: string; summary: string;
          priority: string; tags?: string[]; files?: string[]; edges?: string[];
          regressedNTimes?: number; root_cause?: string;
        };
        return handleAddNode(
          { type, id, label, summary, priority, tags, files, edges, regressedNTimes, root_cause },
          GRAPH_ROOT,
          SHARED_ROOT
        );
      }

      case "simplegraph_update_node": {
        const { id, field, value, root_cause } = args as {
          id: string; field: string; value: string; root_cause?: string;
        };
        return handleUpdateNode({ id, field, value, root_cause }, GRAPH_ROOT, SHARED_ROOT);
      }

      case "simplegraph_get_node": {
        const { id } = args as { id: string };
        const node = getAllNodes().find(n => n.id === id);
        if (!node) return fail(`Node ${id} not found. Use simplegraph_search to find it.`);
        return ok(node.rawContent.trim());
      }

      case "simplegraph_scratchpad": {
        const { action, text } = args as { action: string; text?: string };
        const scratchFile = ".scratchpad.md";
        if (action === "read") {
          const content = readGraphFile(scratchFile);
          return ok(content || "_(scratchpad is empty)_");
        }
        if (action === "append") {
          if (!text) return fail("text is required for action='append'.");
          const existing = readGraphFile(scratchFile);
          const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
          writeGraphFile(scratchFile, `${existing}${existing ? "\n" : ""}<!-- ${ts} -->\n${text}\n`);
          return ok("✓ Appended to scratchpad.");
        }
        if (action === "clear") {
          writeGraphFile(scratchFile, "");
          return ok("✓ Scratchpad cleared.");
        }
        return fail(`Unknown action: ${action}. Use 'read', 'append', or 'clear'.`);
      }

      case "simplegraph_archive_regression": {
        const { id, resolution } = args as { id: string; resolution?: string };
        const regrContent = readGraphFile("regressions.md");
        if (!regrContent) return fail("regressions.md not found.");

        const nodes = parseNodes(regrContent, "regressions.md");
        const node = nodes.find(n => n.id === id);
        if (!node) return fail(`Node ${id} not found in regressions.md.`);
        if (node.type.toLowerCase() !== "regression")
          return fail(`Node ${id} is type "${node.type}", not Regression.`);

        const today = new Date().toISOString().slice(0, 10);
        const updatedSummary = resolution
          ? `${node.summary.replace(/\.*$/, "")}. Resolved: ${resolution}`
          : node.summary;

        const archiveBlock = formatNode({
          id: node.id, type: node.type, priority: node.priority,
          label: node.label, summary: updatedSummary, tags: node.tags,
          files: node.files, edges: node.edges,
          lastUpdated: today, regressedNTimes: node.regressedNTimes,
          rootCause: node.rootCause,
        });

        // Remove node block from regressions.md; rawContent includes trailing --- if not last node
        let newRegressions = regrContent.replace(node.rawContent, "");
        newRegressions = newRegressions.replace(/\n\n---\s*$/, ""); // trailing separator
        newRegressions = newRegressions.replace(/^---\s*\n+/, "");  // leading separator
        const trimmed = newRegressions.trim();
        writeGraphFile("regressions.md", trimmed ? trimmed + "\n" : "");

        const archiveContent = readGraphFile("archive/resolved_regressions.md");
        writeGraphFile(
          "archive/resolved_regressions.md",
          archiveContent
            ? `${archiveContent.trimEnd()}\n\n---\n\n${archiveBlock}\n`
            : `${archiveBlock}\n`
        );

        return ok(
          `✓ Archived NODE: ${id} → archive/resolved_regressions.md.\n\n` +
          `Next steps:\n` +
          `1. Remove ${id} from the Active Regressions row in graph_index.md.\n` +
          `2. Commit the archive alongside your fix.`
        );
      }

      case "simplegraph_update_index": {
        const { id, type, file } = args as { id: string; type: string; file: string };
        let content = readGraphFile("graph_index.md");
        if (!content) return fail("graph_index.md not found.");

        const categoryMap: Record<string, string> = {
          "Component":  "Components",
          "Invariant":  "Invariants",
          "Regression": "Active Regressions",
          "Decision":   "Decisions",
          "Watchlist":  "Watchlists & Open Issues",
        };
        const rowLabel = categoryMap[type];
        if (!rowLabel) return fail(`Unknown node type: ${type}`);

        // Match the Quick Index table row for this category
        const rowPattern = new RegExp(
          `(\\|\\s*\\*\\*${rowLabel}\\*\\*\\s*\\|)([^|]*)(\\|[^|]*\\|)`,
          "i"
        );
        if (!rowPattern.test(content)) {
          return fail(
            `Could not find "**${rowLabel}**" row in graph_index.md.\n` +
            `Add this row manually:\n| **${rowLabel}** | ${id} | \`${file}\` |`
          );
        }

        content = content.replace(rowPattern, (_, prefix, nodeCol, suffix) => {
          // Strip placeholder italic text like _(add your ... here)_
          const cleaned = nodeCol.replace(/_\([^)]*\)_/g, "").trim();
          const updated = cleaned ? ` ${cleaned}, ${id} ` : ` ${id} `;
          return `${prefix}${updated}${suffix}`;
        });

        writeGraphFile("graph_index.md", content);
        return ok(`✓ Added ${id} to the "${rowLabel}" row in graph_index.md.`);
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
  process.stderr.write(
    `simplegraph-mcp v0.3.0 ready\n` +
    `  GRAPH_ROOT:  ${GRAPH_ROOT}\n` +
    (SHARED_ROOT ? `  SHARED_ROOT: ${SHARED_ROOT}\n` : "")
  );
}

// Only start the server when run directly (bin or `node dist/index.js`) —
// importing this module for its exported handlers (tests) must not attach
// to stdio, or the importing process never exits.
if (/(^|[\\/])index\.(js|ts)$/.test(process.argv[1] ?? "")) {
  main().catch((e) => {
    process.stderr.write(`Fatal: ${e.message}\n`);
    process.exit(1);
  });
}
