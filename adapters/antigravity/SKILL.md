---
name: simplegraph-agentic-memory
description: "Persistent memory graph for this project. Read graph_index.md at session start before touching any code."
---

# Memory Graph

> [!IMPORTANT]
> **Read `core/graph_index.md` at session start.** This ~40-line index maps every node
> to its file and tells you which files to load for each task area.
> **Do NOT load the full graph.** Only load detail files when working in those areas.

## Instructions

1. **Always read `core/graph_index.md` at session start.** It tells you what to load.

2. **Use the task routing table** in `graph_index.md` to determine which detail files to load.
   Only load files relevant to the current task.

3. **Follow edge chains before touching risky areas.** If modifying a Component node,
   check its `VIOLATED_BY` and `WATCHLIST` edges. If a Regression node has
   `REGRESSED_N_TIMES >= 2`, treat the associated code as high-risk.

4. **Update the graph after any significant change.** See `core/HOW_TO_UPDATE.md`.
   The minimum bar: any bug fix that could recur must produce an updated or new Regression node.
   Graph updates go in the **same commit** as the code change.

5. **Do not proceed with implementation if you find contradictions** between the graph
   and the current code without first flagging the discrepancy.

## Multi-Repo

If this repo is part of a multi-repo project, check `core/graph_index.md` for the
shared graph path. Load the shared graph index when working across repo boundaries.
