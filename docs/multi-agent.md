# Multi-agent and multi-repo

Concurrent writers, branch merges, and org-level shared graphs.

[← back to the README](../README.md)

---

## Multi-agent development

When several agents write the graph at once — parallel Claude Code sessions, worktree-based subagents, or a whole team — two failure modes appear that a single-agent setup never hits: concurrent writers racing on the same checkout, and parallel branches diverging before they merge. The MCP server and tooling handle both:

| Hazard | Protection |
|---|---|
| **Torn / lost writes** on a shared checkout | Every write is atomic (temp-file + rename); read-modify-write tool calls hold a per-graph lock, so a `REGRESSED_N_TIMES` increment can't be silently dropped |
| **Conflicts on every parallel append** | `core/.gitattributes` marks the node list files `merge=union`, so two branches that each added a node merge cleanly instead of colliding |
| **`graph_index.md` merge conflicts** across branches | The Quick Index is *derived* — regenerate it with `sg reindex` instead of hand-merging; the output is sorted and order-independent, so either side resolves identically |
| **Duplicate node IDs** from two branches | `consistency_check.sh` fails the build when one ID is defined twice (across `core/` and `shared/`) |
| **"Which agent wrote this?"** after a merge | Optional `**Author:**` / `**Session:**` fields (set `SIMPLEGRAPH_AUTHOR` / `SIMPLEGRAPH_SESSION`, or pass `author` / `session` to `add_node`) record provenance for arbitration |
| **A wrong node becoming org-wide law** | The MCP server is read-only against `shared/`, so promotion is a deliberate, human-reviewed act; `consistency_check.sh` validates the shared graph and warns on untraceable org-wide nodes |

Propagation is not instant: an agent's node reaches others only when its branch merges, so commit graph updates in the same commit as the code and land them promptly. Because a graph node is agent-authored text that other agents later load as guidance, keep it in the PR diff where a human reviews it — the same trust boundary a shared `shared/` graph relies on. See [`mcp/README.md`](../mcp/README.md#multi-agent-development) for the full mechanism.

### Seeding, and closing the decision gap

`sg seed` mines the repository deterministically: offline, no API key, full
provenance on every node, and byte-identical output when re-run at the same
commit. That is the whole CLI — it never calls a model.

What it cannot do is judge. Its Decision extractor only fires when a commit
subject starts with an explicit verb (`refactor`, `migrate`, `adopt`, …), so
seeding this repository found 2 Decisions across 43 commits and missed several
recorded in ordinary commit bodies.

That judgment belongs to the agent you already have connected. The MCP server
exposes **`simplegraph_seed_candidates`**, which returns commits whose message
plausibly contains a rationale, along with the message body and a pre-computed
node ID. The agent reads them, decides which actually state *why* rather than
just *what*, and writes the good ones with the ordinary `simplegraph_add_node`.

This means there is no second model, no API key, no separate billing path, and
no new write path — the agent uses whichever model you are already running, and
its writes go through the same atomic, locked, no-clobber tools as everything
else. Two properties make it safe to call repeatedly:

- **Identity comes from git**, not from the agent: a node's ID is derived from
  the commit subject and SHA, so how the agent words it cannot change it.
- **Candidates already written are never returned**, so calling the tool again
  converges on the remaining work instead of duplicating.

The tool's description instructs the agent to skip anything that describes only
what changed. Where the "why" was never written down it cannot be recovered, and
a missing node beats an invented rationale — these are loaded as guidance by
other agents.

Improving the wording of existing nodes needs no special machinery either: read
them with `simplegraph_nodes` and rewrite with `simplegraph_update_node`, which
can now set `Label` as well as `Summary` and `Tags`.

---
