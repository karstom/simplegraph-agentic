// simplegraph-agentic: cross-platform stale node checker
// Replaces or backs scripts/stale_check.sh on all platforms (Windows, Linux, macOS).
// Checks for:
//   1. Nodes with LastUpdated older than maxAgeDays (default: 90)
//   2. Nodes referencing file paths that no longer exist on disk
//   3. Nodes owning **Paths:** directories that no longer exist
//   4. Nodes anchored to **Symbols:** absent from auto_map.md (skipped if unmapped)

import * as fs from "fs";
import * as path from "path";
import { parseNodes, type GraphNode } from "./parser.js";

export interface StaleDateHit {
  id: string;
  date: string;
  file: string;
}

export interface MissingPathHit {
  id: string;
  target: string;
  file: string;
  type: "file" | "directory";
}

export interface MissingSymbolHit {
  id: string;
  symbol: string;
  file: string;
}

export interface StaleCheckResult {
  ok: boolean;
  staleDates: StaleDateHit[];
  missingFiles: MissingPathHit[];
  missingPaths: MissingPathHit[];
  missingSymbols: MissingSymbolHit[];
  output: string;
}

export interface StaleCheckOptions {
  graphRoot: string;
  repoRoot?: string;
  maxAgeDays?: number;
  all?: boolean;
}

function findMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const base = entry.name.toLowerCase();
      if (base !== "archive" && base !== "generated") {
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

export function runStaleCheck(options: StaleCheckOptions): StaleCheckResult {
  const { graphRoot } = options;
  const repoRoot = options.repoRoot ?? path.dirname(graphRoot);
  const maxAgeDays = options.maxAgeDays ?? 90;

  const highOnly = !options.all;

  const linesOut: string[] = [];
  linesOut.push(`Stale check: MAX_AGE_DAYS=${maxAgeDays}, GRAPH_ROOT=${graphRoot}, REPO_ROOT=${repoRoot}`);
  linesOut.push("");

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - maxAgeDays);
  const cutoffDateStr = cutoff.toISOString().slice(0, 10);

  const files = findMarkdownFiles(graphRoot);
  const allNodes: GraphNode[] = [];

  for (const f of files) {
    const content = fs.readFileSync(f, "utf-8");
    const rel = path.relative(repoRoot, f).replace(/\\/g, "/");
    allNodes.push(...parseNodes(content, rel));
  }

  // Filter to HIGH priority by default unless --all is passed
  const targetNodes = highOnly
    ? allNodes.filter(n => (n.priority || "").toUpperCase() === "HIGH")
    : allNodes;

  interface StaleNodeFinding {
    id: string;
    priority: string;
    file: string;
    reasons: string[];
  }
  const findingsMap = new Map<string, StaleNodeFinding>();

  const addReason = (node: GraphNode, reason: string) => {
    let item = findingsMap.get(node.id);
    if (!item) {
      item = {
        id: node.id,
        priority: node.priority || "UNSET",
        file: node.sourceFile,
        reasons: [],
      };
      findingsMap.set(node.id, item);
    }
    item.reasons.push(reason);
  };

  // 1. Check old LastUpdated
  const staleDates: StaleDateHit[] = [];
  for (const node of targetNodes) {
    if (node.lastUpdated && /^\d{4}-\d{2}-\d{2}$/.test(node.lastUpdated)) {
      if (node.lastUpdated < cutoffDateStr) {
        staleDates.push({ id: node.id, date: node.lastUpdated, file: node.sourceFile });
        addReason(node, `unmodified since ${node.lastUpdated} (> ${maxAgeDays}d)`);
      }
    }
  }

  // 2. Check missing files
  const missingFiles: MissingPathHit[] = [];
  for (const node of targetNodes) {
    for (const f of node.files) {
      const cleanF = f.trim();
      if (!cleanF) continue;
      const targetPath = path.resolve(repoRoot, cleanF);
      if (!fs.existsSync(targetPath)) {
        missingFiles.push({ id: node.id, target: cleanF, file: node.sourceFile, type: "file" });
        addReason(node, `missing file: ${cleanF}`);
      }
    }
  }

  // 3. Check missing paths (directories)
  const missingPaths: MissingPathHit[] = [];
  for (const node of targetNodes) {
    for (const p of node.paths) {
      const cleanP = p.trim();
      if (!cleanP) continue;
      const targetPath = path.resolve(repoRoot, cleanP);
      if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
        missingPaths.push({ id: node.id, target: cleanP, file: node.sourceFile, type: "directory" });
        addReason(node, `missing directory: ${cleanP}/`);
      }
    }
  }

  // 4. Check unmapped symbols (check generated/auto_map.md or legacy auto_map.md)
  const autoMapFile = fs.existsSync(path.join(graphRoot, "generated", "auto_map.md"))
    ? path.join(graphRoot, "generated", "auto_map.md")
    : path.join(graphRoot, "auto_map.md");

  const missingSymbols: MissingSymbolHit[] = [];
  if (fs.existsSync(autoMapFile)) {
    const autoMapContent = fs.readFileSync(autoMapFile, "utf-8");
    for (const node of targetNodes) {
      for (const sym of node.symbols) {
        const cleanSym = sym.trim();
        if (!cleanSym) continue;
        if (!autoMapContent.includes(cleanSym)) {
          missingSymbols.push({ id: node.id, symbol: cleanSym, file: node.sourceFile });
          addReason(node, `unmapped symbol: ${cleanSym}`);
        }
      }
    }
  }

  const ok = findingsMap.size === 0;

  if (ok) {
    const scopeNote = highOnly ? " (HIGH-priority nodes)" : "";
    linesOut.push(`✓ Graph is fresh${scopeNote}: no outdated dates (> ${maxAgeDays}d) and all referenced files/paths exist.`);
  } else {
    linesOut.push(`── Stale or broken references found (${findingsMap.size} node(s)) ──`);
    if (highOnly) {
      linesOut.push(`  Showing HIGH-priority nodes only. Use --all to inspect MEDIUM and LOW nodes.\n`);
    }
    for (const f of findingsMap.values()) {
      linesOut.push(`  ⏳ ${f.id} [${f.priority}] — ${f.reasons.join("; ")} — in ${f.file}`);
    }
    linesOut.push("");
    linesOut.push(`✗ ${findingsMap.size} stale node(s) detected. Review and update as needed.`);
  }

  return {
    ok,
    staleDates,
    missingFiles,
    missingPaths,
    missingSymbols,
    output: linesOut.join("\n"),
  };
}
