#!/usr/bin/env node
// sg — simplegraph CLI. First command: `sg seed`.
//
// Bootstraps a memory graph by mining the repository's own history:
// reverts and fix commits → Regressions, merge bodies and ADRs → Decisions,
// rule comments and test names → Invariants, TODO/churn → Watchlists,
// directory structure → Components. Offline, deterministic, no API key.
//
// Nothing is written to the graph without review: the draft is summarized
// and written to core/.seed_draft.json, and merging requires an interactive
// confirm (or --yes). --dry-run mines and summarizes only.

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { buildContext } from "./mine.js";
import { assembleBundle } from "./bundle.js";
import { mergeBundle, readState, DRAFT_FILE } from "./merge.js";
import {
  DEFAULT_MAX_COMMITS, DEFAULT_MAX_PER_TYPE, DEFAULT_MIN_CONFIDENCE,
  NODE_TYPES, SEED_VERSION,
  type DraftBundle, type NodeType, type SeedOptions,
} from "./types.js";

const USAGE = `sg seed [PATH] — bootstrap a simplegraph memory graph from repository history

Usage:
  sg seed [PATH] [options]        PATH: repo root (default: cwd)

Options:
  --dry-run              mine and summarize, write nothing
  --since <ref|date>     history window (git ref, YYYY-MM-DD, or "18 months ago")
  --max-commits <n>      history window size when --since is absent (default ${DEFAULT_MAX_COMMITS})
  --min-confidence <n>   drop draft nodes below this 0..1 threshold (default ${DEFAULT_MIN_CONFIDENCE})
  --types <list>         comma-separated node types to seed (default: all)
                         (Component,Invariant,Regression,Decision,Watchlist)
  --max-per-type <n>     cap nodes per type (default ${DEFAULT_MAX_PER_TYPE})
  --graph <path>         graph root directory (default: PATH/core)
  --output <path>        write the draft bundle here (default: <graph>/${DRAFT_FILE})
  --yes                  skip the interactive confirm
  -h, --help             show this help
`;

function parseTypes(raw: string): NodeType[] {
  const wanted: NodeType[] = [];
  for (const part of raw.split(",").map(s => s.trim()).filter(Boolean)) {
    const match = NODE_TYPES.find(t => t.toLowerCase() === part.toLowerCase().replace(/s$/, ""));
    if (!match) throw new Error(`Unknown node type "${part}". Valid: ${NODE_TYPES.join(", ")}`);
    wanted.push(match);
  }
  return wanted.length ? wanted : NODE_TYPES;
}

export function parseArgs(argv: string[]): SeedOptions & { help: boolean; graphExplicit: boolean } {
  const opts = {
    repoPath: process.cwd(),
    graphRoot: "",
    dryRun: false,
    yes: false,
    since: undefined as string | undefined,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    maxPerType: DEFAULT_MAX_PER_TYPE,
    types: NODE_TYPES,
    output: undefined as string | undefined,
    maxCommits: DEFAULT_MAX_COMMITS,
    help: false,
    graphExplicit: false,
  };
  const args = [...argv];
  const next = (flag: string): string => {
    const v = args.shift();
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  while (args.length) {
    const a = args.shift()!;
    switch (a) {
      case "--dry-run": opts.dryRun = true; break;
      case "--yes": case "-y": opts.yes = true; break;
      case "--since": opts.since = next(a); break;
      case "--max-commits": opts.maxCommits = parseInt(next(a), 10); break;
      case "--min-confidence": opts.minConfidence = parseFloat(next(a)); break;
      case "--max-per-type": opts.maxPerType = parseInt(next(a), 10); break;
      case "--types": opts.types = parseTypes(next(a)); break;
      case "--graph": opts.graphRoot = path.resolve(next(a)); opts.graphExplicit = true; break;
      case "--output": opts.output = path.resolve(next(a)); break;
      case "-h": case "--help": opts.help = true; break;
      default:
        if (a.startsWith("-")) throw new Error(`Unknown option: ${a}\n\n${USAGE}`);
        opts.repoPath = path.resolve(a);
    }
  }
  if (!opts.graphRoot) opts.graphRoot = path.join(opts.repoPath, "core");
  if (Number.isNaN(opts.minConfidence) || opts.minConfidence < 0 || opts.minConfidence > 1) {
    throw new Error("--min-confidence must be a number between 0 and 1");
  }
  if (!Number.isInteger(opts.maxPerType) || opts.maxPerType < 1) throw new Error("--max-per-type must be a positive integer");
  if (!Number.isInteger(opts.maxCommits) || opts.maxCommits < 1) throw new Error("--max-commits must be a positive integer");
  return opts;
}

function bar(confidence: number): string {
  const filled = Math.round(confidence * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

export function summarize(bundle: DraftBundle): string {
  const lines: string[] = [];
  const byType = new Map<string, number>();
  let edgeCount = 0;
  for (const n of bundle.nodes) {
    byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
    edgeCount += n.edges.length;
  }
  const density = bundle.nodes.length ? (edgeCount / bundle.nodes.length).toFixed(2) : "0";

  lines.push(`sg seed v${SEED_VERSION} — draft graph for ${bundle.repoRoot}`);
  lines.push(`  window: ${bundle.options.since ?? "(default)"} · HEAD ${bundle.headSha.slice(0, 12)} (${bundle.headDate})`);
  lines.push("");
  lines.push(`  Nodes: ${bundle.nodes.length} total`);
  for (const t of ["Component", "Regression", "Decision", "Invariant", "Watchlist"]) {
    if (byType.has(t)) lines.push(`    ${t.padEnd(10)} ${byType.get(t)}`);
  }
  lines.push(`  Edges: ${edgeCount} (density ${density} per node)`);
  const d = bundle.dropped;
  if (d.belowConfidence + d.overCap + d.deduped > 0) {
    lines.push(`  Dropped: ${d.belowConfidence} below confidence floor, ${d.overCap} over per-type cap, ${d.deduped} duplicates`);
  }
  if (edgeCount === 0 && bundle.nodes.length > 0) {
    lines.push(`  ⚠ zero edges inferred — this is a defect in the extractors for this repo shape; please report it`);
  }
  lines.push("");
  lines.push("  Top drafts by confidence:");
  const top = [...bundle.nodes].sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1)).slice(0, 10);
  for (const n of top) {
    lines.push(`    ${bar(n.confidence)} ${n.confidence.toFixed(2)}  [${n.type.slice(0, 3).toUpperCase()}] ${n.id}`);
    lines.push(`               ${n.label}`);
  }
  return lines.join("\n");
}

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export async function runSeed(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const ctx = buildContext(opts.repoPath, { since: opts.since, maxCommits: opts.maxCommits });
  const bundle = assembleBundle(ctx, opts);

  const prior = readState(opts.graphRoot);
  process.stdout.write(summarize(bundle) + "\n\n");
  if (prior) {
    process.stdout.write(
      `  Previous seed: ${prior.lastSeededSha.slice(0, 12)} (${prior.lastSeededDate}), ${prior.nodesSeeded.length} node(s) tracked\n\n`
    );
  }

  if (bundle.nodes.length === 0) {
    process.stdout.write("Nothing to seed — no drafts survived the quality controls. Try --min-confidence 0.4 or a wider --since window.\n");
    return 0;
  }

  if (opts.dryRun) {
    process.stdout.write("--dry-run: nothing written.\n");
    return 0;
  }

  if (!fs.existsSync(opts.graphRoot)) {
    process.stderr.write(
      `Graph root not found: ${opts.graphRoot}\n` +
      `Run setup.sh to install simplegraph into this repo first, or pass --graph <path>.\n`
    );
    return 1;
  }

  const draftPath = opts.output ?? path.join(opts.graphRoot, DRAFT_FILE);
  fs.writeFileSync(draftPath, JSON.stringify(bundle, null, 2) + "\n", "utf-8");
  process.stdout.write(`Draft bundle written to ${draftPath} — review it before confirming.\n`);

  if (!opts.yes) {
    const proceed = await confirm(`Merge ${bundle.nodes.length} draft node(s) into ${opts.graphRoot}? [y/N] `);
    if (!proceed) {
      process.stdout.write("Aborted — graph not modified. The draft bundle remains for review.\n");
      return 0;
    }
  }

  const result = mergeBundle(bundle, opts.graphRoot);
  process.stdout.write(
    `\nMerge complete:\n` +
    `  added:     ${result.added.length}\n` +
    `  updated:   ${result.updated.length}\n` +
    `  unchanged: ${result.unchanged.length}\n` +
    `  conflicts: ${result.conflicts.length}\n`
  );
  for (const c of result.conflicts) process.stdout.write(`    ⚠ ${c.id}: ${c.reason}\n`);
  for (const w of result.indexWarnings) process.stdout.write(`    ⚠ index: ${w}\n`);
  process.stdout.write(
    `\nNext steps:\n` +
    `  1. Review the seeded nodes (git diff ${path.relative(process.cwd(), opts.graphRoot) || "."}).\n` +
    `  2. bash ${path.join(path.relative(process.cwd(), opts.repoPath) || ".", "core/scripts/consistency_check.sh")} ` +
    `— verify edge integrity.\n` +
    `  3. Delete nodes that read as noise — precision beats recall — then commit core/.\n`
  );
  return 0;
}

// Entry point when invoked as `sg`.
const invoked = process.argv[1] ?? "";
if (/\b(sg|cli)(\.js|\.ts)?$/.test(path.basename(invoked))) {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(`sg — simplegraph CLI\n\nCommands:\n  seed    ${USAGE.split("\n")[0]}\n\n${USAGE}`);
    process.exit(command ? 0 : 1);
  } else if (command === "seed") {
    runSeed(rest).then(code => process.exit(code)).catch(e => {
      process.stderr.write(`Error: ${(e as Error).message}\n`);
      process.exit(1);
    });
  } else {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
  }
}
