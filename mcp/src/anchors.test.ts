// Anchoring and blast-radius test suite.
//
// Covers the seam that lets simplegraph sit on top of an external structural
// code graph: symbol anchors, Component path ownership, and matchNodes ranking
// a direct edit above something merely reachable from it.
//
// Run: npm test (from mcp/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { parseNodes, formatNode, type GraphNode } from "./parser.js";
import {
  handleAddNode,
  handleUpdateNode,
  matchNodes,
  pathUnderDir,
  symbolMatches,
  summarizeNodes,
  digestNodes,
  envInt,
} from "./index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a parsed node from field overrides, via a real serialize → parse trip. */
function node(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  const text = formatNode({
    id: overrides.id,
    type: overrides.type ?? "Regression",
    priority: overrides.priority ?? "MEDIUM",
    label: overrides.label ?? "A node",
    summary: overrides.summary ?? "Summary.",
    tags: overrides.tags ?? [],
    files: overrides.files ?? [],
    symbols: overrides.symbols ?? [],
    paths: overrides.paths ?? [],
    edges: overrides.edges ?? [],
    lastUpdated: overrides.lastUpdated ?? "2026-01-01",
  });
  return parseNodes(text, "test.md")[0];
}

function tempGraph(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "simplegraph-anchor-"));
  for (const [name, body] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

// ── Serialization ─────────────────────────────────────────────────────────────

test("Symbols and Paths survive a serialize → parse round-trip", () => {
  const n = node({
    id: "REG_ANCHORED",
    files: ["src/auth/token.ts"],
    symbols: ["AuthService.refreshToken", "parseToken"],
    paths: ["src/auth"],
  });
  assert.deepEqual(n.symbols, ["AuthService.refreshToken", "parseToken"]);
  assert.deepEqual(n.paths, ["src/auth"]);
  assert.deepEqual(n.files, ["src/auth/token.ts"]);
});

test("a node with no anchors renders exactly as it did before the fields existed", () => {
  // Guards `sg seed` idempotency: contentHash() runs over the rendered block, so
  // emitting an empty **Symbols:** line would shift every recorded seed hash and
  // make untouched nodes read as hand-edited.
  const rendered = formatNode({
    id: "REG_PLAIN",
    type: "Regression",
    priority: "LOW",
    label: "Plain",
    summary: "No anchors.",
    tags: [],
    files: ["a.ts"],
    edges: [],
    lastUpdated: "2026-01-01",
  });
  assert.ok(!rendered.includes("**Symbols:**"));
  assert.ok(!rendered.includes("**Paths:**"));
  assert.match(rendered, /\*\*Files:\*\* `a\.ts`\n\*\*LastUpdated:\*\*/);
});

// ── pathUnderDir ──────────────────────────────────────────────────────────────

test("an owned directory matches files beneath it but not a sibling with a shared prefix", () => {
  assert.ok(pathUnderDir("src/auth", "src/auth/token.ts"));
  assert.ok(pathUnderDir("src/auth", "src/auth/nested/deep/session.ts"));
  // `authz` starts with `auth` as a string but is a different directory.
  assert.ok(!pathUnderDir("src/auth", "src/authz/token.ts"));
  assert.ok(!pathUnderDir("src/auth", "src/other/token.ts"));
});

test("an owned directory matches an absolute path from an external code graph", () => {
  assert.ok(pathUnderDir("src/auth", "/home/me/proj/src/auth/token.ts"));
  assert.ok(pathUnderDir("src/auth", "C:\\work\\proj\\src\\auth\\token.ts"));
});

test("a directory does not match itself with nothing beneath it missing", () => {
  // Equal-length match is still containment — a node owning `src/auth` should
  // fire when the agent names the directory itself.
  assert.ok(pathUnderDir("src/auth", "src/auth"));
  // But a longer owned path cannot be contained in a shorter target.
  assert.ok(!pathUnderDir("src/auth/deep", "src/auth"));
});

// ── symbolMatches ─────────────────────────────────────────────────────────────

test("a qualified symbol matches its bare form in either direction", () => {
  assert.ok(symbolMatches("AuthService.refreshToken", "refreshToken"));
  assert.ok(symbolMatches("refreshToken", "AuthService.refreshToken"));
  assert.ok(symbolMatches("AuthService::refresh", "refresh"));
  assert.ok(symbolMatches("AuthService#refresh", "refresh"));
  assert.ok(symbolMatches("refreshToken", "refreshtoken"));
});

test("two different owners of the same method name do not match", () => {
  // A bare tail comparison would collide every run/init/handle in the codebase.
  assert.ok(!symbolMatches("AuthService.run", "JobRunner.run"));
  assert.ok(!symbolMatches("Foo.handle", "Bar.handle"));
});

// ── matchNodes ────────────────────────────────────────────────────────────────

test("a node anchored to an edited file is reported as directly affected", () => {
  const hits = matchNodes([node({ id: "REG_A", files: ["src/auth/token.ts"] })], {
    files: ["src/auth/token.ts"],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direct, true);
  assert.match(hits[0].reasons.join(" "), /edited file/);
});

test("a node reachable only through the blast radius is reported as transitive", () => {
  // The regression is recorded against the caller. Editing the callee alone
  // would never surface it without the radius the agent supplies.
  const hits = matchNodes([node({ id: "REG_CALLER", files: ["src/auth/service.ts"] })], {
    files: ["src/auth/parse.ts"],
    related_files: ["src/auth/service.ts"],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direct, false);
  assert.match(hits[0].reasons.join(" "), /blast radius/);
});

test("a symbol anchor fires when the file was renamed out from under the node", () => {
  const hits = matchNodes(
    [node({ id: "REG_MOVED", files: ["src/old/token.ts"], symbols: ["parseToken"] })],
    { files: ["src/new/token.ts"], symbols: ["AuthService.parseToken"] }
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direct, true);
  assert.match(hits[0].reasons.join(" "), /edited symbol/);
});

test("a Component owning a directory fires for any file beneath it", () => {
  const hits = matchNodes(
    [node({ id: "COMP_AUTH", type: "Component", paths: ["src/auth"] })],
    { files: ["src/auth/brand/new/file.ts"] }
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direct, true);
  assert.match(hits[0].reasons.join(" "), /owns path/);
});

test("a node matched both directly and through the radius is reported once, at its strongest reason", () => {
  const hits = matchNodes(
    [node({ id: "REG_BOTH", files: ["src/a.ts", "src/b.ts"] })],
    { files: ["src/a.ts"], related_files: ["src/b.ts"] }
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direct, true);
  const reasons = hits[0].reasons.join(" ");
  assert.match(reasons, /edited file `src\/a\.ts`/);
  // b.ts is still worth naming — it is a second anchor — but only under the radius.
  assert.match(reasons, /blast radius — file `src\/b\.ts`/);
  // a.ts must not be double-reported as both direct and transitive.
  assert.equal((reasons.match(/src\/a\.ts/g) ?? []).length, 1);
});

test("direct hits outrank transitive ones, and HIGH outranks the rest within each band", () => {
  const nodes = [
    node({ id: "REG_RADIUS_HIGH", priority: "HIGH", files: ["src/far.ts"] }),
    node({ id: "REG_DIRECT_LOW", priority: "LOW", files: ["src/here.ts"] }),
    node({ id: "REG_DIRECT_HIGH", priority: "HIGH", files: ["src/here.ts"] }),
    node({ id: "REG_RADIUS_LOW", priority: "LOW", files: ["src/far.ts"] }),
  ];
  const hits = matchNodes(nodes, { files: ["src/here.ts"], related_files: ["src/far.ts"] });
  assert.deepEqual(hits.map(h => h.node.id), [
    "REG_DIRECT_HIGH",
    "REG_DIRECT_LOW",
    "REG_RADIUS_HIGH",
    "REG_RADIUS_LOW",
  ]);
});

test("an unrelated node is not dragged in by a widened radius", () => {
  const hits = matchNodes([node({ id: "REG_ELSEWHERE", files: ["src/billing/invoice.ts"] })], {
    files: ["src/auth/token.ts"],
    related_files: ["src/auth/service.ts", "src/auth/session.ts"],
  });
  assert.equal(hits.length, 0);
});

test("radius symbols alone do not promote a node to directly affected", () => {
  const hits = matchNodes([node({ id: "REG_SYM", symbols: ["AuthService.refresh"] })], {
    files: ["src/auth/parse.ts"],
    related_symbols: ["refresh"],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direct, false);
  assert.match(hits[0].reasons.join(" "), /blast radius — symbol/);
});

// ── Write path ────────────────────────────────────────────────────────────────

test("add_node writes symbol and path anchors", () => {
  const dir = tempGraph({ "regressions.md": "" });
  const result = handleAddNode(
    {
      type: "Regression",
      id: "REG_NEW",
      label: "New",
      summary: "A regression with anchors.",
      priority: "MEDIUM",
      files: ["src/auth/token.ts"],
      symbols: ["AuthService.refreshToken"],
      paths: ["src/auth"],
    },
    dir
  );
  assert.equal(result.isError, undefined);
  const parsed = parseNodes(readFileSync(join(dir, "regressions.md"), "utf-8"), "regressions.md");
  assert.deepEqual(parsed[0].symbols, ["AuthService.refreshToken"]);
  assert.deepEqual(parsed[0].paths, ["src/auth"]);
});

test("update_node inserts Symbols into a node written before the field existed", () => {
  // Every graph in the wild predates these fields. Refusing the update would
  // mean hand-editing each node to adopt anchoring.
  const legacy = [
    "## NODE: REG_LEGACY",
    "**Type:** Regression",
    "**Priority:** MEDIUM",
    "**Label:** Legacy",
    "**Summary:** Written before Symbols existed.",
    "**Tags:** _(none)_",
    "**Edges:** _(none)_",
    "**Files:** `src/auth/token.ts`",
    "**LastUpdated:** 2026-01-01",
    "",
  ].join("\n");
  const dir = tempGraph({ "regressions.md": legacy });

  const result = handleUpdateNode(
    { id: "REG_LEGACY", field: "Symbols", value: "`AuthService.refreshToken`" },
    dir
  );
  assert.equal(result.isError, undefined);

  const content = readFileSync(join(dir, "regressions.md"), "utf-8");
  const parsed = parseNodes(content, "regressions.md");
  assert.deepEqual(parsed[0].symbols, ["AuthService.refreshToken"]);
  // Inserted in formatNode's order — after Files, before LastUpdated.
  assert.match(content, /\*\*Files:\*\*[^\n]*\n\*\*Symbols:\*\*[^\n]*\n\*\*LastUpdated:\*\*/);
  // The rest of the node is untouched.
  assert.equal(parsed[0].label, "Legacy");
  assert.deepEqual(parsed[0].files, ["src/auth/token.ts"]);
});

test("update_node inserts Paths after Symbols when both are being adopted", () => {
  const dir = tempGraph({ "components/AUTH.md": "" });
  handleAddNode(
    {
      type: "Component",
      id: "COMP_AUTH",
      label: "Auth",
      summary: "The auth service.",
      priority: "MEDIUM",
      files: ["src/auth/index.ts"],
      symbols: ["AuthService"],
    },
    dir
  );
  const result = handleUpdateNode({ id: "COMP_AUTH", field: "Paths", value: "`src/auth`" }, dir);
  assert.equal(result.isError, undefined);

  // targetFileForType lowercases the id for Component files.
  const target = join(dir, "components", "comp_auth.md");
  const content = readFileSync(target, "utf-8");
  assert.match(content, /\*\*Symbols:\*\*[^\n]*\n\*\*Paths:\*\*/);
  assert.deepEqual(parseNodes(content, "x.md")[0].paths, ["src/auth"]);
});

test("an existing Symbols field is replaced, not duplicated", () => {
  const dir = tempGraph({ "regressions.md": "" });
  handleAddNode(
    {
      type: "Regression",
      id: "REG_RESYM",
      label: "Resym",
      summary: "Anchors get corrected over time.",
      priority: "LOW",
      files: ["src/a.ts"],
      symbols: ["oldName"],
    },
    dir
  );
  handleUpdateNode({ id: "REG_RESYM", field: "Symbols", value: "`newName`" }, dir);

  const content = readFileSync(join(dir, "regressions.md"), "utf-8");
  assert.equal((content.match(/\*\*Symbols:\*\*/g) ?? []).length, 1);
  assert.deepEqual(parseNodes(content, "regressions.md")[0].symbols, ["newName"]);
});

// ── Regressions found by testing against live repositories ────────────────────

test("an unbackticked Files list is parsed, not silently dropped", () => {
  // Found on a real 251-node graph: the node with the highest recurrence count
  // (×6, fully root-caused) listed its files without backticks, so it parsed as
  // having no anchors and never fired in check_files. It read as healthy in
  // every listing while guarding nothing.
  const block = [
    "## NODE: REG_HANDWRITTEN",
    "**Type:** Regression",
    "**Priority:** HIGH",
    "**Label:** Written by a human, not a tool",
    "**Summary:** Anchors typed by hand.",
    "**Tags:** _(none)_",
    "**Edges:** _(none)_",
    "**Files:** client/src/services/SecuredStatusService.ts, client/src/services/Seed64.ts",
    "**LastUpdated:** 2026-06-02",
  ].join("\n");
  const n = parseNodes(block, "regressions.md")[0];
  assert.deepEqual(n.files, [
    "client/src/services/SecuredStatusService.ts",
    "client/src/services/Seed64.ts",
  ]);
  const hits = matchNodes([n], { files: ["client/src/services/SecuredStatusService.ts"] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direct, true);
});

test("backticks still win when present, and placeholders stay empty", () => {
  const mk = (files: string) => parseNodes(
    ["## NODE: REG_X", "**Type:** Regression", "**Priority:** LOW",
     "**Label:** L", "**Summary:** S", `**Files:** ${files}`,
     "**LastUpdated:** 2026-01-01"].join("\n"),
    "regressions.md"
  )[0];
  assert.deepEqual(mk("`a.ts`, `b.ts`").files, ["a.ts", "b.ts"]);
  assert.deepEqual(mk("_(none)_").files, []);
  assert.deepEqual(mk("(none)").files, []);
  // A stray backtick anywhere means the backticked reading is authoritative.
  assert.deepEqual(mk("`a.ts`, b.ts").files, ["a.ts"]);
});

test("a node's inline edge list is capped so one node cannot flood the response", () => {
  // A seeded top-level Component accumulated 36 CONTAINS edges; dumping them
  // inline cost ~1.4k tokens for a single LOW-priority match.
  const n = node({
    id: "COMP_BIG",
    type: "Component",
    edges: Array.from({ length: 36 }, (_, i) => `CONTAINS → REG_N${i}: seeded`),
  });
  const out = summarizeNodes([n]);
  assert.match(out, /_\(\+30 more — simplegraph_get_node COMP_BIG\)_/);
  assert.ok(out.length < 900, `edge dump not capped: ${out.length} chars`);
});

test("a blast-radius digest stays compact and keeps the recurrence count", () => {
  const n = node({
    id: "REG_LONG",
    priority: "HIGH",
    label: "A long one",
    summary: "x".repeat(4000),
  });
  n.regressedNTimes = 6;
  const out = digestNodes([{ node: n, reasons: ["blast radius — file `a.ts`"], direct: false }]);
  assert.match(out, /\*\*REG_LONG\*\* \(Regression, HIGH, ×6\)/);
  assert.match(out, /matched on: blast radius/);
  assert.ok(out.length < 400, `digest not clipped: ${out.length} chars`);
  assert.match(out, /…$/);
});

// ── Configurable output budget ────────────────────────────────────────────────

test("budget env vars parse, and malformed values fall back instead of zeroing", () => {
  const def = 6;
  assert.equal(envInt({}, "X", def), def);
  assert.equal(envInt({ X: "" }, "X", def), def);
  assert.equal(envInt({ X: "   " }, "X", def), def);
  assert.equal(envInt({ X: "12" }, "X", def), 12);
  assert.equal(envInt({ X: "0" }, "X", def), 0, "0 is a legal budget, not a fallback trigger");
  // A typo must not silently suppress safety output by collapsing the budget.
  assert.equal(envInt({ X: "abc" }, "X", def), def);
  assert.equal(envInt({ X: "-1" }, "X", def), def);
  assert.equal(envInt({ X: "3.5" }, "X", def), def);
  assert.equal(envInt({ X: "1e3" }, "X", def), 1000, "exponent notation is a valid integer");
});

// ── Recurrence counter on a node that never had one ───────────────────────────

test("incrementing a Regression with no counter field actually advances it", () => {
  // formatNode omits **REGRESSED_N_TIMES:** when no value was supplied, so a
  // Regression can exist without the field. The increment used to .replace()
  // against a line that wasn't there: nothing changed, the file was rewritten
  // unchanged, and the tool still reported "0 → 1".
  const dir = tempGraph({ "regressions.md": "" });
  handleAddNode(
    {
      type: "Regression",
      id: "REG_NOCOUNT",
      label: "No counter",
      summary: "Created without regressedNTimes.",
      priority: "MEDIUM",
      files: ["src/a.ts"],
    },
    dir
  );
  const written = readFileSync(join(dir, "regressions.md"), "utf-8");
  assert.ok(!written.includes("**REGRESSED_N_TIMES:**"), "precondition: no counter field");

  const r = handleUpdateNode(
    { id: "REG_NOCOUNT", field: "REGRESSED_N_TIMES", value: "increment" },
    dir
  );
  assert.equal(r.isError, undefined);
  assert.equal(parseNodes(readFileSync(join(dir, "regressions.md"), "utf-8"), "r.md")[0]
    .regressedNTimes, 1, "counter must be persisted, not just reported");
});

test("a bug that keeps recurring still reaches the root-cause gate", () => {
  // The real cost of the no-op: the counter never reached 2, so the gate could
  // never fire on precisely the bug it exists to catch.
  const dir = tempGraph({ "regressions.md": "" });
  handleAddNode(
    {
      type: "Regression",
      id: "REG_RECURS",
      label: "Recurring",
      summary: "Created without a counter, then recurs twice.",
      priority: "MEDIUM",
      files: ["src/a.ts"],
    },
    dir
  );
  handleUpdateNode({ id: "REG_RECURS", field: "REGRESSED_N_TIMES", value: "increment" }, dir);

  const second = handleUpdateNode(
    { id: "REG_RECURS", field: "REGRESSED_N_TIMES", value: "increment" },
    dir
  );
  assert.match(second.content[0].text, /RECURRENCE ROOT-CAUSE GATE/);

  const withCause = handleUpdateNode(
    {
      id: "REG_RECURS",
      field: "REGRESSED_N_TIMES",
      value: "increment",
      root_cause: "No single source of truth; both prior fixes patched a mirror.",
    },
    dir
  );
  assert.equal(withCause.isError, undefined);
  const n = parseNodes(readFileSync(join(dir, "regressions.md"), "utf-8"), "r.md")[0];
  assert.equal(n.regressedNTimes, 2);
  assert.equal(n.priority, "HIGH", "priority auto-upgrades at 2");
  assert.ok(n.rootCause, "root cause is recorded permanently");
});

test("the counter can also be set outright on a node that lacks the field", () => {
  const dir = tempGraph({ "regressions.md": "" });
  handleAddNode(
    { type: "Regression", id: "REG_SET", label: "Set", summary: "S.",
      priority: "LOW", files: ["src/a.ts"] },
    dir
  );
  const r = handleUpdateNode({ id: "REG_SET", field: "REGRESSED_N_TIMES", value: "4" }, dir);
  assert.equal(r.isError, undefined);
  const content = readFileSync(join(dir, "regressions.md"), "utf-8");
  assert.equal(parseNodes(content, "r.md")[0].regressedNTimes, 4);
  // Inserted in formatNode's order: after Tags, before Edges.
  assert.match(content, /\*\*Tags:\*\*[^\n]*\n\*\*REGRESSED_N_TIMES:\*\*/);
});
