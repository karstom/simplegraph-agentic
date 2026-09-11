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

function findMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const base = entry.name.toLowerCase();
      if (base !== "auto_map.md" && base !== ".scratchpad.md") {
        results.push(full);
      }
    }
  }
  return results.sort();
}

export function runStaleCheck(options: {
  graphRoot: string;
  repoRoot?: string;
  maxAgeDays?: number;
}): StaleCheckResult {
  const { graphRoot } = options;
  const repoRoot = options.repoRoot ?? path.dirname(graphRoot);
  const maxAgeDays = options.maxAgeDays ?? 90;

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

  // 1. Check old LastUpdated
  const staleDates: StaleDateHit[] = [];
  for (const node of allNodes) {
    if (node.lastUpdated && /^\d{4}-\d{2}-\d{2}$/.test(node.lastUpdated)) {
      if (node.lastUpdated < cutoffDateStr) {
        staleDates.push({ id: node.id, date: node.lastUpdated, file: node.sourceFile });
      }
    }
  }

  // 2. Check missing files
  const missingFiles: MissingPathHit[] = [];
  for (const node of allNodes) {
    for (const f of node.files) {
      const cleanF = f.trim();
      if (!cleanF) continue;
      const targetPath = path.resolve(repoRoot, cleanF);
      if (!fs.existsSync(targetPath)) {
        missingFiles.push({ id: node.id, target: cleanF, file: node.sourceFile, type: "file" });
      }
    }
  }

  // 3. Check missing paths (directories)
  const missingPaths: MissingPathHit[] = [];
  for (const node of allNodes) {
    for (const p of node.paths) {
      const cleanP = p.trim();
      if (!cleanP) continue;
      const targetPath = path.resolve(repoRoot, cleanP);
      if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
        missingPaths.push({ id: node.id, target: cleanP, file: node.sourceFile, type: "directory" });
      }
    }
  }

  // 4. Check unmapped symbols (if auto_map.md exists)
  const autoMapFile = path.join(graphRoot, "auto_map.md");
  const missingSymbols: MissingSymbolHit[] = [];
  if (fs.existsSync(autoMapFile)) {
    const autoMapContent = fs.readFileSync(autoMapFile, "utf-8");
    for (const node of allNodes) {
      for (const sym of node.symbols) {
        const cleanSym = sym.trim();
        if (!cleanSym) continue;
        if (!autoMapContent.includes(cleanSym)) {
          missingSymbols.push({ id: node.id, symbol: cleanSym, file: node.sourceFile });
        }
      }
    }
  }

  if (staleDates.length > 0) {
    linesOut.push(`── Nodes older than ${maxAgeDays} days (before ${cutoffDateStr}) ──`);
    for (const s of staleDates) {
      linesOut.push(`  ⏳ ${s.id} (${s.date}) — ${s.file}`);
    }
    linesOut.push("");
  }

  if (missingFiles.length > 0) {
    linesOut.push("── Nodes referencing missing files ──");
    for (const m of missingFiles) {
      linesOut.push(`  ❌ ${m.id} references missing file: ${m.target} (in ${m.file})`);
    }
    linesOut.push("");
  }

  if (missingPaths.length > 0) {
    linesOut.push("── Nodes owning missing directories ──");
    for (const m of missingPaths) {
      linesOut.push(`  ❌ ${m.id} owns missing directory: ${m.target} (in ${m.file})`);
    }
    linesOut.push("");
  }

  if (missingSymbols.length > 0) {
    linesOut.push("── Nodes referencing unmapped symbols ──");
    for (const s of missingSymbols) {
      linesOut.push(`  ⚠ ${s.id} references unmapped symbol: ${s.symbol} (in ${s.file})`);
    }
    linesOut.push("");
  }

  const ok = staleDates.length === 0 && missingFiles.length === 0 && missingPaths.length === 0;

  if (ok) {
    linesOut.push(`✓ Graph is fresh: no outdated dates (> ${maxAgeDays}d) and all referenced files/paths exist.`);
  } else {
    linesOut.push("⚠ Stale or missing references found in graph nodes.");
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
