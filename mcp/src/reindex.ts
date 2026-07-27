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

import * as fs from "fs";
import * as path from "path";
import { parseNodes, type GraphNode } from "./parser.js";
import { atomicWriteFileSync } from "./fsutil.js";

const MULTI_NODE_FILES = ["regressions.md", "invariants.md", "decisions.md", "watchlists.md"];

// Quick Index row label → node type it enumerates.
const ROW_FOR_TYPE: Record<string, string> = {
  component: "Components",
  invariant: "Invariants",
  regression: "Active Regressions",
  decision: "Decisions",
  watchlist: "Watchlists & Open Issues",
};

export interface ReindexResult {
  rows: { label: string; count: number }[];
  total: number;
  warnings: string[];
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

    // Match a table row `| **<label>** | <nodes> | <file> |` and rewrite only
    // the middle (nodes) cell. The label may contain regex metachars (&) — none
    // today, but escape defensively.
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rowPattern = new RegExp(`(\\|\\s*\\*\\*${escaped}\\*\\*\\s*\\|)([^|]*)(\\|)`, "i");
    if (!rowPattern.test(out)) {
      result.warnings.push(`Quick Index row "${label}" not found — ${group.length} node(s) not listed`);
      continue;
    }
    const cell = renderCell(group);
    out = out.replace(rowPattern, (_s, prefix, _mid, suffix) => `${prefix} ${cell} ${suffix}`);
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
  const { content, result } = regenerateIndexContent(fs.readFileSync(indexPath, "utf-8"), nodes);
  atomicWriteFileSync(indexPath, content);
  return result;
}
