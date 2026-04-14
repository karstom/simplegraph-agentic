---
name: simplegraph-agentic-memory
description: "Persistent memory graph for this project. Read core/graph_index.md at session start before touching any code."
---

# Memory Graph

> [!IMPORTANT]
> **The graph lives at `core/` in the project root.**
> Use the `view_file` tool to read `core/graph_index.md` from the workspace root.
> Do NOT assume a path — the workspace root contains `core/graph_index.md`.

## Instructions

1. **At session start:** Use `view_file` to open `core/graph_index.md` from the
   workspace root. It's ~50 lines and routes you to the right detail files.

2. **Use the task routing table** to determine which files to load. Only load files
   relevant to the current task. Load HIGH-priority nodes first.

3. **Check `core/anti_patterns.md` before generating any new code.**

4. **Follow edge chains before touching risky areas.** If a Regression node has
   `REGRESSED_N_TIMES >= 2`, treat that code as high-risk.

5. **Update the graph after any significant change.** See `core/HOW_TO_UPDATE.md`.
   Graph updates go in the **same commit** as the code change.

6. **Do not proceed if you find contradictions** between the graph and the current code
   without first flagging the discrepancy in your plan.

## Multi-Repo

If this repo is part of a multi-repo project, check `core/graph_index.md` for the
shared graph path. Load the shared graph index when working across repo boundaries.
