// Deterministic selection of commits that may record a decision.
//
// There is no model here and no API key: judgment belongs to whichever agent is
// connected to the MCP server. What is under test is the cost/relevance filter
// that decides which commits are worth an agent's attention, and the git-derived
// node ID that keeps repeated calls from re-offering work already written.

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDecisionCandidates, decisionIdFor } from "./candidates.js";
import type { ExtractorContext, MinedCommit } from "./types.js";

const RATIONALE =
  "We chose SQLite over Postgres because the app is single-user and offline-first; " +
  "a server dependency was rejected as it would complicate deployment for everyone.";

function commit(over: Partial<MinedCommit> = {}): MinedCommit {
  return {
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    subject: "feat: add local persistence",
    body: RATIONALE,
    authorDate: "2026-01-01",
    parents: ["b".repeat(40)],
    files: ["src/db.ts"],
    ...over,
  };
}

function ctxOf(commits: MinedCommit[]): ExtractorContext {
  return { commits, repoRoot: "/tmp/x", headSha: "h", headDate: "2026-01-01" } as ExtractorContext;
}

test("a commit whose body states a rationale is a candidate", () => {
  const { candidates } = selectDecisionCandidates(ctxOf([commit()]), 10);
  assert.equal(candidates.length, 1);
});

test("a body that only describes what changed is not offered", () => {
  const { candidates } = selectDecisionCandidates(ctxOf([
    commit({ body: "Adds a table and updates the migration script, plus a test for the new column." }),
  ]), 10);
  assert.deepEqual(candidates, []);
});

test("thin bodies and merge commits are excluded", () => {
  const { candidates } = selectDecisionCandidates(ctxOf([
    commit({ sha: "1".repeat(40), body: "because reasons" }),               // too short
    commit({ sha: "2".repeat(40), body: RATIONALE, parents: ["x", "y"] }),  // merge
    commit({ sha: "3".repeat(40), body: RATIONALE }),                       // keeper
  ]), 10);
  assert.deepEqual(candidates.map(c => c.sha), ["3".repeat(40)]);
});

test("commits the deterministic extractor already claims are not re-offered", () => {
  const { candidates } = selectDecisionCandidates(ctxOf([
    commit({ sha: "1".repeat(40), subject: "deprecate the antigravity adapter", body: RATIONALE }),
    commit({ sha: "2".repeat(40), subject: "feat: add a gate", body: RATIONALE }),
  ]), 10);
  assert.deepEqual(candidates.map(c => c.sha), ["2".repeat(40)]);
});

// The filter bounds cost; the reviewing agent is the precision filter. Tuning
// this for precision loses real decisions — this repo's Root-Cause Gate commit
// records a choice and its tradeoff without ever writing "because".
test("a long body with no connective is still offered for review", () => {
  const longNoMarker = "Increments to >= 2 are now a hard block until a root_cause argument is supplied. ".repeat(6);
  assert.ok(longNoMarker.length >= 400);
  const { candidates } = selectDecisionCandidates(ctxOf([commit({ body: longNoMarker })]), 10);
  assert.equal(candidates.length, 1);
});

test("explicit rationale outranks a merely long body when the cap bites", () => {
  const { candidates } = selectDecisionCandidates(ctxOf([
    commit({ sha: "1".repeat(40), body: "x".repeat(2000) }),
    commit({ sha: "2".repeat(40), body: RATIONALE }),
  ]), 1);
  assert.equal(candidates[0].sha, "2".repeat(40));
});

test("candidate order does not depend on input order, and the cap is reported", () => {
  const commits = [
    commit({ sha: "1".repeat(40), body: RATIONALE + " short" }),
    commit({ sha: "2".repeat(40), body: RATIONALE + " a much longer explanation ".repeat(5) }),
    commit({ sha: "3".repeat(40), body: RATIONALE + " medium length text here" }),
  ];
  const a = selectDecisionCandidates(ctxOf(commits), 2);
  const b = selectDecisionCandidates(ctxOf([...commits].reverse()), 2);
  assert.deepEqual(a.candidates.map(c => c.sha), b.candidates.map(c => c.sha));
  assert.equal(a.dropped, 1, "candidates over the cap must be counted, not silently dropped");
});

// This is what lets the MCP tool converge: a commit whose node exists is
// filtered out by ID, so repeated calls hand back only genuinely new work.
test("node identity comes from git, so an agent's wording cannot change it", () => {
  const c = commit();
  assert.equal(decisionIdFor(c), decisionIdFor(commit()));
  assert.match(decisionIdFor(c), /^DEC_[A-Z0-9_]+$/);
  assert.notEqual(decisionIdFor(c), decisionIdFor(commit({ sha: "9".repeat(40) })));
});

// An absolute length threshold does not travel between repositories: at a flat
// 400 characters this filter offered half of Zerofeed's 718 commits, whose
// messages are disciplined and long. The threshold is therefore repo-relative.
test("the no-connective threshold calibrates to the repository", () => {
  // Every body is long in absolute terms, but only one is long *here*.
  const verbose = Array.from({ length: 20 }, (_, i) =>
    commit({ sha: String(i).padStart(40, "0"), body: "Describes what changed. ".repeat(30) })
  );
  const outlier = commit({ sha: "f".repeat(40), body: "Describes what changed. ".repeat(200) });

  const { candidates } = selectDecisionCandidates(ctxOf([...verbose, outlier]), 100);
  assert.ok(
    candidates.length < verbose.length,
    `a uniformly verbose repo must not offer nearly all of itself (got ${candidates.length} of ${verbose.length + 1})`
  );
  assert.ok(candidates.some(c => c.sha === "f".repeat(40)), "the outlier must still be offered");
});

test("a repository of uniformly short messages offers none on length alone", () => {
  const short = Array.from({ length: 10 }, (_, i) =>
    commit({ sha: String(i).padStart(40, "0"), body: "Bumps the dependency and regenerates the lockfile for the release." })
  );
  const { candidates } = selectDecisionCandidates(ctxOf(short), 100);
  assert.deepEqual(candidates, [], "the absolute floor must still apply");
});

test("an explicit connective is offered regardless of the repository's norm", () => {
  const verbose = Array.from({ length: 20 }, (_, i) =>
    commit({ sha: String(i).padStart(40, "0"), body: "Describes what changed. ".repeat(40) })
  );
  const shortButReasoned = commit({ sha: "f".repeat(40), body: RATIONALE });
  const { candidates } = selectDecisionCandidates(ctxOf([...verbose, shortButReasoned]), 100);
  assert.ok(candidates.some(c => c.sha === "f".repeat(40)), "stated rationale must never be crowded out");
});

// Vizro squash-merges pull requests: 1,192 of its 1,284 non-merge commits carry
// no prose at all, yet a block of eight Co-authored-by lines clears any length
// floor. Before trailers were stripped, every candidate it offered was metadata.
const TRAILERS = [
  "Signed-off-by: Anna Xiong <anna.xiong@example.com>",
  "Co-authored-by: pre-commit-ci[bot] <66853113+pre-commit-ci[bot]@users.noreply.github.com>",
  "Co-authored-by: Li Nguyen <90609403+huong-li-nguyen@users.noreply.github.com>",
  "Co-authored-by: petar-qb <petar_pejovic@external.example.com>",
  "Co-authored-by: Antony Milne <49395058+antonymilne@users.noreply.github.com>",
  "Co-authored-by: Maximilian Schulz <83698606+maxschulz-COL@users.noreply.github.com>",
  "Co-authored-by: Alexey Snigir <35569332+l0uden@users.noreply.github.com>",
].join("\n");

test("a body that is only git trailers is not a candidate", () => {
  assert.ok(TRAILERS.length > 400, "fixture must clear the absolute length floor");
  const { candidates } = selectDecisionCandidates(
    ctxOf(Array.from({ length: 10 }, (_, i) =>
      commit({ sha: String(i).padStart(40, "0"), body: TRAILERS })
    )),
    100
  );
  assert.deepEqual(candidates, [], "trailer blocks are metadata, not rationale");
});

test("prose is still found when trailers are appended to it", () => {
  const { candidates } = selectDecisionCandidates(
    ctxOf([commit({ body: `${RATIONALE}\n\n${TRAILERS}` })]),
    100
  );
  assert.equal(candidates.length, 1, "a real rationale must survive its trailer block");
});

test("trailer text cannot supply the reasoning marker", () => {
  // "Reviewed-by" contains no marker, but a trailer mentioning a marker word
  // must not qualify a commit on its own.
  const { candidates } = selectDecisionCandidates(
    ctxOf([commit({ body: "Bump version.\n\nCloses: #123 because the release was blocked" })]),
    100
  );
  assert.deepEqual(candidates, []);
});

// Vizro records rationale in PR descriptions, not commits: PR #1537 is ~4,400
// characters of architectural reasoning against a commit body of nothing but
// Co-authored-by lines. The trail points an agent at that text.
import { pullRequestTrail } from "./candidates.js";

const TRAILER_ONLY = "Co-authored-by: bot <bot@example.com>";

function prCommit(n: number, subject: string, files: string[]): MinedCommit {
  return commit({
    sha: String(n).padStart(40, "0"),
    subject: `${subject} (#${n})`,
    body: TRAILER_ONLY,
    files,
  });
}

test("pull request references are recovered from squash-merge subjects", () => {
  const trail = pullRequestTrail(ctxOf([prCommit(1537, "[Bug] Fix meaning of control", ["src/a.py"])]));
  assert.equal(trail.total, 1);
  assert.deepEqual(trail.worthReading.map(p => p.number), ["1537"]);
  assert.equal(trail.worthReading[0].subject, "[Bug] Fix meaning of control", "the (#N) suffix is stripped");
});

test("docs, release and CI pull requests are excluded as plainly not decisions", () => {
  const trail = pullRequestTrail(ctxOf([
    prCommit(1, "[Docs] New tutorial", ["src/a.py"]),
    prCommit(2, "[Release] Release 0.4.2", ["src/a.py"]),
    prCommit(3, "[QA] Notifications tests", ["src/a.py"]),
    prCommit(4, "[CI] bump action", ["src/a.py"]),
    prCommit(5, "[Feat] Introduce DateTimePicker", ["src/a.py"]),
  ]));
  assert.equal(trail.total, 5, "all five still count as PR-bearing");
  assert.deepEqual(trail.worthReading.map(p => p.number), ["5"]);
});

test("a pull request touching no source is excluded", () => {
  const trail = pullRequestTrail(ctxOf([
    prCommit(1, "[Feat] docs only", ["docs/guide.md", "README.md"]),
    prCommit(2, "[Feat] tests only", ["tests/test_a.py", "src/__tests__/b.ts"]),
    prCommit(3, "[Feat] real change", ["src/a.py"]),
  ]));
  assert.deepEqual(trail.worthReading.map(p => p.number), ["3"]);
});

test("a repository with no pull request references reports none", () => {
  const trail = pullRequestTrail(ctxOf([commit({ subject: "fix: direct commit", body: RATIONALE })]));
  assert.equal(trail.total, 0);
  assert.deepEqual(trail.worthReading, []);
});

test("the sample is bounded and the remainder counted", () => {
  const many = Array.from({ length: 25 }, (_, i) => prCommit(i + 1, "[Feat] change", ["src/a.py"]));
  const trail = pullRequestTrail(ctxOf(many), 10);
  assert.equal(trail.worthReading.length, 10);
  assert.equal(trail.more, 15);
});
