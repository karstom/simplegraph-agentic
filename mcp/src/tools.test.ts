// MCP tool test suite — covers the Recurrence Root-Cause Gate and RootCause round-trip.
// Run: npm test (from mcp/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNodes, formatNode } from "./parser.js";
import { handleUpdateNode, handleAddNode } from "./index.js";

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
