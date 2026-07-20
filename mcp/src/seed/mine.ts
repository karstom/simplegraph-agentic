// sg seed — repository mining: git history + working-tree file inventory.
// Builds the ExtractorContext shared by all extractors. Pure git plumbing,
// no network, no API keys.

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ExtractorContext, MinedCommit } from "./types.js";

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

export function runGit(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Directories never worth mining: vendored, generated, dependency output. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "vendor", "third_party",
  "target", "coverage", ".next", ".nuxt", "venv", ".venv", "__pycache__",
  ".idea", ".vscode", "bower_components", ".cache", ".terraform",
]);

const SKIP_FILES = /(\.min\.(js|css)|\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.map|\.snap)$/;

/** Extensions we treat as text worth scanning. */
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".php",
  ".sh", ".bash", ".zsh", ".sql", ".md", ".yaml", ".yml", ".toml", ".json",
  ".tf", ".proto", ".graphql", ".vue", ".svelte", ".ex", ".exs", ".scala",
]);

export function isSkippedPath(relPath: string): boolean {
  const parts = relPath.split("/");
  if (parts.some(p => SKIP_DIRS.has(p))) return true;
  if (SKIP_FILES.test(relPath)) return true;
  return false;
}

function windowArgs(opts: { since?: string; maxCommits: number }): string[] {
  const args = [`--max-count=${opts.maxCommits}`];
  if (opts.since) {
    // Accept either a date ("2024-01-01", "18 months ago") or a ref (tag/sha).
    if (/^\d{4}-\d{2}-\d{2}$/.test(opts.since) || /\bago\b/.test(opts.since)) {
      args.push(`--since=${opts.since}`);
    } else {
      args.push(`${opts.since}..HEAD`);
    }
  }
  return args;
}

export function mineCommits(repoRoot: string, opts: { since?: string; maxCommits: number }): MinedCommit[] {
  // Two passes: metadata (multi-line bodies make single-pass parsing with
  // --name-only ambiguous) and sha→files.
  const format = ["%H", "%h", "%P", "%as", "%s", "%b"].join(FIELD_SEP) + RECORD_SEP;
  let metaRaw: string;
  let filesRaw: string;
  try {
    metaRaw = runGit(repoRoot, ["log", ...windowArgs(opts), `--pretty=format:${format}`, "--date-order"]);
    filesRaw = runGit(repoRoot, ["log", ...windowArgs(opts), "--pretty=format:%x1e%H", "--name-only", "--date-order"]);
  } catch (e) {
    throw new Error(`git log failed in ${repoRoot}: ${(e as Error).message}`);
  }

  const filesBySha = new Map<string, string[]>();
  for (const record of filesRaw.split(RECORD_SEP)) {
    const lines = record.split("\n").map(l => l.trim());
    const sha = lines[0];
    if (!sha) continue;
    filesBySha.set(sha, lines.slice(1).filter(Boolean).filter(f => !isSkippedPath(f)));
  }

  const commits: MinedCommit[] = [];
  for (const record of metaRaw.split(RECORD_SEP)) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed.trim()) continue;
    const [sha, shortSha, parents, authorDate, subject, body] = trimmed.split(FIELD_SEP);
    if (!sha) continue;
    commits.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      subject: (subject ?? "").trim(),
      body: (body ?? "").trim(),
      authorDate: authorDate ?? "",
      parents: (parents ?? "").split(" ").filter(Boolean),
      files: filesBySha.get(sha) ?? [],
    });
  }
  return commits;
}

function listWorktreeFiles(repoRoot: string): string[] {
  // git ls-files gives us tracked text respecting the repo's own hygiene.
  const raw = runGit(repoRoot, ["ls-files"]);
  return raw
    .split("\n")
    .filter(Boolean)
    .filter(f => !isSkippedPath(f))
    .filter(f => TEXT_EXT.has(path.extname(f).toLowerCase()) || path.basename(f).startsWith("Dockerfile"));
}

function findComponentDirs(repoRoot: string, worktreeFiles: string[]): string[] {
  // A top-level directory is a component candidate when it holds ≥ 2 tracked
  // files. Root-level loose files do not form a component.
  const counts = new Map<string, number>();
  for (const f of worktreeFiles) {
    const idx = f.indexOf("/");
    if (idx === -1) continue;
    const top = f.slice(0, idx);
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([d]) => d)
    .sort();
}

export function buildContext(repoRoot: string, opts: { since?: string; maxCommits: number }): ExtractorContext {
  const abs = path.resolve(repoRoot);
  if (!fs.existsSync(path.join(abs, ".git"))) {
    throw new Error(`${abs} is not a git repository (no .git directory).`);
  }
  const headSha = runGit(abs, ["rev-parse", "HEAD"]).trim();
  const headDate = runGit(abs, ["log", "-1", "--pretty=%as", "HEAD"]).trim();
  const commits = mineCommits(abs, opts);
  const worktreeFiles = listWorktreeFiles(abs);
  const cache = new Map<string, string>();
  return {
    repoRoot: abs,
    headSha,
    headDate,
    commits,
    worktreeFiles,
    componentDirs: findComponentDirs(abs, worktreeFiles),
    readFile(relPath: string): string {
      if (!cache.has(relPath)) {
        try {
          const buf = fs.readFileSync(path.join(abs, relPath));
          // Cheap binary sniff: NUL byte in the first 8k means skip.
          const probe = buf.subarray(0, 8192);
          cache.set(relPath, probe.includes(0) ? "" : buf.toString("utf-8"));
        } catch {
          cache.set(relPath, "");
        }
      }
      return cache.get(relPath)!;
    },
  };
}
