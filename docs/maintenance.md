# Keeping a graph honest

The CI gate, the staleness checks, and how graphs grow without rotting.

[← back to the README](../README.md)

---

## Keeping the Graph Fresh

The graph only stays useful if it's updated when code changes.

| Task | Mechanism |
|---|---|
| **Edge consistency & duplicate IDs** (`consistency_check.sh`) | CI required status check — enforced on every PR |
| **Structural map** (`auto_map.sh`) | Git pre-commit hook — automatic, local |
| **Node updates** (regressions, decisions, etc.) | Anchor to a merge checklist the agent already follows |

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
```

Node IDs are matched as `[A-Z][A-Z0-9_]*`, so the hashed IDs `sg seed` mints
(`REG_TOKEN_LEAK_1F3A`) are compared in full rather than truncated at the first
digit. The check uses only POSIX `grep -E` / `sed` / `awk` — no `grep -P`, which
BSD/macOS grep does not support. A self-test runs first and exits **2** if ID
extraction is not working on the host, so a broken toolchain fails the build
loudly instead of reporting "all valid" after comparing two empty sets. Exit
codes: `0` clean, `1` graph problem, `2` check could not run.

Run `bash scripts/test_consistency_check.sh` to verify the gate itself.

**Node updates** grow naturally: fix a bug → add a Regression node in the same commit. Notice a bug recurs → call `simplegraph_update_node` to increment `REGRESSED_N_TIMES`. The graph improves through real usage — low quality at seed time is fine.

---

## Scaling

| Project size | Strategy |
|---|---|
| **<10 components** | Single `graph_index.md` with flat routing table |
| **10–30 components** | Same; split multi-node files if merge conflicts increase |
| **30+ components** | Hierarchical routing: domain-level indexes |
| **Multi-repo** | Per-repo `core/` + shared org-level graph |

---
