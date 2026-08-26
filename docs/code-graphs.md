# Working on top of a structural code graph

How simplegraph composes with codebase-memory-mcp, code-review-graph, Graphify, or an LSP.

[← back to the README](../README.md)

---

## Works on top of your code graph

simplegraph stores **judgment**: what regressed, what's forbidden, why the code is the
way it is. It does not parse your source, and it will not try to.

That makes it complementary to the structural code-graph tools —
[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp),
code-review-graph, [Graphify](https://github.com/graphify) — rather than a competitor.
They index functions, calls, imports and types with tree-sitter and answer *"what does
this edit touch?"* in one tool call. Nothing in an AST can tell you that
`REG_TOKEN_LEAK` has happened three times.

**They tell the agent what the code is. simplegraph tells it what the code has done to you.**

The seam is `simplegraph_check_files`. Ask your structural tool for the blast radius
first, then hand it over:

```jsonc
simplegraph_check_files({
  "files":           ["src/auth/parse.ts"],       // what you're editing
  "symbols":         ["parseToken"],
  "related_files":   ["src/auth/service.ts"],     // its callers, from the code graph
  "related_symbols": ["AuthService.refreshToken"]
})
```

Results come back in two groups — **Directly affected**, then **In the blast radius** —
each with a `Matched on:` line explaining why it fired. A structural graph knows
`service.ts` is affected by your edit. Only simplegraph knows it broke twice last
quarter and why the last fix was symptomatic.

Any expansion source works, including none: a code-graph MCP server, an LSP,
`grep -r <symbol>`, or nothing at all — the arguments are optional and an
unexpanded call behaves exactly as it did before.

### Anchors

Nodes participate through three optional fields, all matched by `check_files`:

| Field | Matching | Use for |
|---|---|---|
| `**Files:**` | Path suffix | The specific files a node is about |
| `**Symbols:**` | Symbol name, qualified or bare | The function or class it's really about |
| `**Paths:**` | Directory containment | Component ownership of an area |

`**Symbols:**` is the one that pays for itself. A path-only anchor breaks silently
the moment a file is renamed — the node still reads as live but no longer guards
anything. A symbol survives the move, and fires when a *caller* is edited, which is
usually where the bug actually gets reintroduced.

`**Paths:**` belongs on Component nodes: `COMP_AUTH` owning `src/auth` fires for any
file beneath it, including files that didn't exist when the node was written. Keeping
it to Components is deliberate — directory ownership on a Regression would fire on
every unrelated edit in the area and train the agent to ignore the tool.

`scripts/stale_check.sh` checks both: `Paths` that are no longer directories, and
`Symbols` absent from `auto_map.md`.

The `check_files` response is budgeted so a widened radius can't flood the context:
full records for the top-ranked direct hits, one-line digests for the rest, capped
inline edge lists. Nothing on the direct path is hidden — past the limit it is
summarized. Tune it with `SIMPLEGRAPH_CHECK_DETAIL_LIMIT`, `SIMPLEGRAPH_CHECK_DIGEST_LIMIT`,
`SIMPLEGRAPH_CHECK_DIGEST_CHARS`, and `SIMPLEGRAPH_EDGE_PREVIEW` (see
[`mcp/README.md`](../mcp/README.md)).

Existing graphs need no migration. All three fields are optional, nodes without them
behave exactly as before, and `simplegraph_update_node` inserts `Symbols` / `Paths`
into nodes that predate the fields rather than refusing the write.

---
