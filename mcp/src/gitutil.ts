import { execFileSync } from "child_process";

/**
 * Returns the short HEAD commit SHA in the given repoRoot, or undefined if not in a git repo.
 */
export function getHeadCommit(repoRoot: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the number of commits between baseCommit and HEAD touching the specified files.
 * Returns 0 if not in a git repo, baseCommit is invalid/unknown, or on any error (fail-open).
 */
export function getCommitDistance(repoRoot: string, baseCommit: string, files: string[]): number {
  if (!baseCommit || !files || files.length === 0) return 0;
  try {
    const cleanFiles = files.map(f => f.trim()).filter(Boolean);
    if (cleanFiles.length === 0) return 0;

    const out = execFileSync(
      "git",
      ["rev-list", "--count", `${baseCommit}..HEAD`, "--", ...cleanFiles],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      }
    );
    const count = parseInt(out.trim(), 10);
    return isNaN(count) ? 0 : count;
  } catch {
    return 0;
  }
}
