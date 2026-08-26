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
import { parseNodes, formatNode, findNodeBlock, escapeRe, type GraphNode } from "./parser.js";
import { buildContext } from "./seed/mine.js";
import { selectDecisionCandidates, decisionIdFor, pullRequestTrail } from "./seed/candidates.js";
import { atomicWriteFileSync, withGraphLock } from "./fsutil.js";
import { regenerateIndex } from "./reindex.js";

// ── Config ────────────────────────────────────────────────────────────────────

const GRAPH_ROOT = process.env.SIMPLEGRAPH_ROOT
  ? path.resolve(process.env.SIMPLEGRAPH_ROOT)
  : path.resolve(process.cwd(), "core");

// Optional second graph (shared/ cross-repo nodes). Read-only from this server.
const SHARED_ROOT = process.env.SIMPLEGRAPH_SHARED
  ? path.resolve(process.env.SIMPLEGRAPH_SHARED)
  : null;

// Multi-agent attribution. When set, every node this server creates is stamped
// with who made it and in which session, so concurrent or conflicting writes
// from different agents can be told apart and arbitrated later. Both optional —
// tool arguments override these per call.
const DEFAULT_AUTHOR = process.env.SIMPLEGRAPH_AUTHOR || undefined;
const DEFAULT_SESSION = process.env.SIMPLEGRAPH_SESSION || undefined;

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
  // Atomic (temp + rename) so a concurrent reader never sees a torn file.
  atomicWriteFileSync(path.join(root, name), content);
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
    // Sorted, matching reindex.ts and seed/merge.ts: readdir order is
    // filesystem-dependent, which would make node ordering differ across machines.
    for (const file of fs.readdirSync(compDir).sort()) {
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

/**
 * Output budget for check_files.
 *
 * The whole premise of the graph is that an agent reads ~50 lines at session
 * start instead of 5,000. A safety check that returns 34 full node records
 * (~14k tokens measured on a real 251-node graph) spends more context than the
 * memory it is protecting, and an agent that learns the tool is expensive stops
 * calling it. So: full records for what you are editing, digests for the blast
 * radius — which is context, not the main event — and a hard cap on both.
 */
/**
 * Read a non-negative integer from the environment, falling back to `fallback`
 * when unset, unparseable, or negative. A malformed budget must not silently
 * become 0 and suppress the safety output the tool exists to produce.
 */
export function envInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

// Defaults tuned against a 251-node production graph. Raise them on a small
// graph where full records are affordable; lower them when many nodes match a
// single edit. 0 is legal: it pushes every node in that group to the terser
// form rather than hiding it.
const EDGE_PREVIEW         = envInt(process.env, "SIMPLEGRAPH_EDGE_PREVIEW", 6);
const DIRECT_DETAIL_LIMIT  = envInt(process.env, "SIMPLEGRAPH_CHECK_DETAIL_LIMIT", 5);
const RADIUS_DIGEST_LIMIT  = envInt(process.env, "SIMPLEGRAPH_CHECK_DIGEST_LIMIT", 20);
const DIGEST_SUMMARY_CHARS = envInt(process.env, "SIMPLEGRAPH_CHECK_DIGEST_CHARS", 180);

/** Clip to a whole word, without cutting mid-token. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

/**
 * One compact line-block per node: enough to decide whether to pull the full
 * record with simplegraph_get_node, and no more.
 */
export function digestNodes(hits: NodeHit[]): string {
  return hits.map(h => {
    const n = h.node;
    const recur = n.regressedNTimes !== undefined ? `, ×${n.regressedNTimes}` : "";
    return (
      `- **${n.id}** (${n.type}, ${n.priority}${recur}) — ${n.label}\n` +
      `  _matched on: ${h.reasons.join("; ")}_\n` +
      `  ${clip(n.summary, DIGEST_SUMMARY_CHARS)}`
    );
  }).join("\n");
}

export function summarizeNodes(nodes: GraphNode[]): string {
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
    if (n.edges.length) {
      // A seeded Component can carry 30+ CONTAINS edges. Dumping them inline
      // costs more context than the node's own content and buries it.
      const shown = n.edges.slice(0, EDGE_PREVIEW);
      const extra = n.edges.length - shown.length;
      const more = extra > 0 ? `_(+${extra} more — simplegraph_get_node ${n.id})_` : "";
      // With EDGE_PREVIEW=0 there is nothing to join, so emit the count alone
      // rather than a line that starts with a dangling separator.
      lines.push(`**Edges:** ${[...shown, more].filter(Boolean).join(" · ")}`);
    }
    if (n.files.length)
      lines.push(`**Files:** ${n.files.map(f => `\`${f}\``).join(", ")}`);
    if (n.symbols.length)
      lines.push(`**Symbols:** ${n.symbols.map(x => `\`${x}\``).join(", ")}`);
    if (n.paths.length)
      lines.push(`**Paths:** ${n.paths.map(x => `\`${x}\``).join(", ")}`);
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

/**
 * Does a node's **Files:** entry refer to the same file as `target`?
 * Compared segment-wise: one path must be a trailing sub-path of the other, so
 * `auth.ts` matches `src/auth.ts` but never `src/xauth.ts`. Both inputs are
 * already lowercased and forward-slashed by the caller.
 */
export function pathMatches(nodeFile: string, target: string): boolean {
  const norm = (p: string) =>
    p.replace(/\\/g, "/").toLowerCase().split("/").filter(seg => seg && seg !== ".");
  const a = norm(nodeFile);
  const b = norm(target);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const offset = long.length - short.length;
  return short.every((seg, i) => seg === long[offset + i]);
}

/**
 * Does `target` live under the directory `dir`?
 *
 * Segment-wise containment rather than a raw string prefix, so `src/auth`
 * matches `src/auth/token.ts` but not `src/authz/token.ts`. The run may start
 * at any segment so an absolute path from an external code graph
 * (`/home/me/proj/src/auth/token.ts`) matches a repo-relative owned path.
 */
export function pathUnderDir(dir: string, target: string): boolean {
  const norm = (p: string) =>
    p.replace(/\\/g, "/").toLowerCase().split("/").filter(seg => seg && seg !== ".");
  const d = norm(dir);
  const t = norm(target);
  if (!d.length || !t.length || d.length > t.length) return false;
  for (let i = 0; i + d.length <= t.length; i++) {
    if (d.every((seg, j) => seg === t[i + j])) return true;
  }
  return false;
}

/**
 * Does a node's anchored symbol refer to the same thing as `target`?
 *
 * Qualified and bare forms are treated as equal (`AuthService.refreshToken`
 * matches `refreshToken`), because a node is usually written with the
 * qualified name while a code graph reports whichever form its parser emits.
 * Matching is anchored at a separator, so `Foo.run` does not match `Bar.run` —
 * a bare tail comparison would make every `run`/`handle`/`init` collide.
 */
export function symbolMatches(nodeSymbol: string, target: string): boolean {
  const a = nodeSymbol.trim().toLowerCase();
  const b = target.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  return ["." , "#", "::"].some(sep => a.endsWith(sep + b) || b.endsWith(sep + a));
}

export interface NodeHit {
  node: GraphNode;
  /** Why this node fired, so the agent can weigh a direct hit against a distant one. */
  reasons: string[];
  /** True when the node is anchored to something being edited, not merely reachable from it. */
  direct: boolean;
}

/**
 * Match memory nodes against an edit and, optionally, its blast radius.
 *
 * simplegraph deliberately does not compute the blast radius itself — parsing
 * call graphs is what a structural code graph (codebase-memory-mcp,
 * code-review-graph, Graphify, or a plain grep) already does well. The caller
 * expands the edit into the surrounding `related_files` / `related_symbols` and
 * this function supplies the part those tools cannot: whether anything in that
 * radius has a recorded history.
 *
 * Direct hits are ranked above transitive ones so a widened radius adds context
 * without burying the file actually being edited.
 */
export function matchNodes(
  nodes: GraphNode[],
  scope: {
    files?: string[];
    symbols?: string[];
    related_files?: string[];
    related_symbols?: string[];
  }
): NodeHit[] {
  const files = scope.files ?? [];
  const symbols = scope.symbols ?? [];
  const relatedFiles = scope.related_files ?? [];
  const relatedSymbols = scope.related_symbols ?? [];

  const list = (xs: string[]) => xs.map(x => `\`${x}\``).join(", ");

  const hits: NodeHit[] = [];
  for (const node of nodes) {
    const byFile = (targets: string[]) =>
      node.files.filter(nf => targets.some(t => pathMatches(nf, t)));
    const byOwnedPath = (targets: string[]) =>
      node.paths.filter(np => targets.some(t => pathUnderDir(np, t)));
    const bySymbol = (targets: string[]) =>
      node.symbols.filter(ns => targets.some(t => symbolMatches(ns, t)));

    const directFiles = byFile(files);
    const directPaths = byOwnedPath(files);
    const directSymbols = bySymbol(symbols);

    // Subtract the direct matches so a node anchored to both an edited file and
    // a radius file is reported once, at its strongest reason.
    const radiusFiles = byFile(relatedFiles).filter(f => !directFiles.includes(f));
    const radiusPaths = byOwnedPath(relatedFiles).filter(p => !directPaths.includes(p));
    const radiusSymbols = bySymbol(relatedSymbols).filter(x => !directSymbols.includes(x));

    const reasons: string[] = [];
    if (directFiles.length)   reasons.push(`edited file ${list(directFiles)}`);
    if (directSymbols.length) reasons.push(`edited symbol ${list(directSymbols)}`);
    if (directPaths.length)   reasons.push(`owns path ${list(directPaths)}`);
    if (radiusFiles.length)   reasons.push(`blast radius — file ${list(radiusFiles)}`);
    if (radiusSymbols.length) reasons.push(`blast radius — symbol ${list(radiusSymbols)}`);
    if (radiusPaths.length)   reasons.push(`blast radius — owns path ${list(radiusPaths)}`);

    if (!reasons.length) continue;
    const direct = Boolean(directFiles.length || directSymbols.length || directPaths.length);
    hits.push({ node, reasons, direct });
  }

  const rank = (h: NodeHit) => (h.direct ? 0 : 2) + (h.node.priority === "HIGH" ? 0 : 1);
  return hits.sort((a, b) => rank(a) - rank(b));
}

/**
 * Insert `line` immediately after the `**<anchor>:**` field of an isolated node
 * block, falling back to the end of the block when that anchor is absent.
 * Operates on an already-isolated block (see findNodeBlock), so it cannot reach
 * into a neighbouring node.
 */
function insertAfterField(block: string, anchor: string, line: string): string {
  const pattern = new RegExp(`(\\*\\*${escapeRe(anchor)}:\\*\\*[^\\n]*)`);
  if (pattern.test(block)) {
    return block.replace(pattern, (_m, p1: string) => `${p1}\n${line}`);
  }
  return `${block.replace(/\s*$/, "")}\n${line}\n`;
}

// Insert or update the **RootCause:** field within a single node's block.
// Placed immediately after **REGRESSED_N_TIMES:** to keep format consistent.
// Operates on an already-isolated block (see findNodeBlock), so it cannot reach
// into a neighbouring node.
function insertRootCause(block: string, rootCause: string): string {
  if (/\*\*RootCause:\*\*/.test(block)) {
    return block.replace(/\*\*RootCause:\*\*[^\n]*/, () => `**RootCause:** ${rootCause}`);
  }
  return block.replace(
    /\*\*REGRESSED_N_TIMES:\*\*[^\n]*/,
    (m) => `${m}\n**RootCause:** ${rootCause}`
  );
}

// ── Exported handler functions (testable with any graphRoot) ──────────────────

export function handleUpdateNode(
  args: { id: string; field: string; value: string; root_cause?: string },
  graphRoot: string,
  sharedRoot: string | null = null
): ToolResult {
  // Hold the graph lock across the whole read-modify-write. Without it, two
  // agents incrementing REGRESSED_N_TIMES can both read N and both write N+1,
  // losing a recurrence — the one count the graph most needs to keep.
  return withGraphLock(graphRoot, () => handleUpdateNodeLocked(args, graphRoot, sharedRoot));
}

function handleUpdateNodeLocked(
  args: { id: string; field: string; value: string; root_cause?: string },
  graphRoot: string,
  sharedRoot: string | null
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
  const content = fs.readFileSync(filePath, "utf-8");

  // Isolate this node's block up front. Every edit below applies to `block`
  // only, so no update can leak into an adjacent or prefix-sharing node.
  const loc = findNodeBlock(content, id);
  if (!loc) {
    return fail(`Could not locate the "## NODE: ${id}" heading in ${node.sourceFile}.`);
  }
  let block = loc.block;

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
    block = block.replace(/(\*\*REGRESSED_N_TIMES:\*\*[ \t]*)\d+/, (_m, p1: string) => `${p1}${next}`);

    // Auto-upgrade priority to HIGH at >= 2
    if (next >= 2) {
      block = block.replace(/(\*\*Priority:\*\*[ \t]*)\S+/, (_m, p1: string) => `${p1}HIGH`);
    }

    // Write root_cause into the node when provided
    const rc = root_cause?.trim();
    if (rc) {
      block = insertRootCause(block, rc);
    }

    atomicWriteFileSync(filePath, loc.before + block + loc.after);

    const upgraded = next >= 2 ? " (Priority auto-upgraded to HIGH)" : "";
    const gateNote = rc ? ". Root-Cause Gate satisfied — RootCause field written." : ".";
    return ok(`✓ REGRESSED_N_TIMES for ${id}: ${current} → ${next}${upgraded}${gateNote}`);
  }

  // Generic field update. `field` is escaped because it reaches the regex from
  // tool input; the replacement uses a function so `$&`-style sequences in the
  // new value are inserted literally rather than re-expanded.
  const fieldPattern = new RegExp(`(\\*\\*${escapeRe(field)}:\\*\\*[ \\t]*).+`);
  if (!fieldPattern.test(block)) {
    // Symbols and Paths are emitted only when populated, so every node written
    // before they existed lacks the line entirely. Refusing the update there
    // would make an existing graph un-anchorable without hand-editing every
    // node, so insert the field instead — after **Files:**, matching the order
    // formatNode produces.
    if (field === "Symbols" || field === "Paths") {
      // Keep formatNode's field order: Files, Symbols, Paths.
      const anchor = field === "Paths" && /\*\*Symbols:\*\*/.test(block) ? "Symbols" : "Files";
      block = insertAfterField(block, anchor, `**${field}:** ${resolvedValue}`);
      atomicWriteFileSync(filePath, loc.before + block + loc.after);
      return ok(`✓ Added **${field}** to NODE: ${id} → "${resolvedValue}" in ${node.sourceFile}.`);
    }
    return fail(`Field **${field}:** not found in NODE: ${id}. Check the field name.`);
  }
  block = block.replace(fieldPattern, (_m, p1: string) => `${p1}${resolvedValue}`);
  atomicWriteFileSync(filePath, loc.before + block + loc.after);
  return ok(`✓ Updated **${field}** for NODE: ${id} → "${resolvedValue}" in ${node.sourceFile}.`);
}

export function handleAddNode(
  args: {
    type: string; id: string; label: string; summary: string; priority: string;
    tags?: string[]; files?: string[]; symbols?: string[]; paths?: string[];
    edges?: string[];
    regressedNTimes?: number; root_cause?: string;
    author?: string; session?: string;
  },
  graphRoot: string,
  sharedRoot: string | null = null
): ToolResult {
  const { type, id, regressedNTimes, root_cause } = args;

  // Gate: creating a Regression with regressedNTimes >= 2 (re-importing history) requires root_cause
  if (type.toLowerCase() === "regression" && regressedNTimes !== undefined && regressedNTimes >= 2) {
    const rc = root_cause?.trim();
    if (!rc) {
      return ok(buildGateMessage(id, regressedNTimes));
    }
  }

  // Serialize the read-check-append against other writers so two agents can't
  // both pass the ID-uniqueness check and append a colliding node.
  return withGraphLock(graphRoot, () => handleAddNodeLocked(args, graphRoot, sharedRoot));
}

function handleAddNodeLocked(
  args: {
    type: string; id: string; label: string; summary: string; priority: string;
    tags?: string[]; files?: string[]; symbols?: string[]; paths?: string[];
    edges?: string[];
    regressedNTimes?: number; root_cause?: string;
    author?: string; session?: string;
  },
  graphRoot: string,
  sharedRoot: string | null
): ToolResult {
  const {
    type, id, label, summary, priority,
    tags = [], files = [], symbols = [], paths = [], edges = [], regressedNTimes, root_cause,
    author, session,
  } = args;

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
  const resolvedAuthor = author?.trim() || DEFAULT_AUTHOR;
  const resolvedSession = session?.trim() || DEFAULT_SESSION;
  const nodeText = formatNode({
    id, type, priority, label, summary, tags, files, symbols, paths, edges,
    lastUpdated: today, regressedNTimes, rootCause: rc,
    author: resolvedAuthor, session: resolvedSession,
  });
  const targetFile = targetFileForType(type, id);
  const existingContent = readGraphFile(targetFile, graphRoot);

  writeGraphFile(
    targetFile,
    existingContent
      ? `${existingContent.trimEnd()}\n\n---\n\n${nodeText}\n`
      : `${nodeText}\n`,
    graphRoot
  );

  // The Quick Index is derived: regenerate it from the nodes rather than
  // appending, so the index stays deterministic and merge-conflict-free across
  // parallel agents. Best-effort — a missing index shouldn't fail the add.
  const index = regenerateIndex(graphRoot);
  const attrib = resolvedAuthor ? ` (author: ${resolvedAuthor}${resolvedSession ? `, session: ${resolvedSession}` : ""})` : "";
  const indexNote = index.warnings.length
    ? `\n⚠ Index: ${index.warnings.join("; ")}`
    : `\n✓ graph_index.md regenerated (${index.total} node(s) indexed).`;

  return ok(
    `✓ Added NODE: ${id} to ${targetFile}${attrib}.${indexNote}\n\n` +
    `Next steps:\n` +
    `1. Run bash core/scripts/consistency_check.sh to verify no broken edges (or duplicate IDs).\n` +
    `2. Commit both the code change and the graph update together.`
  );
}

/**
 * Offer commits that may record a decision the graph is missing.
 *
 * The judgment — is there actually a rationale here — belongs to the calling
 * agent, which already has a model. This only does the deterministic half:
 * mine history, rank by how likely a rationale is, and drop anything already
 * written so repeated calls converge instead of duplicating.
 */
export function handleSeedCandidates(
  args: { limit?: number; max_commits?: number },
  graphRoot: string,
  sharedRoot: string | null = null
): ToolResult {
  const { limit = 10 } = args;

  // Mining cost is linear in the window and dominated by parsing per-commit
  // file lists: ~1ms per commit on a typical repo, but ~5ms on one the size of
  // DuckDB, where 10,000 commits takes 50s and 110MB. This is an interactive
  // tool call, so the window is capped rather than left to the caller. `sg seed`
  // is uncapped — a batch run can afford to wait.
  const MAX_WINDOW = 2000;
  const requested = args.max_commits ?? 500;
  const max_commits = Math.min(requested, MAX_WINDOW);
  // The graph lives at <repo>/core, so its parent is the repository.
  const repoRoot = path.dirname(graphRoot);
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    return fail(`No git repository found at ${repoRoot}. Decision candidates are mined from commit history.`);
  }

  const ctx = buildContext(repoRoot, { maxCommits: max_commits });
  const nodes = [
    ...getNodesFromRoot(graphRoot),
    ...(sharedRoot ? getNodesFromRoot(sharedRoot, "shared") : []),
  ];
  const known = new Set(nodes.map(n => n.id));

  // Selection is in-memory and cheap, so rank the whole history and slice here.
  // Capping the selection instead would make "candidates remaining" report only
  // what happened to fall inside a fetch window.
  const windowNote = requested > MAX_WINDOW
    ? `\n\n_Window capped at ${MAX_WINDOW} commits (you asked for ${requested}) to keep this ` +
      `call responsive. Use \`sg seed\` for a full-history pass._`
    : "";

  const { candidates } = selectDecisionCandidates(ctx, Number.MAX_SAFE_INTEGER);
  const fresh = candidates.filter(c => !known.has(decisionIdFor(c)));
  const batch = fresh.slice(0, limit);

  if (batch.length === 0) {
    // Two very different situations, and conflating them misleads: a graph that
    // is caught up, versus a history that never recorded rationale in the first
    // place. Vizro squash-merges pull requests, so 1,192 of its 1,284 non-merge
    // commits have no prose body at all and the honest answer is "look elsewhere".
    if (candidates.length === 0) {
      const prs = pullRequestTrail(ctx);
      // The reasoning is not gone, just upstream. Point at it rather than
      // fetching it: that needs GitHub credentials, which the calling agent
      // generally has and simplegraph deliberately does not.
      const trail = prs.worthReading.length > 0
        ? `\n\n${prs.total} of those commits name a pull request, so the reasoning is most ` +
          `likely in the PR descriptions. If you have GitHub access (a GitHub MCP server, a web ` +
          `fetch tool, or \`gh pr view <n>\`), read some of these and write any real decisions ` +
          `with simplegraph_add_node.\n\n` +
          `These are filtered — docs, release and CI changes are excluded — but NOT ranked by ` +
          `importance: which PR holds a rationale is in text this tool cannot read. Treat it as ` +
          `a sample, and search the PRs directly if you are looking for something specific.\n` +
          prs.worthReading.map(s => `  #${s.number}  ${s.date}  ${s.subject}`).join("\n") +
          (prs.more > 0 ? `\n  …and ${prs.more} more worth reading` : "")
        : `\n\nDecisions here have to come from you or from reading the code — call ` +
          `simplegraph_add_node directly.`;

      return ok(
        `No decision candidates in ${ctx.commits.length} mined commit(s): no commit message ` +
        `in this history records why a change was made.` + trail + windowNote
      );
    }
    return ok(
      `✓ No new decision candidates. Of ${candidates.length} commit(s) in ${ctx.commits.length} ` +
      `that state a rationale, all are already represented in the graph.` + windowNote
    );
  }

  // Filtering by derived ID only catches nodes this tool created. A graph built
  // by hand uses its own names — Zerofeed's 66 Decision nodes share no ID with
  // anything derivable from a commit — so without this list the agent would be
  // asked to re-record decisions the graph already holds under another name.
  const existing = nodes
    .filter(n => n.type.toLowerCase() === "decision")
    .map(n => `- ${n.id}: ${n.label}`)
    .sort();
  const alreadyRecorded = existing.length
    ? `**Decisions already in the graph — skip any candidate these already cover:**\n` +
      existing.slice(0, 80).join("\n") +
      (existing.length > 80 ? `\n…and ${existing.length - 80} more` : "") + "\n\n"
    : "";

  // A commit that edited the graph in the same change very likely recorded its
  // own decision already — on Zerofeed this was true of 3 of the first 4
  // candidates reviewed. Flag it per-candidate rather than filtering, so the
  // agent checks instead of losing a real decision to a heuristic.
  const editsGraph = (c: { files: string[] }) =>
    c.files.some(f => /(^|\/)core\/[\w-]+\.md$/.test(f));

  // Reviewing 14 Zerofeed candidates by hand, 6 were already recorded under a
  // hand-chosen name. Title overlap points at the specific match instead of
  // making the agent scan every existing label; at this threshold it caught the
  // exact restatements ("F-02 …", "…(§2.3)") with no false positives.
  const STOPWORDS = new Set(
    "the a an of to in for on and or is are be with via using new add adds added fix fixes fixed feat chore refactor test docs security e2e make into from at by".split(" ")
  );
  const tokens = (text: string) =>
    new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
      .filter(w => w.length > 2 && !STOPWORDS.has(w)));

  const decisionLabels = nodes.filter(n => n.type.toLowerCase() === "decision");
  const likelyDuplicate = (subject: string): GraphNode | undefined => {
    const a = tokens(subject);
    let best: { score: number; node?: GraphNode } = { score: 0 };
    for (const n of decisionLabels) {
      const b = tokens(n.label);
      if (!a.size || !b.size) continue;
      const shared = [...a].filter(w => b.has(w)).length;
      const score = shared / Math.min(a.size, b.size);
      if (score > best.score) best = { score, node: n };
    }
    return best.score >= 0.7 ? best.node : undefined;
  };

  const blocks = batch.map(c => [
    `### ${decisionIdFor(c)}`,
    `**Commit:** ${c.shortSha} (${c.authorDate})`,
    `**Subject:** ${c.subject}`,
    ...(editsGraph(c)
      ? ["**⚠ This commit also edited the graph — its decision is probably already recorded. Check before adding.**"]
      : []),
    ...(likelyDuplicate(c.subject)
      ? [`**⚠ Probably already recorded as ${likelyDuplicate(c.subject)!.id} — "${likelyDuplicate(c.subject)!.label}". Check before adding.**`]
      : []),
    `**Files:** ${c.files.slice(0, 8).map(f => `\`${f}\``).join(", ") || "_(none)_"}`,
    `**Message body:**`,
    "```",
    // Bounded so a batch cannot blow up the caller's context window.
    c.body.length > 1200 ? c.body.slice(0, 1200) + "\n…(truncated)" : c.body,
    "```",
  ].join("\n"));

  const remaining = fresh.length - batch.length;
  return ok(
    `${batch.length} decision candidate(s) from ${ctx.commits.length} mined commit(s).\n\n` +
    `Read each one and decide whether it states WHY, not just what changed. Skip the ones\n` +
    `that don't — do not invent a rationale. For each one that qualifies, call:\n` +
    `  simplegraph_add_node({type:"Decision", id:<the id below>, label, summary, priority,\n` +
    `                        files, tags:["seeded","decision"]})\n\n` +
    alreadyRecorded +
    `${blocks.join("\n\n---\n\n")}\n\n` +
    (remaining > 0
      ? `_${remaining} further candidate(s) available — call again after writing these._\n`
      : `_That is every remaining candidate._\n`) + windowNote
  );
}

// ── MCP Server ────────────────────────────────────────────────────────────────

/** Single source for the version this server reports and prints. */
const SERVER_VERSION = "0.5.0";

const server = new Server(
  { name: "simplegraph-mcp", version: SERVER_VERSION },
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
        "invariants that reference the code you plan to modify. Prevents reintroducing " +
        "known bugs and flags high-risk code areas.\n\n" +
        "EXPAND FIRST FOR BEST RESULTS. A bug is often recorded against the caller, not " +
        "the line you are changing. If you have a structural code graph available " +
        "(codebase-memory-mcp, code-review-graph, Graphify, an LSP, or even `grep -r` for " +
        "the symbol), use it FIRST to find the callers, dependents, and tests affected by " +
        "your edit, then pass those in `related_files` / `related_symbols`. This server " +
        "does not compute the blast radius itself — it tells you which parts of the radius " +
        "you supply have a recorded history. Results are grouped: directly affected nodes " +
        "first, then nodes reached through the radius.",
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "File paths you plan to modify (relative paths, basenames, or full paths all work)",
          },
          symbols: {
            type: "array",
            items: { type: "string" },
            description:
              "Symbols you plan to modify, qualified or bare (e.g. 'AuthService.refreshToken' or 'refreshToken'). " +
              "Matches nodes anchored to a symbol even after the file was renamed.",
          },
          related_files: {
            type: "array",
            items: { type: "string" },
            description:
              "Blast radius: files that call, depend on, or test what you are editing — as reported by " +
              "your structural code graph. Matches here are reported separately from direct hits.",
          },
          related_symbols: {
            type: "array",
            items: { type: "string" },
            description:
              "Blast radius: callers and dependents of the symbols you are editing, as reported by " +
              "your structural code graph.",
          },
        },
        required: [],
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
          symbols:         { type: "array", items: { type: "string" }, description: "Affected symbols — functions, classes, or methods (e.g. ['AuthService.refreshToken']). Anchoring to a symbol as well as a file keeps the node matchable after a rename, and lets it fire when a caller is edited." },
          paths:           { type: "array", items: { type: "string" }, description: "Directory prefixes this node owns (e.g. ['src/auth']). Mainly for Component nodes: any file beneath an owned path matches. Keep these coarse — a directory, not a file." },
          edges:           { type: "array", items: { type: "string" }, description: "Edge strings: 'VIOLATED_BY → INV_X: explanation'" },
          regressedNTimes: { type: "number", description: "For Regression nodes: how many times this has occurred" },
          root_cause:      { type: "string", description: "Required when regressedNTimes ≥ 2. Must answer: (1) authoritative source of truth, (2) specific invariant violated, (3) why prior fixes were symptomatic." },
          author:          { type: "string", description: "Who is creating this node (agent/tool name or human). For multi-agent attribution. Defaults to the SIMPLEGRAPH_AUTHOR env var if unset." },
          session:         { type: "string", description: "Session identifier this node was created in. Helps arbitrate concurrent writes from different agents. Defaults to the SIMPLEGRAPH_SESSION env var if unset." },
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
            enum: ["Label", "Summary", "Priority", "Tags", "LastUpdated", "REGRESSED_N_TIMES", "Files", "Symbols", "Paths"],
            description:
              "Field to update. Symbols and Paths are inserted if the node does not have them yet, " +
              "so nodes written before those fields existed can be anchored without a rewrite.",
          },
          value: {
            type: "string",
            description:
              "New value. For REGRESSED_N_TIMES, use 'increment' to add 1. For LastUpdated, use 'today'. " +
              "For Files, Symbols, and Paths, pass a comma-separated list with each entry in backticks, " +
              "e.g. '`src/auth/token.ts`, `src/auth/session.ts`' — unbackticked entries parse as empty.",
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
      name: "simplegraph_seed_candidates",
      description:
        "Find commits that may record an architectural DECISION the graph is missing, so you " +
        "can write the good ones as Decision nodes. Use this when bootstrapping a graph, or " +
        "periodically to catch up after a batch of work.\n\n" +
        "Returns commits whose message body plausibly contains a rationale, together with that " +
        "body and a pre-computed node ID. Commits whose node already exists are never returned, " +
        "so calling this repeatedly converges rather than duplicating.\n\n" +
        "For each candidate, decide whether the message actually states WHY — why this approach, " +
        "what it was chosen over, or what problem it avoids. If it only describes WHAT changed, " +
        "however large the change, SKIP IT. Do not infer, guess, or reconstruct a reason that is " +
        "not written down: a missing node is much better than an invented one, because other " +
        "agents load these nodes as guidance. Expect to skip many candidates.\n\n" +
        "For the ones that qualify, call simplegraph_add_node with type='Decision', the id given " +
        "here, a summary in the author's own terms, and the listed files.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum candidates to return (default 10). Keep small; review in batches.",
          },
          max_commits: {
            type: "number",
            description: "How far back to mine history (default 500, capped at 2000 to keep the call responsive).",
          },
        },
      },
    },
    {
      name: "simplegraph_update_index",
      description:
        "Regenerate the graph_index.md Quick Index from the current nodes. " +
        "simplegraph_add_node already does this automatically; call this directly only after " +
        "a manual edit, a git merge, or an archive, to bring the index back in sync. " +
        "The index is derived from the node files — regenerating (not appending) keeps it " +
        "deterministic and merge-conflict-free across parallel agents. The id/type/file " +
        "arguments are optional and only used for the confirmation message.",
      inputSchema: {
        type: "object",
        properties: {
          id:   { type: "string", description: "(Optional) Node ID just added — for the confirmation message only." },
          type: { type: "string", enum: ["Component", "Invariant", "Regression", "Decision", "Watchlist"] },
          file: { type: "string", description: "(Optional) Relative path to the node's file — for the confirmation message only." },
        },
      },
    },
    {
      name: "simplegraph_reindex",
      description:
        "Regenerate graph_index.md's Quick Index from the current node files. Use after a git " +
        "merge (where two branches both touched the index) or any manual edit to node files. " +
        "Because the index is fully derived and node IDs are sorted, the result is identical " +
        "regardless of the order nodes were added — the intended way to resolve index merge conflicts.",
      inputSchema: { type: "object", properties: {} },
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
        const {
          files = [], symbols = [], related_files = [], related_symbols = [],
        } = args as {
          files?: string[]; symbols?: string[];
          related_files?: string[]; related_symbols?: string[];
        };
        if (!files.length && !symbols.length && !related_files.length && !related_symbols.length)
          return ok("No files provided.");

        const hits = matchNodes(getAllNodes(), { files, symbols, related_files, related_symbols });

        if (!hits.length) {
          const scope = related_files.length || related_symbols.length
            ? " (including the blast radius you supplied)"
            : "";
          return ok(`✓ No known issues for these files${scope}. Proceed carefully.`);
        }

        const direct = hits.filter(h => h.direct);
        const transitive = hits.filter(h => !h.direct);
        const high = hits.filter(h => h.node.priority === "HIGH");

        const overflow = (shown: number, total: number, what: string) =>
          total > shown
            ? `\n\n_${total - shown} further ${what} not shown (ranked lower). ` +
              `Narrow the radius, or list them with simplegraph_search._`
            : "";

        const sections: string[] = [];

        if (direct.length) {
          // Nothing on the direct path is ever dropped: past the detail limit the
          // remainder is digested rather than hidden. A node you are editing that
          // silently fails to appear is the failure this tool exists to prevent.
          const full = direct.slice(0, DIRECT_DETAIL_LIMIT);
          const rest = direct.slice(DIRECT_DETAIL_LIMIT);
          sections.push(
            `## Directly affected (${direct.length})\n\n` +
            full.map(h => `**Matched on:** ${h.reasons.join("; ")}\n${summarizeNodes([h.node])}`)
                .join("\n\n---\n\n") +
            (rest.length
              ? `\n\n### Also directly affected (${rest.length}, summarized)\n\n${digestNodes(rest)}`
              : "")
          );
        }

        if (transitive.length) {
          const shown = transitive.slice(0, RADIUS_DIGEST_LIMIT);
          sections.push(
            `## In the blast radius (${transitive.length}, not edited directly)\n\n` +
            `Anchored to code that depends on — or is depended on by — what you are editing. ` +
            `Summarized; call \`simplegraph_get_node <ID>\` for a full record.\n\n` +
            digestNodes(shown) +
            overflow(shown.length, transitive.length, "blast-radius node(s)")
          );
        }

        return ok(
          `⚠ Found ${hits.length} node(s)` +
          (high.length ? ` (${high.length} HIGH priority)` : "") +
          `:\n\n${sections.join("\n\n")}`
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
          const haystack = [
            n.id, n.label, n.summary,
            ...n.tags, ...n.files, ...n.symbols, ...n.paths, ...n.edges,
          ].join(" ").toLowerCase();
          return terms.every(t => haystack.includes(t));
        });
        if (!hits.length) return ok(`No nodes found matching "${query}".`);
        return ok(`Found ${hits.length} node(s) matching "${query}":\n\n${summarizeNodes(hits)}`);
      }

      case "simplegraph_add_node": {
        const {
          type, id, label, summary, priority,
          tags, files, symbols, paths, edges, regressedNTimes, root_cause, author, session,
        } = args as {
          type: string; id: string; label: string; summary: string;
          priority: string; tags?: string[]; files?: string[];
          symbols?: string[]; paths?: string[]; edges?: string[];
          regressedNTimes?: number; root_cause?: string; author?: string; session?: string;
        };
        return handleAddNode(
          { type, id, label, summary, priority, tags, files, symbols, paths, edges, regressedNTimes, root_cause, author, session },
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
          // Lock the read-append so two agents don't clobber each other's notes.
          return withGraphLock(GRAPH_ROOT, () => {
            const existing = readGraphFile(scratchFile);
            const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
            writeGraphFile(scratchFile, `${existing}${existing ? "\n" : ""}<!-- ${ts} -->\n${text}\n`);
            return ok("✓ Appended to scratchpad.");
          });
        }
        if (action === "clear") {
          writeGraphFile(scratchFile, "");
          return ok("✓ Scratchpad cleared.");
        }
        return fail(`Unknown action: ${action}. Use 'read', 'append', or 'clear'.`);
      }

      case "simplegraph_archive_regression": {
        const { id, resolution } = args as { id: string; resolution?: string };
        // Lock: removing a node from one file and appending to another is a
        // multi-file mutation that must not interleave with other writers.
        return withGraphLock(GRAPH_ROOT, () => {
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
            files: node.files, symbols: node.symbols, paths: node.paths,
            edges: node.edges,
            lastUpdated: today, regressedNTimes: node.regressedNTimes,
            rootCause: node.rootCause, author: node.author, session: node.session,
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

          // The regression left the active set — regenerate the index to drop it.
          const index = regenerateIndex(GRAPH_ROOT);
          const indexNote = index.warnings.length
            ? `\n⚠ Index: ${index.warnings.join("; ")}`
            : `\n✓ graph_index.md regenerated — ${id} no longer in Active Regressions.`;

          return ok(
            `✓ Archived NODE: ${id} → archive/resolved_regressions.md.${indexNote}\n\n` +
            `Next step: commit the archive alongside your fix.`
          );
        });
      }

      case "simplegraph_seed_candidates": {
        const { limit, max_commits } = args as { limit?: number; max_commits?: number };
        return handleSeedCandidates({ limit, max_commits }, GRAPH_ROOT, SHARED_ROOT);
      }

      case "simplegraph_update_index":
      case "simplegraph_reindex": {
        const { id } = args as { id?: string };
        return withGraphLock(GRAPH_ROOT, () => {
          const index = regenerateIndex(GRAPH_ROOT);
          if (index.warnings.length && index.total === 0) {
            return fail(index.warnings.join("; "));
          }
          const breakdown = index.rows.map(r => `${r.label}: ${r.count}`).join(", ");
          const suffix = index.warnings.length ? `\n⚠ ${index.warnings.join("; ")}` : "";
          const lead = id ? `✓ Regenerated graph_index.md (${id} included). ` : "✓ Regenerated graph_index.md. ";
          return ok(`${lead}${index.total} node(s) indexed — ${breakdown}.${suffix}`);
        });
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
    `simplegraph-mcp v${SERVER_VERSION} ready\n` +
    `  GRAPH_ROOT:  ${GRAPH_ROOT}\n` +
    (SHARED_ROOT ? `  SHARED_ROOT: ${SHARED_ROOT}\n` : "") +
    (DEFAULT_AUTHOR ? `  AUTHOR:      ${DEFAULT_AUTHOR}\n` : "") +
    (DEFAULT_SESSION ? `  SESSION:     ${DEFAULT_SESSION}\n` : "")
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
