---
name: simplegraph-memory
description: Persistent memory graph procedures for this codebase. Use when investigating past regressions, checking known invariants or anti-patterns before modifying high-risk code, recording new nodes after bug fixes or decisions, or archiving permanently resolved regressions.
---

# SimpleGraph Agentic Memory Runbook

This codebase maintains an architectural memory graph in `core/`. Use this skill when querying, updating, or maintaining memory nodes.

## 0. Session Start & Task Routing

At session start, review the Quick Index and Task Routing table via `simplegraph_index` or `core/graph_index.md`. Load only the detail files relevant to your task — do not load the full graph.

## 1. Safety Checks Before Code Changes

Before modifying any file, invoke `simplegraph_check_files`:
```json
{
  "files": ["path/to/file.ts"],
  "symbols": ["AuthService.refreshToken"]
}
```
If you know callers or dependents from your code graph or LSP, pass them in `related_files` / `related_symbols`.
- **Review returned nodes**: Pay close attention to any node with `Priority: HIGH` or `REGRESSED_N_TIMES >= 2`.
- **Check anti-patterns**: Call `simplegraph_anti_patterns()` before generating new code patterns.

## 2. Recurrence Root-Cause Gate

When updating a regression where `REGRESSED_N_TIMES >= 2`, `simplegraph_update_node` strictly requires a 3-part causal explanation in `root_cause`:
1. **Source of Truth**: What is the authoritative state source? Why isn't it read directly?
2. **Violated Invariant**: Which rule is broken? (Add an Invariant node first if none exists).
3. **Why Prior Fixes Were Symptomatic**: What did previous patches treat instead of the root cause?

Do not patch symptoms repeatedly. Establish a single source of truth.

## 3. Recording Knowledge After Changes

Record memory updates in the **same commit** as your code changes:
- **Bug Fix**: `simplegraph_add_node({ type: "Regression", ... })`
- **Architectural Decision**: `simplegraph_add_node({ type: "Decision", ... })`
- **Discovered Invariant**: `simplegraph_add_node({ type: "Invariant", ... })`
- **Danger Zone**: `simplegraph_add_node({ type: "Watchlist", ... })`
- **Resolved Bug**: `simplegraph_archive_regression({ id: "REG_BUG_ID", resolution: "..." })`

After adding nodes, call `simplegraph_update_index` to regenerate `core/graph_index.md`.

## 4. Graph Maintenance CLI

Run these commands from the project root:
- `sg check` — Verify graph consistency (no duplicate IDs, all edges resolve).
- `sg reindex` — Deterministically regenerate `core/graph_index.md`.
- `sg stale` — Detect outdated nodes or missing file anchors.
- `sg seed` — Mine git history for candidate nodes.
