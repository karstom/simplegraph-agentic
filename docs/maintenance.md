# Keeping a graph honest

The CI gate, the staleness checks, and how graphs grow without rotting.

[← back to the README](../README.md)

---

## Keeping the Graph Fresh

The graph only stays useful if it's updated when code changes.

| Task | Mechanism |
|---|---|
| **Edge consistency & duplicate IDs** (`consistency_check.sh` / `sg check`) | CI required status check — enforced on every PR |
| **Structural map** (`auto_map.sh`) | Git pre-commit hook — automatic, local |
| **Capture** — recording a node when risky code changes (`require_documentation.sh` / `sg hook require-doc`) | Claude Code & Antigravity `Stop` hook — reminds the agent before it finishes |
| **Staleness & missing anchors** (`stale_check.sh` / `sg stale`) | Periodic maintenance — flags >90d untouched nodes & deleted code paths |
| **Node updates** (regressions, decisions, etc.) | Grow through use; the Stop hook nudges, CI validates |

**CI check** — add as a required branch protection rule so broken edges can never merge:

```yaml
# .github/workflows/graph-check.yml
on: [pull_request]
jobs:
  graph-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash core/scripts/consistency_check.sh
        # Or cross-platform / Windows CI:
        # - run: npx simplegraph check
```

Node IDs are matched as `[A-Z][A-Z0-9_]*`, so the hashed IDs `sg seed` mints
(`REG_TOKEN_LEAK_1F3A`) are compared in full rather than truncated at the first
digit. The bash check uses only POSIX `grep -E` / `sed` / `awk` — no `grep -P`, which
BSD/macOS grep does not support — and automatically delegates to Node (`mcp/dist/seed/cli.js check`)
when built. A self-test runs first and exits **2** if ID
extraction is not working on the host, so a broken toolchain fails the build
loudly instead of reporting "all valid" after comparing two empty sets. Exit
codes: `0` clean, `1` graph problem, `2` check could not run.

Run `bash scripts/test_consistency_check.sh` to verify the gate itself.

**Node updates** grow naturally: fix a bug → add a Regression node in the same commit. Notice a bug recurs → call `simplegraph_update_node` to increment `REGRESSED_N_TIMES`. The graph improves through real usage — low quality at seed time is fine.

### Force capture — the `Stop` hook

CI can enforce that the graph is internally *valid* (no broken edges, no
duplicate IDs), but it can't enforce that new knowledge was *written down* —
nothing in a diff says "this fix deserved a Regression node." `require_documentation.sh`
(and `sg hook require-doc`) closes that gap for **Claude Code** and **Antigravity**. Wired as a `Stop` hook, it runs when the agent
tries to finish and checks: did this task change a file a **HIGH-priority** node
points at (a known regression or danger zone) without touching the graph? If so,
it blocks once with the specific files and nodes and asks the agent to record
what happened.

Deliberate design choices:

- **Nudge once, never trap.** The `stop_hook_active` guard (or `.sg.nudge` state file) lets the next stop
  through, so the agent is reminded exactly once per task — CI is the backstop.
- **Fail open.** Any error, a non-git tree, or a missing graph exits 0 (allow).
  A reminder must never wedge a session. `SIMPLEGRAPH_SKIP_DOC_HOOK=1` disables it.
- **HIGH-priority only.** It fires on genuine danger zones, not every edit —
  over-firing just trains agents to write junk nodes to get past it (the same
  reason the Recurrence Root-Cause Gate targets only recurrence ≥ 2).

Wiring the hook:
- **Claude Code:** Configured during `setup.sh` or via `bash scripts/install_doc_hook.sh /path/to/project` (merges into `.claude/settings.json`).
- **Antigravity:** Automatically registered in the workspace plugin at `.agents/plugins/simplegraph/hooks.json`.

Verify the hook with `bash scripts/test_require_documentation.sh` or `npm test` in `mcp/`. This is the "force capture" layer;
`consistency_check.sh` / `sg check` in CI remains the "force validity" layer.

---

## Scaling

| Project size | Strategy |
|---|---|
| **<10 components** | Single `graph_index.md` with flat routing table |
| **10–30 components** | Same; split multi-node files if merge conflicts increase |
| **30+ components** | Hierarchical routing: domain-level indexes |
| **Multi-repo** | Per-repo `core/` + shared org-level graph |

---
