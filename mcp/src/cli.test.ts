// Unit tests for cross-platform check, stale, and hook CLI modules.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runCheck } from "./check.js";
import { runStaleCheck } from "./stale.js";
import { runRequireDocHook } from "./hook.js";

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
