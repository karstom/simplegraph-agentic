// Unit tests for cross-platform check, stale, and hook CLI modules.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runCheck } from "./check.js";
import { runStaleCheck } from "./stale.js";
import { runRequireDocHook } from "./hook.js";
import { runCorrectCli } from "./seed/cli.js";

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("runCheck: passes on a clean graph with valid edges", () => {
  const tmp = makeTmpDir("sg_check_clean_");
  try {
    const core = path.join(tmp, "core");
    fs.mkdirSync(core, { recursive: true });

    fs.writeFileSync(
      path.join(core, "invariants.md"),
      `## NODE: INV_TOKEN_EXPIRY\n**Type:** Invariant\n**Priority:** HIGH\n**Label:** Token Expiry\n**Summary:** Tokens must expire in 1h.\n**Edges:**\n- EXTENDS → INV_AUTH_BASE: base rule\n**Files:** \`src/auth.ts\`\n**LastUpdated:** 2026-09-01\n`
    );

    fs.writeFileSync(
      path.join(core, "decisions.md"),
      `## NODE: INV_AUTH_BASE\n**Type:** Decision\n**Priority:** MEDIUM\n**Label:** Auth Base\n**Summary:** Base auth architecture.\n**Edges:**\n**Files:** \`src/auth.ts\`\n**LastUpdated:** 2026-09-01\n`
    );

    const res = runCheck({ graphRoot: core, sharedRoot: null });
    assert.equal(res.ok, true);
    assert.equal(res.nodeCount, 2);
    assert.equal(res.edgeCount, 1);
    assert.equal(res.duplicateIds.length, 0);
    assert.equal(res.brokenEdges.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runCheck: catches duplicate node IDs across files", () => {
  const tmp = makeTmpDir("sg_check_dupe_");
  try {
    const core = path.join(tmp, "core");
    fs.mkdirSync(core, { recursive: true });

    fs.writeFileSync(
      path.join(core, "f1.md"),
      `## NODE: REG_DUPLICATE_ID\n**Type:** Regression\n**Priority:** HIGH\n**Label:** First\n**Summary:** Bug 1.\n**Edges:**\n**Files:**\n**LastUpdated:** 2026-09-01\n`
    );

    fs.writeFileSync(
      path.join(core, "f2.md"),
      `## NODE: REG_DUPLICATE_ID\n**Type:** Regression\n**Priority:** HIGH\n**Label:** Second\n**Summary:** Bug 2.\n**Edges:**\n**Files:**\n**LastUpdated:** 2026-09-01\n`
    );

    const res = runCheck({ graphRoot: core, sharedRoot: null });
    assert.equal(res.ok, false);
    assert.equal(res.duplicateIds.length, 1);
    assert.equal(res.duplicateIds[0].id, "REG_DUPLICATE_ID");
    assert.match(res.output, /Duplicate node IDs found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runCheck: catches broken edge references", () => {
  const tmp = makeTmpDir("sg_check_broken_");
  try {
    const core = path.join(tmp, "core");
    fs.mkdirSync(core, { recursive: true });

    fs.writeFileSync(
      path.join(core, "invariants.md"),
      `## NODE: INV_ALPHA\n**Type:** Invariant\n**Priority:** HIGH\n**Label:** Alpha\n**Summary:** Rule.\n**Edges:**\n- VIOLATED_BY → REG_NONEXISTENT: missing target\n**Files:**\n**LastUpdated:** 2026-09-01\n`
    );

    const res = runCheck({ graphRoot: core, sharedRoot: null });
    assert.equal(res.ok, false);
    assert.equal(res.brokenEdges.length, 1);
    assert.equal(res.brokenEdges[0].target, "REG_NONEXISTENT");
    assert.match(res.output, /Broken edge references found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runCheck: ignores prose arrows and arrows in edge explanations, supports dot-separated targets", () => {
  const tmp = makeTmpDir("sg_check_prose_");
  try {
    const core = path.join(tmp, "core");
    fs.mkdirSync(core, { recursive: true });

    fs.writeFileSync(
      path.join(core, "regressions.md"),
      `## NODE: REG_TEST_PROSE\n**Type:** Regression\n**Priority:** HIGH\n**Label:** Prose Test\n**Summary:** cache purge (dashboard → Caching → Purge Everything), no stats block → FAIL, (reject → ACCEPT).\n**Edges:**\n- VIOLATED_BY → INV_BETA · INV_GAMMA: explanation ending in arrow → MISSING\n**Files:**\n**LastUpdated:** 2026-09-01\n`
    );

    fs.writeFileSync(
      path.join(core, "invariants.md"),
      `## NODE: INV_BETA\n**Type:** Invariant\n**Priority:** HIGH\n**Label:** Beta\n**Summary:** Beta rule.\n**Edges:**\n**Files:**\n**LastUpdated:** 2026-09-01\n\n---\n\n## NODE: INV_GAMMA\n**Type:** Invariant\n**Priority:** HIGH\n**Label:** Gamma\n**Summary:** Gamma rule.\n**Edges:**\n**Files:**\n**LastUpdated:** 2026-09-01\n`
    );

    const res = runCheck({ graphRoot: core, sharedRoot: null });
    assert.equal(res.ok, true);
    assert.equal(res.brokenEdges.length, 0);
    assert.equal(res.edgeCount, 2); // INV_BETA and INV_GAMMA
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runStaleCheck: detects outdated dates and missing files", () => {
  const tmp = makeTmpDir("sg_stale_");
  try {
    const core = path.join(tmp, "core");
    fs.mkdirSync(core, { recursive: true });

    fs.writeFileSync(
      path.join(core, "regressions.md"),
      `## NODE: REG_OLD_BUG\n**Type:** Regression\n**Priority:** HIGH\n**Label:** Old\n**Summary:** Old bug.\n**Edges:**\n**Files:** \`src/deleted_file.ts\`\n**Paths:** \`src/deleted_dir\`\n**LastUpdated:** 2020-01-01\n`
    );

    const res = runStaleCheck({ graphRoot: core, repoRoot: tmp, maxAgeDays: 90 });
    assert.equal(res.ok, false);
    assert.equal(res.staleDates.length, 1);
    assert.equal(res.staleDates[0].id, "REG_OLD_BUG");
    assert.equal(res.missingFiles.length, 1);
    assert.equal(res.missingFiles[0].target, "src/deleted_file.ts");
    assert.equal(res.missingPaths.length, 1);
    assert.equal(res.missingPaths[0].target, "src/deleted_dir");
    // Verify single-line format with multiple reasons combined
    assert.match(res.output, /REG_OLD_BUG \[HIGH\] — unmodified since 2020-01-01 \(> 90d\); missing file: src\/deleted_file\.ts; missing directory: src\/deleted_dir\//);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runStaleCheck: ignores archive/ directory and filters to HIGH priority by default", () => {
  const tmp = makeTmpDir("sg_stale_filter_");
  try {
    const core = path.join(tmp, "core");
    const archive = path.join(core, "archive");
    fs.mkdirSync(archive, { recursive: true });

    // Node in archive/ - should be completely ignored
    fs.writeFileSync(
      path.join(archive, "resolved.md"),
      `## NODE: REG_ARCHIVED\n**Type:** Regression\n**Priority:** HIGH\n**Label:** Archived\n**Summary:** Resolved.\n**Edges:**\n**Files:** \`src/nonexistent_archived.ts\`\n**LastUpdated:** 2019-01-01\n`
    );

    // Medium priority node with old date
    fs.writeFileSync(
      path.join(core, "medium.md"),
      `## NODE: REG_MEDIUM_OLD\n**Type:** Regression\n**Priority:** MEDIUM\n**Label:** Medium\n**Summary:** Medium.\n**Edges:**\n**Files:**\n**LastUpdated:** 2020-01-01\n`
    );

    // High priority node that is fresh
    fs.writeFileSync(
      path.join(core, "high_fresh.md"),
      `## NODE: REG_HIGH_FRESH\n**Type:** Regression\n**Priority:** HIGH\n**Label:** Fresh\n**Summary:** Fresh.\n**Edges:**\n**Files:**\n**LastUpdated:** 2026-09-10\n`
    );

    // Default: highOnly=true. REG_ARCHIVED ignored (in archive), REG_MEDIUM_OLD ignored (not HIGH), REG_HIGH_FRESH is fresh
    const resDefault = runStaleCheck({ graphRoot: core, repoRoot: tmp, maxAgeDays: 90 });
    assert.equal(resDefault.ok, true);
    assert.equal(resDefault.staleDates.length, 0);

    // With all: true -> REG_MEDIUM_OLD should be flagged
    const resAll = runStaleCheck({ graphRoot: core, repoRoot: tmp, maxAgeDays: 90, all: true });
    assert.equal(resAll.ok, false);
    assert.equal(resAll.staleDates.length, 1);
    assert.equal(resAll.staleDates[0].id, "REG_MEDIUM_OLD");
    // REG_ARCHIVED still ignored because archive/ is never scanned
    assert.equal(resAll.missingFiles.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runRequireDocHook: allows when skip env var is present or stop_hook_active", () => {
  const res1 = runRequireDocHook({ stdinPayload: '{"stop_hook_active": true}' });
  assert.equal(res1.decision, "allow");

  process.env.SIMPLEGRAPH_SKIP_DOC_HOOK = "1";
  try {
    const res2 = runRequireDocHook({});
    assert.equal(res2.decision, "allow");
  } finally {
    delete process.env.SIMPLEGRAPH_SKIP_DOC_HOOK;
  }
});

test("runCorrectCli: records correction on node via CLI", async () => {
  const tmp = makeTmpDir("sg_cli_correct_");
  try {
    const core = path.join(tmp, "core");
    fs.mkdirSync(core, { recursive: true });
    fs.writeFileSync(
      path.join(core, "regressions.md"),
      `## NODE: REG_TEST_CORRECT\n**Type:** Regression\n**Priority:** HIGH\n**Label:** Correct me\n**Summary:** Old wrong theory.\n**Edges:**\n**Files:**\n**LastUpdated:** 2026-01-01\n`
    );

    const code = await runCorrectCli(["REG_TEST_CORRECT", "The bug was actually in cache invalidation", "--date", "2026-09-12", "--graph", core]);
    assert.equal(code, 0);

    const content = fs.readFileSync(path.join(core, "regressions.md"), "utf-8");
    assert.ok(content.includes("⚠ CORRECTED 2026-09-12: The bug was actually in cache invalidation"));
    assert.ok(content.includes("**LastUpdated:** 2026-09-12"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
