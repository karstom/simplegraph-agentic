// sg seed — shared types for the repository-mining seed pipeline.
//
// The pipeline: extractors mine a repo into DraftNodes → edge inference links
// them → the bundle applies quality controls (confidence floor, per-type caps,
// dedupe) → the merge step writes surviving drafts into core/ graph files.

export const SEED_VERSION = "0.4.0";

export type NodeType = "Component" | "Invariant" | "Regression" | "Decision" | "Watchlist";

export const NODE_TYPES: NodeType[] = ["Component", "Invariant", "Regression", "Decision", "Watchlist"];

/** Where a draft node came from. Every seeded node must carry one of these. */
export interface Provenance {
  /** Commit SHAs this node was derived from (empty for pure working-tree finds). */
  commits: string[];
  /** File locations, e.g. "src/auth.ts:41" or "docs/adr/0002-use-postgres.md". */
  locations: string[];
  /** Extractor that produced the node, e.g. "regression-commits". */
  extractor: string;
  /** Extractor version — bump when heuristics change enough to invalidate old output. */
  extractorVersion: string;
}

export interface DraftEdge {
  edgeType: string;      // DEPENDS_ON | CAUSES | MITIGATES | FIXED_BY | VIOLATED_BY | CONTAINS | RELATES_TO | SUPERSEDED_BY
  target: string;        // node ID
  explanation: string;
}

export interface DraftNode {
  id: string;            // stable, content-derived, UPPER_SNAKE_CASE
  type: NodeType;
  label: string;
  summary: string;
  tags: string[];
  files: string[];
  /**
   * Directory prefixes the node owns — Component nodes only. The structure
   * extractor derives a Component *from* a directory, so leaving this unset
   * meant the one node type that always knows its own directory shipped with
   * no path anchor, and check_files could never fire it for a file the
   * component plainly owns.
   */
  paths?: string[];
  edges: DraftEdge[];
  /** 0..1 — extractor's confidence that this node is signal, not noise. */
  confidence: number;
  /** YYYY-MM-DD, derived from commit dates (never wall clock) for determinism. */
  lastUpdated: string;
  provenance: Provenance;
  regressedNTimes?: number;
}

/** A commit as mined from git log. */
export interface MinedCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorDate: string;    // YYYY-MM-DD
  parents: string[];
  files: string[];       // paths touched (empty for merges unless -m requested)
}

/** Everything an extractor may look at. Built once, shared by all extractors. */
export interface ExtractorContext {
  repoRoot: string;
  headSha: string;
  headDate: string;              // YYYY-MM-DD of HEAD commit — determinism-safe "today"
  commits: MinedCommit[];        // newest first, within the history window
  /** Working-tree text files (relative paths), vendored/generated dirs already skipped. */
  worktreeFiles: string[];
  readFile(relPath: string): string;
  /** Top-level code-bearing directories → candidate components. */
  componentDirs: string[];
}

/**
 * Tier 1 extractor seam. Deterministic implementations ship now; an
 * An agent reviewing simplegraph_seed_candidates supplies the judgment behind the same
 * interface later without touching the pipeline.
 */
export interface Extractor {
  name: string;
  version: string;
  /** Which node type(s) this extractor produces (for --types filtering). */
  produces: NodeType[];
  extract(ctx: ExtractorContext): DraftNode[];
}

/** The reviewable intermediate representation written to disk before merge. */
export interface DraftBundle {
  seedVersion: string;
  repoRoot: string;
  headSha: string;
  headDate: string;
  options: {
    since?: string;
    minConfidence: number;
    maxPerType: number;
    types: NodeType[];
  };
  nodes: DraftNode[];
  /** Counts of drafts dropped by each quality control, for the summary. */
  dropped: { belowConfidence: number; overCap: number; deduped: number };
}

/** Recorded after a successful merge; the high-water mark for incremental runs. */
export interface SeedState {
  seedVersion: string;
  lastSeededSha: string;
  lastSeededDate: string;   // head commit date at seed time
  nodesSeeded: string[];    // IDs ever written by seed
}

export interface SeedOptions {
  repoPath: string;
  graphRoot: string;        // core/ directory
  dryRun: boolean;
  yes: boolean;
  since?: string;           // ref or date, passed to git log --since / rev range
  minConfidence: number;
  maxPerType: number;
  types: NodeType[];
  output?: string;          // draft bundle path override
  maxCommits: number;       // default history window when --since absent
}

export const DEFAULT_MIN_CONFIDENCE = 0.5;
export const DEFAULT_MAX_PER_TYPE = 15;
/** Default history window: last 500 commits. --since widens or narrows it. */
export const DEFAULT_MAX_COMMITS = 500;
