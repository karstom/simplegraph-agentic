// parser.ts — node extraction boundaries.
// consistency_check.sh has always ignored HTML comments and fenced code blocks;
// these pin parseNodes to the same definition of "what is a node", so the gate,
// the Quick Index, the search tools and the write path cannot disagree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNodes } from "./parser.js";

const REAL = [
  "## NODE: REG_REAL",
  "**Type:** Regression",
  "**Label:** A real node",
  "**Summary:** Real.",
  "**LastUpdated:** 2026-01-01",
].join("\n");

test("a node inside an HTML comment is not a node", () => {
  const content = `<!-- EXAMPLE (delete this):\n\n## NODE: INV_EXAMPLE\n**Type:** Invariant\n**Label:** Short Human-Readable Name\n\n-->\n\n${REAL}\n`;
  const ids = parseNodes(content, "regressions.md").map(n => n.id);
  assert.deepEqual(ids, ["REG_REAL"]);
});

test("a node inside a fenced code block is not a node", () => {
  const content = "Docs:\n\n```markdown\n## NODE: YOUR_NODE_ID\n**Type:** Invariant\n```\n\n" + REAL + "\n";
  const ids = parseNodes(content, "invariants.md").map(n => n.id);
  assert.deepEqual(ids, ["REG_REAL"]);
});

test("an unterminated fence masks to end of file", () => {
  const content = "```\n## NODE: INV_NEVER_CLOSED\n";
  assert.deepEqual(parseNodes(content, "x.md"), []);
});

test("rawContent is unchanged for real nodes, so seeded hashes still match", () => {
  // A commented-out example sitting between two live nodes must not alter the
  // slice boundaries of either — content hashing depends on rawContent.
  const a = "## NODE: REG_A\n**Label:** A\n";
  const b = "## NODE: REG_B\n**Label:** B\n";
  const withComment = `${a}\n<!--\n\n## NODE: REG_HIDDEN\n**Label:** H\n\n-->\n\n${b}`;
  const nodes = parseNodes(withComment, "regressions.md");
  assert.deepEqual(nodes.map(n => n.id), ["REG_A", "REG_B"]);
  // REG_B is the last node, so its rawContent is the tail verbatim.
  assert.equal(nodes[1].rawContent, b);
});

test("multiple nodes outside any masked region all parse", () => {
  const content = `${REAL}\n\n---\n\n## NODE: INV_SECOND\n**Label:** Second\n`;
  assert.deepEqual(parseNodes(content, "x.md").map(n => n.id), ["REG_REAL", "INV_SECOND"]);
});
