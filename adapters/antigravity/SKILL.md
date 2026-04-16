---
name: simplegraph-agentic-memory
description: "MANDATORY for all tasks. Contains architecture rules, active bugs, dangerous code zones, and anti-patterns for this codebase. Required context for bug fixes, UI work, feature development, refactoring, and deployments. Read before touching any code."
---

# Memory Graph

> [!IMPORTANT]
> **Start of every session:**
> **The graph index is embedded below. Read it now — do not skip.**
> Then use the Task Routing table to load only the detail files relevant to your task.
> Detail files live in `core/` in the project root.

---

<!-- EMBEDDED: core/graph_index.md — re-run setup.sh or paste updated index here when the index changes -->

<!-- TODO: The graph index will be embedded here automatically by setup.sh.
     If you installed manually, paste the contents of core/graph_index.md here. -->

---

## Instructions

1. **The index above is already loaded.** Use the Task Routing table to load the relevant `core/` detail files.

2. **Load HIGH-priority nodes first.** Any `REGRESSED_N_TIMES >= 2` node is high-risk.

3. **Check `core/anti_patterns.md` before generating any new code.**

4. **Update the graph after any significant change.** See `core/HOW_TO_UPDATE.md`.
   Graph updates go in the **same commit** as the code change.

5. **Do not proceed if you find contradictions** between the graph and the current code
   without first flagging the discrepancy in your plan.

## Multi-Repo

If this repo is part of a multi-repo project, check the embedded index for the
shared graph path. Load the shared graph index when working across repo boundaries.
