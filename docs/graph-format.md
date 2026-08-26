# Graph format

Node types, edge types, anchors, and the directory layout.

[← back to the README](../README.md)

---

## Graph Structure

```
core/
├── graph_index.md        # Mandatory session-start read (~50 lines)
├── anti_patterns.md      # What the AI should NEVER generate
├── invariants.md         # Hard rules ("never call X without Y")
├── regressions.md        # Bugs + REGRESSED_N_TIMES counters
├── decisions.md          # Architectural choices with rationale
├── watchlists.md         # Dangerous code areas + open issues
├── HOW_TO_UPDATE.md      # When and how to update the graph
├── components/           # One file per major service/module
├── archive/
│   └── resolved_regressions.md
├── auto_map.md           # (generated, gitignored) structural repo map
└── .scratchpad.md        # (gitignored) session-local AI notes
```

For multi-repo teams, a `shared/` directory adds cross-repo invariants, decisions, and an org-level index. See `shared/graph_index.md`.

### Edge types

| Edge | Meaning |
|---|---|
| `DEPENDS_ON` | This node requires the target to function correctly |
| `CAUSES` | Violating this node causes the target problem |
| `MITIGATES` | This node reduces the risk of the target |
| `FIXED_BY` | This regression was resolved by the target |
| `VIOLATED_BY` | This invariant was broken by the target regression |
| `CONTAINS` | This Watchlist or Component contains the target |

---
