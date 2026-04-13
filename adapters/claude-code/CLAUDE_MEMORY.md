# Memory Graph Instructions for Claude Code

Add this section to your project's `CLAUDE.md` to enable persistent memory graph support.

---

## Memory Graph

This project uses a persistent memory graph. Read `core/graph_index.md` at the start of
every session before touching any code. It is ~40 lines and tells you exactly which files
to load for your current task. Do not load the full graph — only load detail files listed
in the task routing table that are relevant to your current task.

Before modifying any component, follow its edge links in the graph to check for
`VIOLATED_BY` regressions and `WATCHLIST` entries. Any node with `REGRESSED_N_TIMES >= 2`
is high-risk code.

After fixing a bug or making a significant decision, update the graph as part of the same
commit. Protocol is in `core/HOW_TO_UPDATE.md`.

If this is a multi-repo project and `core/graph_index.md` lists a shared graph path,
read that index too when working across repo boundaries.
