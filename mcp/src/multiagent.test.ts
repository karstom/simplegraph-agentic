// Multi-agent safety test suite — covers the three concurrency-hardening
// changes: atomic writes + graph locking (fsutil), a derived/regenerable
// Quick Index (reindex), and Author/Session attribution (parser + add_node).
// Run: npm test (from mcp/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNodes, formatNode } from "./parser.js";
import { atomicWriteFileSync, withGraphLock } from "./fsutil.js";
import { regenerateIndexContent, regenerateIndex } from "./reindex.js";
import { handleAddNode } from "./index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sg-multiagent-"));
}

const INDEX_TEMPLATE = [
  "# Graph — Index",
  "",
  "| Category | Nodes | File |",
  "|---|---|---|",
  "| **Components** | _(add your component node IDs here)_ | `components/{NAME}.md` |",
  "| **Invariants** | _(add here)_ | `invariants.md` |",
  "| **Active Regressions** | _(add here)_ | `regressions.md` |",
  "| **Decisions** | _(add here)_ | `decisions.md` |",
  "| **Watchlists & Open Issues** | _(add here)_ | `watchlists.md` |",
  "| **Anti-Patterns** | _(never generate)_ | `anti_patterns.md` |",
  "",
  "## Task Routing",
  "| If working on... | Load |",
  "|---|---|",
  "| **Auth** | `invariants.md` |",
  "",
].join("\n");

function graphWithIndex(): string {
  const dir = tmp();
  writeFileSync(join(dir, "graph_index.md"), INDEX_TEMPLATE);
  for (const f of ["regressions.md", "invariants.md", "decisions.md", "watchlists.md"]) {
    writeFileSync(join(dir, f), "");
  }
  return dir;
}

// ── Atomic writes ─────────────────────────────────────────────────────────────

test("atomicWriteFileSync writes content and leaves no temp file behind", () => {
  const dir = tmp();
  const target = join(dir, "regressions.md");
  atomicWriteFileSync(target, "hello graph\n");
  assert.equal(readFileSync(target, "utf-8"), "hello graph\n");
  const leftovers = readdirSync(dir).filter(f => f.includes(".tmp"));
  assert.deepEqual(leftovers, [], "temp file should be renamed away, not left behind");
});

test("atomicWriteFileSync replaces existing content in place", () => {
  const dir = tmp();
  const target = join(dir, "f.md");
  atomicWriteFileSync(target, "v1");
  atomicWriteFileSync(target, "v2");
  assert.equal(readFileSync(target, "utf-8"), "v2");
});

// ── Graph lock ────────────────────────────────────────────────────────────────

test("withGraphLock runs the function and releases the lock afterward", () => {
  const dir = tmp();
  let ran = false;
  const out = withGraphLock(dir, () => { ran = true; return 42; });
  assert.equal(ran, true);
  assert.equal(out, 42);
  assert.equal(existsSync(join(dir, ".sg.lock")), false, "lock file should be released");
});

test("withGraphLock releases the lock even when the function throws", () => {
  const dir = tmp();
  assert.throws(() => withGraphLock(dir, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(join(dir, ".sg.lock")), false, "lock must be released on throw");
});

test("withGraphLock steals a stale lock left by a dead process", () => {
  const dir = tmp();
  // A lock with a timestamp far in the past simulates a crashed holder.
  writeFileSync(join(dir, ".sg.lock"), `999999 ${Date.now() - 60_000}`);
  let ran = false;
  withGraphLock(dir, () => { ran = true; });
  assert.equal(ran, true, "a stale lock should be stolen, not block forever");
});

// ── Author / Session round-trip ───────────────────────────────────────────────

test("Author and Session survive a formatNode → parseNodes round-trip", () => {
  const formatted = formatNode({
    id: "REG_ATTR", type: "Regression", priority: "HIGH",
    label: "Attributed", summary: "Has attribution.",
    tags: ["x"], files: ["a.ts"], edges: [], lastUpdated: "2026-01-01",
    author: "agent-alice", session: "sess-123",
  });
  const parsed = parseNodes(formatted, "regressions.md");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].author, "agent-alice");
  assert.equal(parsed[0].session, "sess-123");
});

test("nodes without attribution render exactly as before (no Author/Session lines)", () => {
  const formatted = formatNode({
    id: "REG_PLAIN", type: "Regression", priority: "LOW",
    label: "Plain", summary: "No attribution.",
    tags: [], files: [], edges: [], lastUpdated: "2026-01-01",
  });
  assert.ok(!formatted.includes("**Author:**"), "no Author line when unset");
  assert.ok(!formatted.includes("**Session:**"), "no Session line when unset");
});

test("add_node stamps Author and Session from arguments", () => {
  const dir = graphWithIndex();
  const result = handleAddNode(
    {
      type: "Decision", id: "DEC_X", label: "A decision",
      summary: "Chose X over Y.", priority: "MEDIUM",
      author: "agent-bob", session: "sess-xyz",
    },
    dir
  );
  assert.equal(result.isError, undefined);
  const parsed = parseNodes(readFileSync(join(dir, "decisions.md"), "utf-8"), "decisions.md");
  assert.equal(parsed[0].author, "agent-bob");
  assert.equal(parsed[0].session, "sess-xyz");
});

// ── Regenerable Quick Index ───────────────────────────────────────────────────

function nodeBlock(id: string, type: string, extra = ""): string {
  return [
    `## NODE: ${id}`, `**Type:** ${type}`, "**Priority:** LOW",
    `**Label:** ${id}`, "**Summary:** s.", "**Tags:** _(none)_",
    extra, "**Edges:** _(none)_", "**Files:** _(none)_", "**LastUpdated:** 2026-01-01",
  ].filter(Boolean).join("\n");
}

test("regenerateIndex lists nodes sorted in the Quick Index and clears placeholders", () => {
  const dir = graphWithIndex();
  writeFileSync(join(dir, "decisions.md"), `${nodeBlock("DEC_ZEBRA", "Decision")}\n\n---\n\n${nodeBlock("DEC_APPLE", "Decision")}\n`);
  const res = regenerateIndex(dir);
  const index = readFileSync(join(dir, "graph_index.md"), "utf-8");
  const row = index.split("\n").find(l => l.includes("**Decisions**"))!;
  // Sorted, comma-joined, placeholder gone.
  assert.match(row, /DEC_APPLE, DEC_ZEBRA/);
  assert.ok(!row.includes("_(add here)_"));
  assert.equal(res.rows.find(r => r.label === "Decisions")!.count, 2);
});

test("regenerateIndex annotates recurring regressions with (×N)", () => {
  const dir = graphWithIndex();
  writeFileSync(join(dir, "regressions.md"), nodeBlock("REG_HOT", "Regression", "**REGRESSED_N_TIMES:** 3") + "\n");
  regenerateIndex(dir);
  const index = readFileSync(join(dir, "graph_index.md"), "utf-8");
  assert.match(index, /REG_HOT\(×3\)/);
});

test("regenerated index is order-independent (the merge-conflict property)", () => {
  // Two graphs with the same nodes added in opposite order must yield byte-identical indexes.
  const a = graphWithIndex();
  const b = graphWithIndex();
  writeFileSync(join(a, "invariants.md"), `${nodeBlock("INV_A", "Invariant")}\n\n---\n\n${nodeBlock("INV_B", "Invariant")}\n`);
  writeFileSync(join(b, "invariants.md"), `${nodeBlock("INV_B", "Invariant")}\n\n---\n\n${nodeBlock("INV_A", "Invariant")}\n`);
  regenerateIndex(a);
  regenerateIndex(b);
  assert.equal(readFileSync(join(a, "graph_index.md"), "utf-8"), readFileSync(join(b, "graph_index.md"), "utf-8"));
});

test("regenerateIndex is idempotent (running twice changes nothing)", () => {
  const dir = graphWithIndex();
  writeFileSync(join(dir, "watchlists.md"), nodeBlock("WATCH_1", "Watchlist") + "\n");
  regenerateIndex(dir);
  const once = readFileSync(join(dir, "graph_index.md"), "utf-8");
  regenerateIndex(dir);
  const twice = readFileSync(join(dir, "graph_index.md"), "utf-8");
  assert.equal(twice, once);
});

test("regenerateIndexContent leaves the Task Routing section untouched", () => {
  const nodes = parseNodes(nodeBlock("INV_KEEP", "Invariant"), "invariants.md");
  const { content } = regenerateIndexContent(INDEX_TEMPLATE, nodes);
  assert.ok(content.includes("## Task Routing"), "Task Routing header preserved");
  assert.ok(content.includes("| **Auth** | `invariants.md` |"), "Task Routing rows preserved");
  assert.ok(content.includes("INV_KEEP"), "node listed in Quick Index");
});

test("add_node auto-regenerates the Quick Index", () => {
  const dir = graphWithIndex();
  handleAddNode(
    { type: "Watchlist", id: "WATCH_AUTO", label: "Auto", summary: "s.", priority: "LOW" },
    dir
  );
  const index = readFileSync(join(dir, "graph_index.md"), "utf-8");
  assert.ok(index.includes("WATCH_AUTO"), "add_node should refresh the index without a separate call");
});
