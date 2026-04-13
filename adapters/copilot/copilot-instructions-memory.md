# Memory Graph Instructions

This project uses a persistent memory graph stored in `core/`.

## Session Start
ALWAYS read `core/graph_index.md` before writing or modifying any code.
It is approximately 40 lines. Use the task routing table to identify which detail
files to load. Only load files relevant to the current task.

## Before Modifying Code
Check edge links in the graph for any component you are modifying.
If a node has `VIOLATED_BY` edges or appears in a `WATCHLIST`, review those entries first.
Any `REGRESSED_N_TIMES` count of 2 or more signals high-risk code — proceed with extra care.

## After Changes
After fixing a bug, making an architectural decision, or discovering dangerous behavior:
update the graph as part of the same commit. Protocol: `core/HOW_TO_UPDATE.md`.

## Multi-Repo
If `core/graph_index.md` specifies a shared graph path, read that index too when working
across repository boundaries.
