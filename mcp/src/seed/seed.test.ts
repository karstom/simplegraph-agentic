// sg seed test suite — runs against throwaway fixture git repositories built
// in a tmpdir, never against the live repo. Covers extraction, provenance,
// idempotency, hand-edit conflicts, dedupe, and edge integrity.
// Run: npm test (from mcp/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "./mine.js";
import { contentHash } from "./ids.js";
import { assembleBundle } from "./bundle.js";
import { mergeBundle, loadGraphNodes, renderDraft } from "./merge.js";
import { regenerateIndex } from "../reindex.js";
import { parseNodes } from "../parser.js";
import { DEFAULT_MAX_COMMITS, DEFAULT_MAX_PER_TYPE, DEFAULT_MIN_CONFIDENCE, NODE_TYPES, type SeedOptions } from "./types.js";

// ── Fixture repo builder ──────────────────────────────────────────────────────

let dateCounter = 0;

function git(repo: string, ...args: string[]): string {
  // Deterministic authorship and monotonically increasing commit dates.
  const n = dateCounter++;
  const date = `2026-${String(1 + Math.floor(n / 28)).padStart(2, "0")}-${String(1 + (n % 28)).padStart(2, "0")}T12:00:00`;
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fix@test",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fix@test",
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
    },
  });
}

function commit(repo: string, message: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-m", message);
}

/** A small repo with every signal the extractors look for. */
function buildFixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "sg-seed-fixture-"));
  git(repo, "init", "-q", "-b", "main");

  commit(repo, "initial scaffold", {
    "package.json": JSON.stringify({ name: "fixture-app", description: "test fixture" }),
    "src/app.ts": "export const app = 1;\n",
    "src/util.ts": "export const util = 1;\n",
    "docs/readme.md": "# Fixture\n",
  });

  commit(repo, "feat: add auth module", {
    "src/auth.ts": [
      "// NEVER store tokens in localStorage — session hijack vector",
      "// TODO: handle refresh-token rotation edge case properly",
      "export function login() { return 1; }",
    ].join("\n") + "\n",
  });

  commit(repo, "fix: token leak on refresh\n\nTokens were kept in memory after logout, leaking across sessions.", {
    "src/auth.ts": "// NEVER store tokens in localStorage — session hijack vector\n// TODO: handle refresh-token rotation edge case properly\nexport function login() { return 2; }\n",
  });

  commit(repo, "fix: token refresh race condition\n\nTwo concurrent refreshes could both win. Closes #42.", {
    "src/auth.ts": "// NEVER store tokens in localStorage — session hijack vector\n// TODO: handle refresh-token rotation edge case properly\nexport function login() { return 3; }\n",
  });

  commit(repo, "add caching layer", {
    "src/cache.ts": "export const cache = new Map();\n",
  });
  git(repo, "revert", "--no-edit", "HEAD");

  commit(repo, "test: pin logout behavior", {
    "src/auth.test.ts": 'test("never persists token after logout", () => {});\n',
  });

  commit(repo, "docs: record storage decision", {
    "docs/adr/0001-use-sqlite.md": "# Use SQLite for local persistence\n\nWe chose SQLite over Postgres because the app is single-user and offline-first; a server dependency was rejected.\n",
  });

  return repo;
}

/** Minimal graph store mirroring core/'s file layout. */
function buildGraphRoot(repo: string): string {
  const root = join(repo, "core");
  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "graph_index.md"), [
    "# Fixture Graph — Index", "",
    "| Category | Nodes | File |",
    "|---|---|---|",
    "| **Components** | _(add your component node IDs here)_ | `components/{NAME}.md` |",
    "| **Invariants** | _(add here)_ | `invariants.md` |",
    "| **Active Regressions** | _(add here)_ | `regressions.md` |",
    "| **Decisions** | _(add here)_ | `decisions.md` |",
    "| **Watchlists & Open Issues** | _(add here)_ | `watchlists.md` |",
    "",
  ].join("\n"));
  for (const f of ["regressions.md", "invariants.md", "decisions.md", "watchlists.md"]) {
    writeFileSync(join(root, f), `# ${f}\n\n---\n`);
  }
  return root;
}

function defaultOpts(repo: string): SeedOptions {
  return {
    repoPath: repo,
    graphRoot: join(repo, "core"),
    dryRun: false,
    yes: true,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    maxPerType: DEFAULT_MAX_PER_TYPE,
    types: NODE_TYPES,
    maxCommits: DEFAULT_MAX_COMMITS,
  };
}

function mine(repo: string) {
  return assembleBundle(buildContext(repo, { maxCommits: DEFAULT_MAX_COMMITS }), defaultOpts(repo));
}

// ── Extraction ────────────────────────────────────────────────────────────────

test("fixture repo yields nodes of at least three distinct types", () => {
  const bundle = mine(buildFixtureRepo());
  const types = new Set(bundle.nodes.map(n => n.type));
  assert.ok(types.size >= 3, `expected ≥3 types, got: ${[...types].join(", ")}`);
  assert.ok(bundle.nodes.length > 0);
});

test("every draft node carries complete provenance", () => {
  const bundle = mine(buildFixtureRepo());
  for (const n of bundle.nodes) {
    assert.ok(n.provenance.extractor, `${n.id} missing extractor`);
    assert.ok(n.provenance.extractorVersion, `${n.id} missing extractor version`);
    assert.ok(
      n.provenance.commits.length + n.provenance.locations.length > 0,
      `${n.id} has neither commits nor locations`
    );
  }
});

test("revert is detected as a high-confidence regression", () => {
  const bundle = mine(buildFixtureRepo());
  const revert = bundle.nodes.find(n => n.tags.includes("revert"));
  assert.ok(revert, "no revert regression found");
  assert.ok(revert!.confidence >= 0.9);
  assert.equal(revert!.provenance.commits.length, 2, "revert should reference both SHAs");
});

test("repeated fixes to one file cluster into a single regression with count", () => {
  const bundle = mine(buildFixtureRepo());
  const cluster = bundle.nodes.find(n => n.tags.includes("repeat-fix"));
  assert.ok(cluster, "no repeat-fix cluster found");
  assert.equal(cluster!.regressedNTimes, 2);
  assert.deepEqual(cluster!.files, ["src/auth.ts"]);
});

test("ADR file becomes a Decision draft", () => {
  const bundle = mine(buildFixtureRepo());
  const adr = bundle.nodes.find(n => n.type === "Decision" && n.tags.includes("adr"));
  assert.ok(adr, "no ADR decision found");
  assert.match(adr!.label, /SQLite/i);
});

test("invariant comment and rule-shaped test name become Invariant drafts", () => {
  const bundle = mine(buildFixtureRepo());
  const invariants = bundle.nodes.filter(n => n.type === "Invariant");
  assert.ok(invariants.some(n => /localStorage/i.test(n.label)), "comment invariant missing");
  assert.ok(invariants.some(n => /never persists token/i.test(n.label)), "test-name invariant missing");
});

test("edge density is greater than zero and every edge target resolves", () => {
  const bundle = mine(buildFixtureRepo());
  const ids = new Set(bundle.nodes.map(n => n.id));
  const edgeCount = bundle.nodes.reduce((s, n) => s + n.edges.length, 0);
  assert.ok(edgeCount > 0, "seed produced zero edges");
  for (const n of bundle.nodes) {
    for (const e of n.edges) {
      assert.ok(ids.has(e.target), `${n.id} has dangling edge to ${e.target}`);
    }
  }
});

test("same TODO text in two files dedupes to one Watchlist node", () => {
  const repo = buildFixtureRepo();
  commit(repo, "copy util", {
    "src/util2.ts": "// TODO: handle refresh-token rotation edge case properly\nexport const u = 2;\n",
  });
  const bundle = mine(repo);
  const todos = bundle.nodes.filter(n => /refresh-token rotation/i.test(n.label));
  assert.equal(todos.length, 1, "TODO in two files should be one node");
  assert.equal(todos[0].files.length, 2);
});

test("quality controls: confidence floor and per-type cap are enforced", () => {
  const repo = buildFixtureRepo();
  const ctx = buildContext(repo, { maxCommits: DEFAULT_MAX_COMMITS });
  const strict = assembleBundle(ctx, { ...defaultOpts(repo), minConfidence: 0.85, maxPerType: 1 });
  for (const n of strict.nodes) assert.ok(n.confidence >= 0.85);
  const byType = new Map<string, number>();
  for (const n of strict.nodes) byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
  for (const [t, c] of byType) assert.ok(c <= 1, `${t} exceeds cap`);
  assert.ok(strict.dropped.belowConfidence > 0);
});

// ── Determinism & idempotency ─────────────────────────────────────────────────

test("two bundles at the same commit are identical", () => {
  const repo = buildFixtureRepo();
  const a = mine(repo);
  const b = mine(repo);
  assert.deepEqual(a, b);
});

test("merging twice at the same commit is a no-op the second time", () => {
  const repo = buildFixtureRepo();
  const graphRoot = buildGraphRoot(repo);
  const first = mergeBundle(mine(repo), graphRoot);
  assert.ok(first.added.length > 0);
  assert.equal(first.conflicts.length, 0);

  const second = mergeBundle(mine(repo), graphRoot);
  assert.equal(second.added.length, 0);
  assert.equal(second.updated.length, 0);
  assert.equal(second.conflicts.length, 0);
  assert.equal(second.unchanged.length, first.added.length);
});

test("a run after new commits adds only the new nodes", () => {
  const repo = buildFixtureRepo();
  const graphRoot = buildGraphRoot(repo);
  const first = mergeBundle(mine(repo), graphRoot);

  commit(repo, "fix: cache eviction never fired\n\nEviction timer was cleared on startup by mistake.", {
    "src/cache2.ts": "export const c = 1;\n",
  });
  const second = mergeBundle(mine(repo), graphRoot);
  assert.ok(second.added.length >= 1, "new fix commit should add a node");
  assert.equal(second.conflicts.length, 0);
  // Nothing that existed before was rewritten.
  for (const id of first.added) assert.ok(!second.added.includes(id));
});

// ── Conflict protection ───────────────────────────────────────────────────────

test("a hand-edited seeded node survives re-seed and is reported", () => {
  const repo = buildFixtureRepo();
  const graphRoot = buildGraphRoot(repo);
  mergeBundle(mine(repo), graphRoot);

  // User rewrites the summary of a seeded regression.
  const regrPath = join(graphRoot, "regressions.md");
  const before = readFileSync(regrPath, "utf-8");
  const target = parseNodes(before, "regressions.md")[0];
  assert.ok(target, "expected a seeded regression");
  const edited = before.replace(target.summary, "The user rewrote this summary with domain knowledge.");
  assert.notEqual(edited, before);
  writeFileSync(regrPath, edited);

  const result = mergeBundle(mine(repo), graphRoot);
  const conflict = result.conflicts.find(c => c.id === target.id);
  assert.ok(conflict, "hand-edit should be reported as a conflict");
  assert.match(conflict!.reason, /hand-edited/);
  // The user's text is still there.
  const after = readFileSync(regrPath, "utf-8");
  assert.ok(after.includes("The user rewrote this summary with domain knowledge."));
});

test("a hand-authored node with a colliding ID is never overwritten", () => {
  const repo = buildFixtureRepo();
  const graphRoot = buildGraphRoot(repo);
  const bundle = mine(repo);
  const victim = bundle.nodes.find(n => n.type === "Regression")!;

  // User authored a node with the same ID, no Seeded marker.
  const regrPath = join(graphRoot, "regressions.md");
  const userBlock = [
    `## NODE: ${victim.id}`,
    "**Type:** Regression",
    "**Priority:** HIGH",
    "**Label:** User-authored node",
    "**Summary:** Written by a human before seeding.",
    "**Tags:** _(none)_",
    "**Edges:** _(none)_",
    "**Files:** _(none)_",
    "**LastUpdated:** 2026-01-01",
  ].join("\n");
  writeFileSync(regrPath, readFileSync(regrPath, "utf-8") + "\n" + userBlock + "\n");

  const result = mergeBundle(bundle, graphRoot);
  const conflict = result.conflicts.find(c => c.id === victim.id);
  assert.ok(conflict, "collision with hand-authored node should conflict");
  assert.match(conflict!.reason, /hand-authored/);
  assert.ok(readFileSync(regrPath, "utf-8").includes("Written by a human before seeding."));
});

// ── Rendering & round-trip ────────────────────────────────────────────────────

test("rendered seeded nodes parse back with Seeded and Provenance fields", () => {
  const repo = buildFixtureRepo();
  const graphRoot = buildGraphRoot(repo);
  mergeBundle(mine(repo), graphRoot);
  const nodes = loadGraphNodes(graphRoot);
  assert.ok(nodes.length > 0);
  for (const n of nodes) {
    assert.ok(n.seeded, `${n.id} lost its Seeded marker`);
    assert.match(n.seeded!, /hash: [0-9a-f]{8}/);
    assert.ok(n.provenance, `${n.id} lost its Provenance`);
  }
});

test("renderDraft embeds a hash that matches the block's own content", () => {
  const repo = buildFixtureRepo();
  const bundle = mine(repo);
  const rendered = renderDraft(bundle.nodes[0]);
  const parsed = parseNodes(rendered, "test.md")[0];
  const recorded = parsed.seeded!.match(/hash: ([0-9a-f]{8})/)![1];
  // Re-hashing the parsed block (Seeded line excluded) must reproduce it.
  assert.equal(contentHash(rendered), recorded);
});

test("graph_index Quick Index gains the seeded node IDs", () => {
  const repo = buildFixtureRepo();
  const graphRoot = buildGraphRoot(repo);
  const result = mergeBundle(mine(repo), graphRoot);
  const index = readFileSync(join(graphRoot, "graph_index.md"), "utf-8");
  for (const id of result.added) {
    assert.ok(index.includes(id), `${id} missing from Quick Index`);
  }
});

// The Quick Index is advertised as a *derived* view: regenerating it must
// reproduce exactly what a merge leaves behind, or the order-independence that
// makes parallel merges safe does not actually hold. The assertion above
// (index.includes(id)) passes either way, which is why the divergence between
// merge's incremental writer and reindex's rebuild went unnoticed.
test("merge leaves graph_index.md byte-identical to a fresh reindex", () => {
  const repo = buildFixtureRepo();
  const graphRoot = buildGraphRoot(repo);
  mergeBundle(mine(repo), graphRoot);

  const afterMerge = readFileSync(join(graphRoot, "graph_index.md"), "utf-8");
  regenerateIndex(graphRoot);
  const afterReindex = readFileSync(join(graphRoot, "graph_index.md"), "utf-8");

  assert.equal(afterMerge, afterReindex);
});

test("Quick Index entries are sorted, so merge order cannot change the result", () => {
  const repo = buildFixtureRepo();
  const graphRoot = buildGraphRoot(repo);
  const result = mergeBundle(mine(repo), graphRoot);
  assert.ok(result.added.length > 1, "fixture should seed more than one node");

  const index = readFileSync(join(graphRoot, "graph_index.md"), "utf-8");
  for (const line of index.split("\n")) {
    const cells = line.split("|").map(c => c.trim());
    if (cells.length < 4) continue;
    const ids = cells[2].split(",").map(x => x.trim()).filter(x => /^[A-Z][A-Z0-9_]*$/.test(x));
    if (ids.length < 2) continue;
    assert.deepEqual(ids, [...ids].sort(), `Quick Index row not sorted: ${cells[1]}`);
  }
});
