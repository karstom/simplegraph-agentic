<!-- simplegraph-memory-start -->
# Memory Graph Instructions for Codex

Add this section to your project's `AGENTS.md` to enable persistent memory graph support.

---

## Memory Graph

This project uses a persistent memory graph to track regressions, invariants, decisions,
and high-risk code areas across sessions.

### Session Start (mandatory)

CRITICAL: Read `core/graph_index.md` as your very first action in every conversation,
without exception. It is ~40 lines. Do not skip this step. Do not load the full graph.

Use the **Task Routing** table in the index to load only the detail files relevant to
your current task.

### Before Editing Any File

Check the graph nodes that reference the file you're about to modify:
- Follow any `VIOLATED_BY` edges to find Invariants the file could break
- Follow any `WATCHLIST` edges to find known dangerous areas
- Any Regression node with `REGRESSED_N_TIMES >= 2` means the code is high-risk — proceed carefully

### Before Generating Code

Read `core/anti_patterns.md` and verify your output does not match any banned pattern.

### After Fixing Bugs or Making Decisions

Update the graph as part of the same commit. Protocol is in `core/HOW_TO_UPDATE.md`.

| Situation | Action |
|---|---|
| Bug fixed | Add a Regression node to `core/regressions.md`, update `core/graph_index.md` |
| Decision made | Add a Decision node to `core/decisions.md`, update `core/graph_index.md` |
| Bug recurred | Increment `REGRESSED_N_TIMES` on the existing Regression node |
| Regression resolved | Move the node to `core/archive/resolved_regressions.md` |

### Multi-Repo

If `core/graph_index.md` lists a shared graph path, read that index too when working
across repository boundaries.
<!-- simplegraph-memory-end -->
