// simplegraph-agentic: cross-platform Stop hook logic
// Replaces or backs scripts/require_documentation.sh on all platforms (Windows, Linux, macOS).
//
// When an agent tries to finish a task that changed files guarded by a HIGH-priority
// node without documenting anything under core/, blocks once with a reminder.
// Design: Nudge once (stop_hook_active guard), fail-open on any error, HIGH-priority only.

import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parseNodes, type GraphNode } from "./parser.js";
import { pathMatches } from "./index.js";

export interface HookDecision {
  decision: "allow" | "block";
  reason?: string;
}

export function runRequireDocHook(options: {
  repoRoot?: string;
  graphRoot?: string;
  stdinPayload?: string;
}): HookDecision {
  if (process.env.SIMPLEGRAPH_SKIP_DOC_HOOK) {
    return { decision: "allow" };
  }

  // Idempotency guard: if the agent is already in a continuation triggered by a previous block, allow.
  const payload = options.stdinPayload ?? "";
  if (payload.includes('"stop_hook_active"') && payload.includes("true")) {
    return { decision: "allow" };
  }

  let repoRoot = options.repoRoot ?? process.cwd();
  try {
    const topLevel = child_process
      .execSync("git rev-parse --show-toplevel", { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim();
    if (topLevel) repoRoot = topLevel;
  } catch {
    // Fail-open: not a git repo or git error
    return { decision: "allow" };
  }

  const graphRoot = options.graphRoot ?? (
    process.env.SIMPLEGRAPH_ROOT
      ? path.resolve(process.env.SIMPLEGRAPH_ROOT)
      : path.join(repoRoot, "core")
  );

  if (!fs.existsSync(graphRoot)) {
    return { decision: "allow" };
  }

  const coreRel = path.relative(repoRoot, graphRoot).replace(/\\/g, "/");

  // Get changed files (tracked edits vs HEAD + untracked files)
  let changedFiles: string[] = [];
  try {
    const diffOut = child_process.execSync("git diff --name-only HEAD", { cwd: repoRoot, encoding: "utf-8" });
    const untrackedOut = child_process.execSync("git ls-files --others --exclude-standard", { cwd: repoRoot, encoding: "utf-8" });
    changedFiles = [...new Set(
      `${diffOut}\n${untrackedOut}`
        .split(/\r?\n/)
        .map(f => f.trim().replace(/\\/g, "/"))
        .filter(Boolean)
    )];
  } catch {
    return { decision: "allow" };
  }

  if (changedFiles.length === 0) {
    return { decision: "allow" };
  }

  // Did the agent touch the graph?
  const isDocumented = changedFiles.some(f => {
    if (!f.startsWith(`${coreRel}/`)) return false;
    const base = path.basename(f);
    return base !== "auto_map.md" &&
           base !== ".scratchpad.md" &&
           base !== ".seed_draft.json" &&
           base !== ".seed_state.json";
  });

  if (isDocumented) {
    return { decision: "allow" };
  }

  // Find all HIGH-priority nodes and their files
  const highNodes: Array<{ id: string; files: string[] }> = [];
  const collectNodes = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        collectNodes(full);
      } else if (ent.isFile() && ent.name.endsWith(".md")) {
        const base = ent.name.toLowerCase();
        if (base === "auto_map.md" || base === ".scratchpad.md") continue;
        const content = fs.readFileSync(full, "utf-8");
        const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
        const nodes = parseNodes(content, rel);
        for (const n of nodes) {
          if (n.priority === "HIGH" && n.files.length > 0) {
            highNodes.push({ id: n.id, files: n.files });
          }
        }
      }
    }
  };

  collectNodes(graphRoot);

  if (highNodes.length === 0) {
    return { decision: "allow" };
  }

  // Check if any changed file matches a HIGH-priority node's file
  const risky: Array<{ file: string; nodeIds: string[] }> = [];
  for (const changed of changedFiles) {
    const matchingNodeIds: string[] = [];
    for (const hn of highNodes) {
      if (hn.files.some(hf => pathMatches(hf, changed))) {
        matchingNodeIds.push(hn.id);
      }
    }
    if (matchingNodeIds.length > 0) {
      risky.push({ file: changed, nodeIds: [...new Set(matchingNodeIds)] });
    }
  }

  if (risky.length === 0) {
    return { decision: "allow" };
  }

  const riskyDesc = risky.map(r => `\`${r.file}\` (${r.nodeIds.join(", ")})`).join(", ");
  const reason =
    `This task modified file(s) guarded by HIGH-priority memory node(s): ${riskyDesc}, ` +
    `but made no changes under ${coreRel}/.\n\n` +
    `Before finishing, record what changed:\n` +
    `  • If you fixed a regression: simplegraph_update_node (increment REGRESSED_N_TIMES, or add RootCause) or simplegraph_archive_regression\n` +
    `  • If an architectural decision was made: simplegraph_add_node (type Decision)\n` +
    `  • If you learned a new invariant: simplegraph_add_node (type Invariant)\n` +
    `  • If a danger zone was discovered: simplegraph_add_node (type Watchlist)\n\n` +
    `Commit graph updates in the same commit as your code. (If this edit genuinely requires no documentation, simply stop again — this reminder fires at most once per task.)`;

  return {
    decision: "block",
    reason,
  };
}
