<!-- simplegraph-memory-start -->
# Memory Graph Instructions for Codex

Add this section to your project's `AGENTS.md` to enable persistent memory graph support.

---

## Memory Graph

This project uses a persistent memory graph to track regressions, invariants, decisions,
and high-risk code areas across sessions.

### Session Start (mandatory)

**If the simplegraph MCP server is configured:** call `simplegraph_index` as your first
action. It returns the full index and merges any shared team graph automatically.

**If MCP is not available:** read `core/graph_index.md` as your first action instead.

Use the **Task Routing** table in the index to load only the detail files relevant to
your current task — do not load the full graph.

### Before Editing Any File

Call `simplegraph_check_files({files: ["path/to/file"]})` before modifying code. It
returns all known regressions, watchlists, and invariants anchored to that code. Any node
with `REGRESSED_N_TIMES >= 2` is high-risk — proceed with extra care.

**Expand the blast radius first.** A regression is often recorded against the *caller*,
not the line you are changing. Before calling `simplegraph_check_files`, use whatever
structural tool you have — a code-graph MCP server, an LSP, or `grep -r <symbol>` — to
find the callers, dependents, and tests your edit affects, then pass them as
`related_files` / `related_symbols` alongside the `files` and `symbols` you are editing.
Nodes reached that way are reported in a separate "blast radius" group.

Without MCP: follow the `VIOLATED_BY` and `WATCHLIST` edge links in the loaded graph
nodes manually before editing.

### Before Generating Code

Call `simplegraph_anti_patterns()` and check your output against the banned patterns
list before committing.

Without MCP: read `core/anti_patterns.md` manually.

### After Fixing Bugs or Making Decisions

Update the graph as part of the same commit. Protocol is in `core/HOW_TO_UPDATE.md`.

| Situation | Action |
|---|---|
| Bug fixed | `simplegraph_add_node` (type: Regression), then `simplegraph_update_index` |
| Decision made | `simplegraph_add_node` (type: Decision), then `simplegraph_update_index` |
| Bug recurred | `simplegraph_update_node` with `field:"REGRESSED_N_TIMES"`, `value:"increment"` |
| Regression resolved | `simplegraph_archive_regression` |

Without MCP: edit `core/regressions.md` / `core/decisions.md` and update `core/graph_index.md` directly.

### MCP Tools Quick Reference

| Tool | When |
|---|---|
| `simplegraph_index` | Session start (mandatory) |
| `simplegraph_check_files` | Before editing any file |
| `simplegraph_anti_patterns` | Before generating code |
| `simplegraph_get_node` | Fetch a known node by exact ID |
| `simplegraph_search` | Keyword search across all nodes |
| `simplegraph_nodes` | Browse all nodes in a category |
| `simplegraph_add_node` | After fixing a bug or making a decision |
| `simplegraph_update_index` | Immediately after `simplegraph_add_node` |
| `simplegraph_update_node` | Update a field on an existing node |
| `simplegraph_archive_regression` | When a regression is permanently resolved |
| `simplegraph_scratchpad` | Session notes not yet ready to commit as nodes |

If this is a multi-repo project and the index lists a shared graph path, call
`simplegraph_index` — it merges both graphs automatically.
<!-- simplegraph-memory-end -->
