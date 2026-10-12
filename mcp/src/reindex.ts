// simplegraph-agentic: regenerate graph_index.md's Quick Index from the nodes.
//
// The Quick Index is a *derived* view — the node files are the source of truth.
// Treating it as derived is what makes it survive multi-agent development: two
// branches that each append a node both edit the same index rows and conflict
// on nearly every merge. When the index is regenerated instead, the merge
// resolution is mechanical ("take either side, then rerun reindex") and the
// result is identical regardless of the order nodes were added.
//
// Regeneration rewrites ONLY the node-type rows of the Quick Index table. The
// header, Multi-Repo note, Anti-Patterns/Resolved pointer rows, and the whole
// hand-authored Task Routing section are left untouched.
//
// DERIVED MODE (opt-in). Persisting the derived rows still conflicts: each row
// holds every node of its type on ONE line, so any two branches that add a node
// of the same type collide there, and a hosted merge button cannot run
// `reindex` to settle it. A graph whose graph_index.md contains DERIVED_MARKER
// never stores the rows or the LastUpdated date: the file keeps placeholders,
// writes leave it alone, and readers (`simplegraph_index`, `simplegraph index`)
// render the rows from the nodes on demand. Only hand-authored text is
// committed, so node additions never touch the index at all.

import * as fs from "fs";
import * as path from "path";
import { parseNodes, type GraphNode } from "./parser.js";
import { atomicWriteFileSync } from "./fsutil.js";

const MULTI_NODE_FILES = ["regressions.md", "invariants.md", "decisions.md", "watchlists.md", "anti_patterns.md"];

// Quick Index row label → node type it enumerates.
const ROW_FOR_TYPE: Record<string, string> = {
  component: "Components",
  invariant: "Invariants",
  regression: "Active Regressions",
  decision: "Decisions",
  watchlist: "Watchlists & Open Issues",
  antipattern: "Anti-Patterns",
};

export interface ReindexResult {
  rows: { label: string; count: number }[];
  total: number;
  warnings: string[];
  /** True when the graph is in derived mode: nothing derived was written. */
  derived?: boolean;
}

/** A graph_index.md containing this line is rendered on read, never persisted. */
export const DERIVED_MARKER = "<!-- simplegraph:index=derived -->";
/** What a derived-mode index stores in place of each row's node list and the date. */
export const DERIVED_PLACEHOLDER = "_(derived — rendered on read)_";

export function isDerivedIndex(content: string): boolean {
  return content.includes(DERIVED_MARKER);
}

function rowPatternFor(label: string): RegExp {
  // Match a table row `| **<label>** | <nodes> | <file> |` and capture the
  // middle (nodes) cell. Escape the label defensively (it may contain &).
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(\\|\\s*\\*\\*${escaped}\\*\\*\\s*\\|)([^|]*)(\\|)`, "i");
}

const LAST_UPDATED = /(>\s*\*\*LastUpdated:\*\*\s*)[^\r\n]+/i;

/**
 * The stored form of a derived-mode index: each node-type row's node cell (all
 * but Anti-Patterns) and the LastUpdated date replaced by DERIVED_PLACEHOLDER. Pure and idempotent, so
 * every branch stores byte-identical derived content and nothing can conflict.
 */
export function stripDerivedContent(content: string): string {
  let out = content;
  for (const [type, label] of Object.entries(ROW_FOR_TYPE)) {
    // The Anti-Patterns row often holds a hand-written pointer, which rendering
    // keeps when there are no anti-pattern nodes, so it is not ours to blank.
    if (type === "antipattern") continue;
    out = out.replace(rowPatternFor(label), (_s, prefix, _mid, suffix) => `${prefix} ${DERIVED_PLACEHOLDER} ${suffix}`);
  }
  return out.replace(LAST_UPDATED, `$1${DERIVED_PLACEHOLDER}`);
}

/** Load every node in a graph root (the four list files plus components/). */
export function loadAllNodes(graphRoot: string): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const f of MULTI_NODE_FILES) {
    const p = path.join(graphRoot, f);
    if (fs.existsSync(p)) nodes.push(...parseNodes(fs.readFileSync(p, "utf-8"), f));
  }
  const compDir = path.join(graphRoot, "components");
  if (fs.existsSync(compDir)) {
    for (const file of fs.readdirSync(compDir).sort()) {
      if (!file.endsWith(".md")) continue;
      const rel = `components/${file}`;
      nodes.push(...parseNodes(fs.readFileSync(path.join(compDir, file), "utf-8"), rel));
    }
  }
  return nodes;
}

/**
 * Render the node-ID cell for one category. IDs are sorted for a stable,
 * order-independent result; a regression that has recurred (REGRESSED_N_TIMES
 * ≥ 2) is annotated `(×N)` so the heat is visible without opening the file.
 */
function renderCell(nodes: GraphNode[]): string {
  if (nodes.length === 0) return "_(none)_";
  return nodes
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(n => {
      const n2 = n.regressedNTimes ?? 0;
      return n2 >= 2 ? `${n.id}(×${n2})` : n.id;
    })
    .join(", ");
}

/**
 * Regenerate the Quick Index rows in `graph_index.md` from the current nodes.
 * Pure string transform over the file content — no I/O — so it is trivially
 * testable and callable from both the CLI and the MCP server.
 */
export function regenerateIndexContent(content: string, nodes: GraphNode[]): { content: string; result: ReindexResult } {
  const byType = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const key = n.type.toLowerCase();
    if (!ROW_FOR_TYPE[key]) continue;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key)!.push(n);
  }

  const result: ReindexResult = { rows: [], total: 0, warnings: [] };
  let out = content;

  for (const [type, label] of Object.entries(ROW_FOR_TYPE)) {
    const group = byType.get(type) ?? [];
    result.rows.push({ label, count: group.length });
    result.total += group.length;

    if (type === "antipattern" && group.length === 0) {
      continue;
    }

    // Rewrite only the middle (nodes) cell of the row.
    const rowPattern = rowPatternFor(label);
    if (!rowPattern.test(out)) {
      result.warnings.push(`Quick Index row "${label}" not found — ${group.length} node(s) not listed`);
      continue;
    }
    const cell = renderCell(group);
    out = out.replace(rowPattern, (_s, prefix, _mid, suffix) => `${prefix} ${cell} ${suffix}`);
  }

  // Update header > **LastUpdated:** <date> if present
  const dates = nodes
    .map(n => n.lastVerified || n.lastUpdated)
    .filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length > 0) {
    const latestDate = dates.sort().reverse()[0];
    out = out.replace(LAST_UPDATED, `$1${latestDate}`);
  }

  return { content: out, result };
}

/** Regenerate the Quick Index in place. Returns per-row counts and warnings. */
export function regenerateIndex(graphRoot: string): ReindexResult {
  const indexPath = path.join(graphRoot, "graph_index.md");
  if (!fs.existsSync(indexPath)) {
    return { rows: [], total: 0, warnings: [`graph_index.md not found at ${indexPath} — nothing to reindex`] };
  }
  const nodes = loadAllNodes(graphRoot);
  const stored = fs.readFileSync(indexPath, "utf-8");
  const { content, result } = regenerateIndexContent(stored, nodes);
  if (isDerivedIndex(stored)) {
    // Derived mode: keep the stored file free of derived content. Normally a
    // no-op; it only writes to scrub rows someone filled in by hand.
    const normalized = stripDerivedContent(stored);
    if (normalized !== stored) atomicWriteFileSync(indexPath, normalized);
    return { ...result, derived: true };
  }
  atomicWriteFileSync(indexPath, content);
  return result;
}

/**
 * graph_index.md as a reader should see it: the stored file with the Quick
 * Index rows and LastUpdated filled in from the current nodes. Never writes.
 * In derived mode this is the only place the rows exist; in persisted mode it
 * matches the file whenever the file is current. Null when there is no index.
 */
export function renderIndex(graphRoot: string): string | null {
  const indexPath = path.join(graphRoot, "graph_index.md");
  if (!fs.existsSync(indexPath)) return null;
  const { content } = regenerateIndexContent(fs.readFileSync(indexPath, "utf-8"), loadAllNodes(graphRoot));
  return content;
}
