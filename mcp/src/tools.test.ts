// MCP tool test suite — covers the Recurrence Root-Cause Gate and RootCause round-trip.
// Run: npm test (from mcp/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNodes, formatNode } from "./parser.js";
import { handleUpdateNode, handleAddNode, pathMatches } from "./index.js";
import { findNodeBlock } from "./parser.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Create a temp directory containing a single Regression node in regressions.md. */
function setupGraph(regressedNTimes: number): string {
  const dir = mkdtempSync(join(tmpdir(), "simplegraph-test-"));
  const nodeText = formatNode({
    id: "REG_TEST",
    type: "Regression",
    priority: regressedNTimes >= 2 ? "HIGH" : "MEDIUM",
    label: "Test Regression",
    summary: "A test regression used in unit tests.",
    tags: ["test"],
    files: ["src/test.ts"],
    edges: [],
    lastUpdated: "2026-01-01",
    regressedNTimes,
  });
  writeFileSync(join(dir, "regressions.md"), nodeText + "\n");
  return dir;
}

/** Create a temp directory with an empty regressions.md. */
function setupEmptyGraph(): string {
  const dir = mkdtempSync(join(tmpdir(), "simplegraph-test-"));
  writeFileSync(join(dir, "regressions.md"), "");
  return dir;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("increment REGRESSED_N_TIMES 1→2 without root_cause is blocked", () => {
  const dir = setupGraph(1);
  const result = handleUpdateNode(
    { id: "REG_TEST", field: "REGRESSED_N_TIMES", value: "increment" },
    dir
  );
  // Soft block: not an error, but contains the gate checklist
  assert.equal(result.isError, undefined);
  assert.ok(result.content[0].text.includes("RECURRENCE ROOT-CAUSE GATE"));
  assert.ok(result.content[0].text.includes("has NOT been applied"));
  // Counter must be unchanged in the file
  const content = readFileSync(join(dir, "regressions.md"), "utf-8");
  const nodes = parseNodes(content, "regressions.md");
  assert.equal(nodes[0].regressedNTimes, 1);
});

test("increment REGRESSED_N_TIMES 1→2 with root_cause succeeds", () => {
  const dir = setupGraph(1);
  const result = handleUpdateNode(
    {
      id: "REG_TEST",
      field: "REGRESSED_N_TIMES",
      value: "increment",
      root_cause: "Source of truth is X; invariant Y was violated; prior fixes added stamps",
    },
    dir
  );
  assert.equal(result.isError, undefined);
  assert.ok(result.content[0].text.includes("1 → 2"));
  assert.ok(result.content[0].text.includes("Gate satisfied"));
  // File state: counter updated, RootCause written, priority HIGH
  const content = readFileSync(join(dir, "regressions.md"), "utf-8");
  const nodes = parseNodes(content, "regressions.md");
  assert.equal(nodes[0].regressedNTimes, 2);
  assert.equal(nodes[0].rootCause, "Source of truth is X; invariant Y was violated; prior fixes added stamps");
  assert.equal(nodes[0].priority, "HIGH");
});

test("increment REGRESSED_N_TIMES 2→3 without root_cause is blocked", () => {
  const dir = setupGraph(2);
  const result = handleUpdateNode(
    { id: "REG_TEST", field: "REGRESSED_N_TIMES", value: "increment" },
    dir
  );
  assert.equal(result.isError, undefined);
  assert.ok(result.content[0].text.includes("RECURRENCE ROOT-CAUSE GATE"));
  // Counter must be unchanged
  const content = readFileSync(join(dir, "regressions.md"), "utf-8");
  const nodes = parseNodes(content, "regressions.md");
  assert.equal(nodes[0].regressedNTimes, 2);
});

test("increment REGRESSED_N_TIMES 0→1 without root_cause passes (gate below threshold)", () => {
  const dir = setupGraph(0);
  const result = handleUpdateNode(
    { id: "REG_TEST", field: "REGRESSED_N_TIMES", value: "increment" },
    dir
  );
  assert.equal(result.isError, undefined);
  assert.ok(!result.content[0].text.includes("GATE"));
  const content = readFileSync(join(dir, "regressions.md"), "utf-8");
  const nodes = parseNodes(content, "regressions.md");
  assert.equal(nodes[0].regressedNTimes, 1);
});

test("non-REGRESSED_N_TIMES field update is unaffected by gate", () => {
  const dir = setupGraph(1);
  const result = handleUpdateNode(
    { id: "REG_TEST", field: "Priority", value: "LOW" },
    dir
  );
  assert.equal(result.isError, undefined);
  assert.ok(!result.content[0].text.includes("GATE"));
  const content = readFileSync(join(dir, "regressions.md"), "utf-8");
  const nodes = parseNodes(content, "regressions.md");
  assert.equal(nodes[0].priority, "LOW");
});

test("add_node Regression with regressedNTimes >= 2 and no root_cause is blocked", () => {
  const dir = setupEmptyGraph();
  const result = handleAddNode(
    {
      type: "Regression",
      id: "REG_HISTORY",
      label: "Historical Bug",
      summary: "Re-importing this regression from history.",
      priority: "HIGH",
      tags: [],
      files: [],
      edges: [],
      regressedNTimes: 3,
    },
    dir
  );
  assert.equal(result.isError, undefined);
  assert.ok(result.content[0].text.includes("RECURRENCE ROOT-CAUSE GATE"));
  // Node must NOT have been written
  const content = readFileSync(join(dir, "regressions.md"), "utf-8");
  assert.equal(content.trim(), "");
});

test("RootCause field survives serialize → parse round-trip", () => {
  const rootCauseText =
    "Source of truth is the backend API; local mirror violates INV_SINGLE_SOURCE; " +
    "prior fixes each added another place to stamp the flag";
  const node = {
    id: "REG_ROUNDTRIP",
    type: "Regression",
    priority: "HIGH",
    label: "Round-trip Test",
    summary: "Verifies RootCause serialization.",
    tags: ["test"],
    files: ["src/test.ts"],
    edges: [],
    lastUpdated: "2026-01-01",
    regressedNTimes: 2,
    rootCause: rootCauseText,
  };
  const formatted = formatNode(node);
  const parsed = parseNodes(formatted, "test.md");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].rootCause, rootCauseText);
  assert.equal(parsed[0].regressedNTimes, 2);
});

// ── Node-block isolation ──────────────────────────────────────────────────────

/** Write a regressions.md containing several nodes verbatim. */
function setupRawGraph(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "simplegraph-test-"));
  writeFileSync(join(dir, "regressions.md"), body);
  return dir;
}

const TWO_NODES = `## NODE: REG_XY
**Type:** Regression
**Priority:** LOW
**Label:** Prefix sibling
**Summary:** Node whose ID starts with the other node's ID.
**Tags:** _(none)_
**REGRESSED_N_TIMES:** 7
**Edges:** _(none)_
**Files:** \`src/xy.ts\`
**LastUpdated:** 2026-01-01

---

## NODE: REG_X
**Type:** Regression
**Priority:** LOW
**Label:** Prefix root
**Summary:** Node whose ID is a prefix of the other node's ID.
**Tags:** _(none)_
**REGRESSED_N_TIMES:** 1
**Edges:** _(none)_
**Files:** \`src/x.ts\`
**LastUpdated:** 2026-01-01
`;

test("incrementing REG_X does not clobber the earlier REG_XY", () => {
  const dir = setupRawGraph(TWO_NODES);
  const result = handleUpdateNode(
    { id: "REG_X", field: "REGRESSED_N_TIMES", value: "increment", root_cause: "rc" },
    dir
  );
  assert.equal(result.isError, undefined);

  const nodes = parseNodes(readFileSync(join(dir, "regressions.md"), "utf-8"), "regressions.md");
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  // REG_X is the one that must advance...
  assert.equal(byId.REG_X.regressedNTimes, 2);
  assert.equal(byId.REG_X.rootCause, "rc");
  // ...and the prefix-sharing sibling must be untouched.
  assert.equal(byId.REG_XY.regressedNTimes, 7);
  assert.equal(byId.REG_XY.rootCause, undefined);
  assert.equal(byId.REG_XY.priority, "LOW");
});

test("generic field update on REG_X does not clobber REG_XY", () => {
  const dir = setupRawGraph(TWO_NODES);
  const result = handleUpdateNode({ id: "REG_X", field: "Priority", value: "HIGH" }, dir);
  assert.equal(result.isError, undefined);

  const nodes = parseNodes(readFileSync(join(dir, "regressions.md"), "utf-8"), "regressions.md");
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  assert.equal(byId.REG_X.priority, "HIGH");
  assert.equal(byId.REG_XY.priority, "LOW");
});

test("findNodeBlock matches whole IDs only, not prefixes", () => {
  const loc = findNodeBlock(TWO_NODES, "REG_X");
  assert.ok(loc, "REG_X should be found");
  assert.ok(loc!.block.startsWith("## NODE: REG_X\n"));
  assert.ok(!loc!.block.includes("REG_XY"), "block must not extend into REG_XY");
  assert.equal(findNodeBlock(TWO_NODES, "REG_NOPE"), null);
});

test("a value containing $-substitution patterns is written literally", () => {
  const dir = setupGraph(1);
  const value = "cost was $1 and $& stayed literal";
  const result = handleUpdateNode({ id: "REG_TEST", field: "Summary", value }, dir);
  assert.equal(result.isError, undefined);
  const nodes = parseNodes(readFileSync(join(dir, "regressions.md"), "utf-8"), "regressions.md");
  assert.equal(nodes[0].summary, value);
});

test("a field name containing regex metacharacters is rejected, not executed", () => {
  const dir = setupGraph(1);
  const result = handleUpdateNode({ id: "REG_TEST", field: "Summ.*ry", value: "x" }, dir);
  assert.equal(result.isError, true);
  // The original Summary must be untouched — the pattern must not have matched it.
  const nodes = parseNodes(readFileSync(join(dir, "regressions.md"), "utf-8"), "regressions.md");
  assert.equal(nodes[0].summary, "A test regression used in unit tests.");
});

test("updates leave no stray temp files behind", () => {
  const dir = setupGraph(1);
  handleUpdateNode({ id: "REG_TEST", field: "Priority", value: "HIGH" }, dir);
  const leftovers = readdirSync(dir).filter(f => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

// ── check_files path matching ─────────────────────────────────────────────────

test("pathMatches aligns on path segments, not raw substrings", () => {
  // The bug this replaced: "auth.ts".includes / "src/xauth.ts".includes matched.
  assert.equal(pathMatches("src/xauth.ts", "auth.ts"), false);
  assert.equal(pathMatches("src/auth.ts", "auth.ts"), true);
  assert.equal(pathMatches("src/auth.ts", "src/auth.ts"), true);
  assert.equal(pathMatches("src/auth.ts", "/repo/src/auth.ts"), true);
  assert.equal(pathMatches("src/auth.ts", "lib/auth.ts"), false);
  assert.equal(pathMatches("src\\auth.ts", "src/auth.ts"), true);
  assert.equal(pathMatches("src/auth.ts", "./src/auth.ts"), true);
});

test("a heading carrying trailing text still resolves to its node", () => {
  const dir = setupRawGraph(
    `## NODE: REG_LABELLED — some trailing label\n` +
    `**Type:** Regression\n**Priority:** LOW\n**Label:** L\n**Summary:** S\n` +
    `**Tags:** _(none)_\n**Edges:** _(none)_\n**Files:** _(none)_\n**LastUpdated:** 2026-01-01\n`
  );
  const result = handleUpdateNode({ id: "REG_LABELLED", field: "Priority", value: "HIGH" }, dir);
  assert.equal(result.isError, undefined);
  const nodes = parseNodes(readFileSync(join(dir, "regressions.md"), "utf-8"), "regressions.md");
  assert.equal(nodes[0].priority, "HIGH");
});
