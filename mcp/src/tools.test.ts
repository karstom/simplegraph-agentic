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

// ── simplegraph_seed_candidates ───────────────────────────────────────────────
// The tool that replaced the in-process LLM proposer. There is no model here:
// it hands the calling agent evidence and lets that agent judge. What must hold
// is that repeated calls converge, that already-written work is never re-offered,
// and that a batch cannot blow up the caller's context window.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { handleSeedCandidates } from "./index.js";

const WHY =
  "We chose SQLite over Postgres because the app is single-user and offline-first; " +
  "a server dependency was rejected as it would complicate deployment for everyone.";

/** A repo with a core/ graph inside it, matching the real install layout. */
function repoWithGraph(): { repo: string; graphRoot: string } {
  const repo = mkdtempSync(join(tmpdir(), "sg-cand-"));
  const graphRoot = join(repo, "core");
  mkdirSync(graphRoot, { recursive: true });
  writeFileSync(join(graphRoot, "decisions.md"), "# Decisions\n");
  const git = (...a: string[]) =>
    execFileSync("git", a, {
      cwd: repo,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t",
        GIT_AUTHOR_DATE: "2026-01-01T12:00:00", GIT_COMMITTER_DATE: "2026-01-01T12:00:00",
      },
    });
  git("init", "-q");
  // Commit the scaffold on its own, so later commits contain only their own
  // files and the "did this commit touch core/" signal stays meaningful.
  git("add", "-A");
  git("commit", "-m", "chore: scaffold");
  return { repo, graphRoot };
}

function commitWith(repo: string, subject: string, body: string, file = "a.ts") {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), `// ${subject}\n${Math.random()}\n`);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t",
    GIT_AUTHOR_DATE: "2026-01-01T12:00:00", GIT_COMMITTER_DATE: "2026-01-01T12:00:00",
  };
  execFileSync("git", ["add", "-A"], { cwd: repo, env });
  execFileSync("git", ["commit", "-m", subject, "-m", body], { cwd: repo, env });
}

function idsIn(text: string): string[] {
  return [...text.matchAll(/^### (DEC_\S+)/gm)].map(m => m[1]);
}

test("candidates are offered with the commit body the agent needs to judge", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "feat: add local persistence", WHY);

  const r = handleSeedCandidates({}, graphRoot);
  assert.equal(r.isError, undefined);
  const text = r.content[0].text;
  assert.equal(idsIn(text).length, 1);
  assert.match(text, /single-user and offline-first/, "the rationale must reach the agent");
  assert.match(text, /simplegraph_add_node/, "the agent must be told how to write it back");
  assert.match(text, /do not invent a rationale/i, "the decline guard must travel with the evidence");
});

test("a commit that only says what changed is never offered", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "feat: add a table", "Adds a table and updates the migration script, plus a test for the new column.");
  const r = handleSeedCandidates({}, graphRoot);
  assert.match(r.content[0].text, /no commit message in this history records why/i);
});

// This is what makes the tool safe to call repeatedly: identity is derived from
// git, so a node the agent already wrote is filtered out by ID.
test("a candidate already written to the graph is not offered again", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "feat: add local persistence", WHY);

  const first = handleSeedCandidates({}, graphRoot);
  const id = idsIn(first.content[0].text)[0];

  const added = handleAddNode(
    { type: "Decision", id, label: "Use SQLite", summary: "Chose SQLite.", priority: "MEDIUM" },
    graphRoot
  );
  assert.equal(added.isError, undefined);

  const second = handleSeedCandidates({}, graphRoot);
  assert.ok(!idsIn(second.content[0].text).includes(id), "written work must not be re-offered");
  assert.match(second.content[0].text, /No new decision candidates/);
});

test("limit batches the work and reports how much is left", () => {
  const { repo, graphRoot } = repoWithGraph();
  for (let i = 0; i < 4; i++) commitWith(repo, `feat: change ${i}`, `${WHY} Variant ${i}.`, `f${i}.ts`);

  const r = handleSeedCandidates({ limit: 2 }, graphRoot);
  const text = r.content[0].text;
  assert.equal(idsIn(text).length, 2, "must respect the batch size");
  assert.match(text, /2 further candidate\(s\) available/);
});

test("a long commit body is truncated so a batch cannot blow up the context window", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "feat: big change", WHY + " " + "padding text. ".repeat(400));

  const text = handleSeedCandidates({}, graphRoot).content[0].text;
  assert.match(text, /…\(truncated\)/);
  assert.ok(text.length < 4000, `batch was ${text.length} chars — too large for one node`);
});

test("a graph outside a git repository fails with a clear message", () => {
  const graphRoot = join(mkdtempSync(join(tmpdir(), "sg-nogit-")), "core");
  mkdirSync(graphRoot, { recursive: true });
  const r = handleSeedCandidates({}, graphRoot);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /No git repository found/);
});

test("Label is writable, so wording can be improved with no extra machinery", () => {
  const dir = setupGraph(1);
  const r = handleUpdateNode({ id: "REG_TEST", field: "Label", value: "A clearer name" }, dir);
  assert.equal(r.isError, undefined);
  const nodes = parseNodes(readFileSync(join(dir, "regressions.md"), "utf-8"), "regressions.md");
  assert.equal(nodes[0].label, "A clearer name");
});

// Filtering by derived ID only catches nodes this tool created. Zerofeed's
// graph was built by hand and its 66 Decision nodes share no ID with anything
// derivable from a commit, so the agent must be shown what already exists or it
// will be asked to re-record decisions under a second name.
test("decisions already in the graph are listed so the agent can skip them", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "feat: add local persistence", WHY);
  writeFileSync(
    join(graphRoot, "decisions.md"),
    "# Decisions\n\n## NODE: DEC_HAND_PICKED_NAME\n**Type:** Decision\n" +
    "**Label:** Store locally rather than server-side\n**Summary:** Prior art.\n" +
    "**LastUpdated:** 2026-01-01\n"
  );

  const text = handleSeedCandidates({}, graphRoot).content[0].text;
  assert.match(text, /Decisions already in the graph/);
  assert.match(text, /DEC_HAND_PICKED_NAME: Store locally rather than server-side/);
  assert.match(text, /skip any candidate these already cover/i);
});

test("the remaining count reflects all candidates, not a fetch window", () => {
  const { repo, graphRoot } = repoWithGraph();
  for (let i = 0; i < 12; i++) commitWith(repo, `feat: change ${i}`, `${WHY} Variant ${i}.`, `f${i}.ts`);
  const text = handleSeedCandidates({ limit: 2 }, graphRoot).content[0].text;
  assert.match(text, /10 further candidate\(s\) available/);
});

// Reviewing Zerofeed by hand, 3 of the first 4 candidates were already in the
// graph under hand-chosen names — and the clearest tell was that the commit had
// edited core/ in the same change.
test("a commit that also edited the graph is flagged as probably already recorded", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "feat: add persistence", WHY, "core/decisions.md");

  const text = handleSeedCandidates({}, graphRoot).content[0].text;
  assert.match(text, /also edited the graph — its decision is probably already recorded/);
});

test("an ordinary commit carries no such flag", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "feat: add persistence", WHY, "src/db.ts");
  const text = handleSeedCandidates({}, graphRoot).content[0].text;
  assert.ok(!/probably already recorded/.test(text));
});

// Of 14 Zerofeed candidates reviewed by hand, 6 were already recorded under a
// hand-chosen name — the single largest reason to reject one.
test("a candidate restating an existing decision names the node it duplicates", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "feat(gateway): F-02 durable per-IP-subnet PoW escalation", WHY, "src/gw.ts");
  writeFileSync(
    join(graphRoot, "decisions.md"),
    "# Decisions\n\n## NODE: DEC_F02_DURABLE_SUBNET_ESCALATION\n**Type:** Decision\n" +
    "**Label:** F-02: Durable per-IP-subnet PoW escalation (KV short-TTL counters)\n" +
    "**Summary:** Prior art.\n**LastUpdated:** 2026-01-01\n"
  );

  const text = handleSeedCandidates({}, graphRoot).content[0].text;
  assert.match(text, /Probably already recorded as DEC_F02_DURABLE_SUBNET_ESCALATION/);
});

test("an unrelated existing decision is not reported as a duplicate", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "feat(trust): vouch seed hardening and seed-set vetting", WHY, "src/trust.ts");
  writeFileSync(
    join(graphRoot, "decisions.md"),
    "# Decisions\n\n## NODE: DEC_ARTIFACT_PERSISTENCE\n**Type:** Decision\n" +
    "**Label:** Write-Through R2 Persistence for User-Generated Artifacts\n" +
    "**Summary:** Prior art.\n**LastUpdated:** 2026-01-01\n"
  );
  const text = handleSeedCandidates({}, graphRoot).content[0].text;
  assert.ok(!/Probably already recorded/.test(text));
});

// A caught-up graph and a history that never recorded rationale both yield zero
// candidates, but they call for opposite responses from the agent.
test("a history with no rationale says so, rather than claiming the graph is caught up", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "chore: bump deps", "Co-authored-by: bot <bot@example.com>", "p.json");
  const text = handleSeedCandidates({}, graphRoot).content[0].text;
  assert.match(text, /no commit message in this history records why/i);
  assert.match(text, /from reading the code/);
  assert.ok(!/already represented in the graph/.test(text));
});

test("a caught-up graph reports that its candidates are all already written", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "feat: add persistence", WHY, "src/db.ts");
  const id = [...handleSeedCandidates({}, graphRoot).content[0].text.matchAll(/^### (DEC_\S+)/gm)][0][1];
  handleAddNode({ type: "Decision", id, label: "L", summary: "S", priority: "MEDIUM" }, graphRoot);

  const text = handleSeedCandidates({}, graphRoot).content[0].text;
  assert.match(text, /all are already represented in the graph/);
});

// Vizro's rationale is in its PR descriptions, not its commits — so when the
// history is empty of reasoning but names pull requests, point at those.
test("a squash-merge history points the agent at the pull requests", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "[Feat] Introduce DateTimePicker (#1805)", "Co-authored-by: bot <b@e.com>", "src/a.py");
  commitWith(repo, "[Docs] New tutorial (#1357)", "Co-authored-by: bot <b@e.com>", "src/b.py");

  const text = handleSeedCandidates({}, graphRoot).content[0].text;
  assert.match(text, /name a pull request/);
  assert.match(text, /#1805/);
  assert.ok(!/#1357/.test(text), "a docs PR is not offered as a decision source");
  assert.match(text, /NOT ranked by importance/, "the sample must not imply a ranking it cannot make");
});

// Mining is linear in the window: ~1ms per commit typically, ~5ms on a repo the
// size of DuckDB, where 10,000 commits takes 50s. An interactive tool call has
// to bound that; `sg seed` stays uncapped for batch use.
test("an oversized history window is capped and the caller is told", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "feat: add persistence", WHY, "src/db.ts");

  const text = handleSeedCandidates({ max_commits: 50000 }, graphRoot).content[0].text;
  assert.match(text, /Window capped at 2000 commits \(you asked for 50000\)/);
  assert.match(text, /sg seed/, "the uncapped path must be named");
});

test("a window within the cap draws no note", () => {
  const { repo, graphRoot } = repoWithGraph();
  commitWith(repo, "feat: add persistence", WHY, "src/db.ts");
  const text = handleSeedCandidates({ max_commits: 300 }, graphRoot).content[0].text;
  assert.ok(!/Window capped/.test(text));
});
