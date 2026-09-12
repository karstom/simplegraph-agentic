// simplegraph-agentic: cross-platform graph consistency checker
// Replaces or backs scripts/consistency_check.sh on all platforms (Windows, Linux, macOS).
// Checks:
//   1. No duplicate node IDs (across core/ and shared/)
//   2. No broken edge references (every `→ TARGET` resolves to a defined node)
//   3. Shared graph attribution (advisory warning on un-attributed nodes in shared/)

import * as fs from "fs";
import * as path from "path";
import { parseNodes, type GraphNode } from "./parser.js";

export interface DuplicateIdInfo {
  id: string;
  files: string[];
}

export interface BrokenEdgeInfo {
  target: string;
  sourceNodeId: string;
  sourceFile: string;
}

export interface CheckResult {
  ok: boolean;
  nodeCount: number;
  edgeCount: number;
  duplicateIds: DuplicateIdInfo[];
  brokenEdges: BrokenEdgeInfo[];
  untracedSharedNodes: string[];
  output: string;
}

function findMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const dirLower = entry.name.toLowerCase();
      if (dirLower !== "archive" && dirLower !== "generated") {
        results.push(...findMarkdownFiles(full));
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const base = entry.name.toLowerCase();
      if (base !== "auto_map.md" && base !== ".scratchpad.md") {
        results.push(full);
      }
    }
  }
  return results.sort();
}

export function runCheck(options: {
  graphRoot: string;
  sharedRoot?: string | null;
}): CheckResult {
  const { graphRoot } = options;
  const sharedRoot = options.sharedRoot ?? (
    fs.existsSync(path.join(path.dirname(graphRoot), "shared"))
      ? path.join(path.dirname(graphRoot), "shared")
      : null
  );

  const linesOut: string[] = [];
  if (sharedRoot) {
    linesOut.push(`Checking core/ + shared/ (${sharedRoot})`);
  } else {
    linesOut.push("Checking core/");
  }

  const coreFiles = findMarkdownFiles(graphRoot);
  const sharedFiles = sharedRoot ? findMarkdownFiles(sharedRoot) : [];

  interface NodeRecord {
    id: string;
    file: string;
    node?: GraphNode;
  }

  const allRecords: NodeRecord[] = [];
  const idToFileMap = new Map<string, string[]>();

  const processFile = (file: string, isShared: boolean) => {
    const content = fs.readFileSync(file, "utf-8");
    const relFile = isShared && sharedRoot
      ? `[shared] ${path.relative(sharedRoot, file).replace(/\\/g, "/")}`
      : path.relative(path.dirname(graphRoot), file).replace(/\\/g, "/");

    const parsedNodes = parseNodes(content, relFile);
    for (const node of parsedNodes) {
      allRecords.push({ id: node.id, file: relFile, node });
      const existing = idToFileMap.get(node.id) || [];
      existing.push(relFile);
      idToFileMap.set(node.id, existing);
    }
  };

  for (const f of coreFiles) processFile(f, false);
  for (const f of sharedFiles) processFile(f, true);

  // 1. Check duplicate node IDs
  const duplicateIds: DuplicateIdInfo[] = [];
  for (const [id, files] of idToFileMap.entries()) {
    if (files.length > 1) {
      duplicateIds.push({ id, files });
    }
  }
  duplicateIds.sort((a, b) => a.id.localeCompare(b.id));

  // 2. Check broken edge references
  const allKnownIds = new Set(idToFileMap.keys());
  const brokenEdges: BrokenEdgeInfo[] = [];
  const allEdgeTargets = new Set<string>();

  for (const record of allRecords) {
    if (!record.node) continue;
    for (const edge of record.node.edges) {
      const arrowIdx = edge.indexOf("→") !== -1 ? edge.indexOf("→") : edge.indexOf("->");
      if (arrowIdx === -1) continue;
      // Discard explanation after ':'
      const colonIdx = edge.indexOf(":", arrowIdx);
      const targetSegment = colonIdx !== -1
        ? edge.slice(arrowIdx + (edge[arrowIdx] === "→" ? 1 : 2), colonIdx)
        : edge.slice(arrowIdx + (edge[arrowIdx] === "→" ? 1 : 2));
      const targetIdPattern = /[A-Z][A-Z0-9_]*/g;
      for (const m of targetSegment.matchAll(targetIdPattern)) {
        const target = m[0];
        allEdgeTargets.add(target);
        if (!allKnownIds.has(target)) {
          brokenEdges.push({
            target,
            sourceNodeId: record.id,
            sourceFile: record.file,
          });
        }
      }
    }
  }

  // 3. Traceability of shared nodes
  const untracedSharedNodes: string[] = [];
  if (sharedRoot) {
    for (const record of allRecords) {
      if (record.file.startsWith("[shared]") && record.node) {
        const n = record.node;
        const traced = Boolean(n.author || n.provenance || n.seeded);
        if (!traced) {
          untracedSharedNodes.push(n.id);
        }
      }
    }
  }

  let ok = true;

  if (duplicateIds.length > 0) {
    ok = false;
    linesOut.push("✗ Duplicate node IDs found (same ID defined more than once):");
    for (const dup of duplicateIds) {
      linesOut.push(`  ${dup.id} (${dup.files.join(", ")})`);
    }
    linesOut.push("  Rename one, or merge the two definitions into a single NODE block, then re-run 'sg reindex'.");
  }

  if (brokenEdges.length > 0) {
    ok = false;
    linesOut.push("✗ Broken edge references found (targets with no matching NODE):");
    const uniqueBroken = [...new Set(brokenEdges.map(b => b.target))].sort();
    for (const target of uniqueBroken) {
      const sources = brokenEdges
        .filter(b => b.target === target)
        .map(b => `${b.sourceNodeId} in ${b.sourceFile}`)
        .join(", ");
      linesOut.push(`  ${target} (referenced by ${sources})`);
    }
  }

  if (untracedSharedNodes.length > 0) {
    linesOut.push("⚠ Shared nodes with no attribution (Author / Provenance / Seeded) — an");
    linesOut.push("  org-wide rule with no traceable source. Add an Author when promoting to shared/:");
    for (const id of untracedSharedNodes) {
      linesOut.push(`  ⚠ ${id}`);
    }
  }

  if (ok) {
    linesOut.push(`✓ ${allRecords.length} node(s), ${allEdgeTargets.size} distinct edge target(s): all references resolve, all IDs unique.`);
  }

  return {
    ok,
    nodeCount: allRecords.length,
    edgeCount: allEdgeTargets.size,
    duplicateIds,
    brokenEdges,
    untracedSharedNodes,
    output: linesOut.join("\n"),
  };
}
