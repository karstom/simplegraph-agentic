// sg seed — merge a DraftBundle into the core/ graph files.
//
// Contract (matches the seed idempotency rules):
//   • A node whose ID is new is appended to its target file.
//   • A seeded node that is byte-equivalent (modulo the Seeded line) is skipped.
//   • A seeded node whose current content still matches its recorded hash is
//     safely replaced when the draft differs (e.g. REGRESSED_N_TIMES grew).
//   • A seeded node hand-edited since seeding is NEVER touched → conflict.
//   • A hand-authored node with a colliding ID is NEVER touched → conflict.

import * as fs from "fs";
import * as path from "path";
import { parseNodes, formatNode, type GraphNode } from "../parser.js";
import { contentHash } from "./ids.js";
import type { DraftBundle, DraftNode, SeedState } from "./types.js";
import { SEED_VERSION } from "./types.js";

export const STATE_FILE = ".seed_state.json";
export const DRAFT_FILE = ".seed_draft.json";

export interface MergeResult {
  added: string[];
  updated: string[];
  unchanged: string[];
  conflicts: { id: string; reason: string }[];
  indexWarnings: string[];
}

const MULTI_NODE_FILES = ["regressions.md", "invariants.md", "decisions.md", "watchlists.md"];

function targetFileForType(type: string, id: string): string {
  switch (type.toLowerCase()) {
    case "component": return `components/${id.toLowerCase()}.md`;
    case "invariant": return "invariants.md";
    case "regression": return "regressions.md";
    case "decision": return "decisions.md";
    case "watchlist": return "watchlists.md";
    default: return "watchlists.md";
  }
}

export function loadGraphNodes(graphRoot: string): GraphNode[] {
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
      nodes.push(...parseNodes(fs.readFileSync(path.join(compDir, rel.split("/")[1]), "utf-8"), rel));
    }
  }
  return nodes;
}

function shortShas(shas: string[]): string {
  return shas.map(s => `\`${s.slice(0, 12)}\``).join(", ");
}

/** Render a draft as a graph markdown block, Seeded hash included. */
export function renderDraft(d: DraftNode): string {
  const provParts: string[] = [];
  if (d.provenance.commits.length) provParts.push(`commits: ${shortShas(d.provenance.commits)}`);
  if (d.provenance.locations.length) provParts.push(`locations: ${d.provenance.locations.map(l => `\`${l}\``).join(", ")}`);
  const provenance = provParts.join(" | ") || "_(structural)_";

  const priority =
    (d.regressedNTimes ?? 0) >= 2 ? "HIGH" : "LOW"; // heat rules; dates are historical so 14-day rule rarely applies

  const withoutHash = formatNode({
    id: d.id,
    type: d.type,
    priority,
    label: d.label,
    summary: d.summary,
    tags: d.tags,
    edges: d.edges.map(e => `${e.edgeType} → ${e.target}: ${e.explanation}`),
    files: d.files,
    lastUpdated: d.lastUpdated,
    regressedNTimes: d.regressedNTimes,
    provenance,
    seeded: "PLACEHOLDER",
  });
  const hash = contentHash(withoutHash);
  const seededLine =
    `${d.provenance.extractor}@${d.provenance.extractorVersion} | ` +
    `confidence: ${d.confidence.toFixed(2)} | hash: ${hash} | seed: v${SEED_VERSION}`;
  return withoutHash.replace("**Seeded:** PLACEHOLDER", `**Seeded:** ${seededLine}`);
}

function isHandEdited(existing: GraphNode): boolean {
  const recorded = existing.seeded?.match(/hash:\s*([0-9a-f]{8})/)?.[1];
  if (!recorded) return true; // seeded marker mangled or absent → treat as user content
  return contentHash(existing.rawContent) !== recorded;
}

function replaceNodeBlock(content: string, id: string, newBlock: string): string {
  const start = content.indexOf(`## NODE: ${id}`);
  if (start === -1) return content;
  const nextIdx = content.indexOf("\n## NODE:", start + 1);
  // The block may end at the next node or a trailing separator before it.
  let end = nextIdx !== -1 ? nextIdx : content.length;
  let block = content.slice(start, end);
  // Keep any trailing separator/whitespace outside the replacement.
  const tail = block.match(/(\n+---\s*)$/)?.[1] ?? "";
  if (tail) block = block.slice(0, block.length - tail.length);
  return content.slice(0, start) + newBlock + "\n" + tail.replace(/^\n+/, "\n") + content.slice(end);
}

function appendNodeBlock(filePath: string, block: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  fs.writeFileSync(
    filePath,
    existing.trim() ? `${existing.trimEnd()}\n\n---\n\n${block}\n` : `${block}\n`,
    "utf-8"
  );
}

function updateQuickIndex(graphRoot: string, merged: DraftNode[]): string[] {
  const warnings: string[] = [];
  const indexPath = path.join(graphRoot, "graph_index.md");
  if (!fs.existsSync(indexPath)) return ["graph_index.md not found — Quick Index not updated"];
  let content = fs.readFileSync(indexPath, "utf-8");

  const categoryMap: Record<string, string> = {
    Component: "Components",
    Invariant: "Invariants",
    Regression: "Active Regressions",
    Decision: "Decisions",
    Watchlist: "Watchlists & Open Issues",
  };

  const byType = new Map<string, DraftNode[]>();
  for (const d of merged) {
    if (!byType.has(d.type)) byType.set(d.type, []);
    byType.get(d.type)!.push(d);
  }

  for (const [type, drafts] of [...byType.entries()].sort()) {
    const rowLabel = categoryMap[type];
    const rowPattern = new RegExp(`(\\|\\s*\\*\\*${rowLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\*\\s*\\|)([^|]*)(\\|)`, "i");
    const m = content.match(rowPattern);
    if (!m) {
      warnings.push(`Quick Index row "${rowLabel}" not found; add ${drafts.length} ID(s) manually`);
      continue;
    }
    const cleaned = m[2].replace(/_\([^)]*\)_/g, "").trim();
    const present = new Set(cleaned.split(",").map(s => s.trim()).filter(Boolean));
    for (const d of drafts) present.add(d.id);
    const updated = [...present].join(", ");
    content = content.replace(rowPattern, (_s, prefix, _mid, suffix) => `${prefix} ${updated} ${suffix}`);
  }
  fs.writeFileSync(indexPath, content, "utf-8");
  return warnings;
}

export function mergeBundle(bundle: DraftBundle, graphRoot: string): MergeResult {
  const result: MergeResult = { added: [], updated: [], unchanged: [], conflicts: [], indexWarnings: [] };
  const existingNodes = loadGraphNodes(graphRoot);
  const existingById = new Map(existingNodes.map(n => [n.id, n]));

  // Defensive edge pruning: every target must resolve to an existing or
  // incoming node so consistency_check.sh stays green.
  const knownIds = new Set<string>([...existingById.keys(), ...bundle.nodes.map(n => n.id)]);

  const mergedDrafts: DraftNode[] = [];
  for (const draft of bundle.nodes) {
    draft.edges = draft.edges.filter(e => knownIds.has(e.target));
    const rendered = renderDraft(draft);
    const existing = existingById.get(draft.id);

    if (!existing) {
      appendNodeBlock(path.join(graphRoot, targetFileForType(draft.type, draft.id)), rendered);
      result.added.push(draft.id);
      mergedDrafts.push(draft);
      continue;
    }

    if (!existing.seeded) {
      result.conflicts.push({ id: draft.id, reason: `exists in ${existing.sourceFile} without a Seeded marker (hand-authored) — kept as-is` });
      continue;
    }
    if (isHandEdited(existing)) {
      result.conflicts.push({ id: draft.id, reason: `hand-edited since seeding (${existing.sourceFile}) — user version kept` });
      continue;
    }
    if (contentHash(existing.rawContent) === contentHash(rendered)) {
      result.unchanged.push(draft.id);
      continue;
    }
    // Seeded, pristine, and the draft changed → safe to update in place.
    const filePath = path.join(graphRoot, existing.sourceFile);
    const content = fs.readFileSync(filePath, "utf-8");
    fs.writeFileSync(filePath, replaceNodeBlock(content, draft.id, rendered), "utf-8");
    result.updated.push(draft.id);
    mergedDrafts.push(draft);
  }

  result.indexWarnings = updateQuickIndex(graphRoot, mergedDrafts.filter(d => result.added.includes(d.id)));

  // High-water mark: informational for incremental runs and reporting.
  const prior = readState(graphRoot);
  const nodesSeeded = new Set([...(prior?.nodesSeeded ?? []), ...result.added, ...result.updated, ...result.unchanged]);
  const state: SeedState = {
    seedVersion: SEED_VERSION,
    lastSeededSha: bundle.headSha,
    lastSeededDate: bundle.headDate,
    nodesSeeded: [...nodesSeeded].sort(),
  };
  fs.writeFileSync(path.join(graphRoot, STATE_FILE), JSON.stringify(state, null, 2) + "\n", "utf-8");

  return result;
}

export function readState(graphRoot: string): SeedState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(graphRoot, STATE_FILE), "utf-8"));
  } catch {
    return null;
  }
}
