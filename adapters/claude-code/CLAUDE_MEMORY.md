# Memory Graph Instructions for Claude Code

Add this section to your project's `CLAUDE.md` to enable persistent memory graph support.

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

Call `simplegraph_check_files(["path/to/file"])` before modifying code. It returns all
known regressions, watchlists, and invariants that reference those files. Any node with
`REGRESSED_N_TIMES >= 2` is high-risk — proceed with extra care.

Without MCP: follow the `VIOLATED_BY` and `WATCHLIST` edge links in the loaded graph
nodes manually before editing.

### Before Generating Code

Call `simplegraph_anti_patterns()` and check your output against the banned patterns
list before committing.

### After Fixing Bugs or Making Decisions

Update the graph as part of the same commit:

| Situation | Action |
|---|---|
| Bug fixed | `simplegraph_add_node` (type: Regression), then `simplegraph_update_index` |
| Decision made | `simplegraph_add_node` (type: Decision), then `simplegraph_update_index` |
| Bug recurred | `simplegraph_update_node` with `field:"REGRESSED_N_TIMES"`, `value:"increment"` |
| Regression permanently resolved | `simplegraph_archive_regression` |

Full protocol: `core/HOW_TO_UPDATE.md`

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
