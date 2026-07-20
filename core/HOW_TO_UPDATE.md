# How to Update the Memory Graph

## When to Update

You (human or agent) MUST add or update a node when:

| Trigger | Action |
|---|---|
| A bug is fixed | Add/update a **Regression** node in `regressions.md`; increment `REGRESSED_N_TIMES` if it has happened before |
| A non-obvious invariant is discovered | Add an **Invariant** node in `invariants.md` |
| A significant architectural decision is made | Add a **Decision** node in `decisions.md` |
| A new component or service is added | Add a **Component** node in `components/{NAME}.md` |
| A code area is identified as dangerous | Add/update a **Watchlist** node in `watchlists.md` |
| A regression is fully resolved | Move it from `regressions.md` to `archive/resolved_regressions.md` |

You SHOULD update a node when:
- A file path referenced by a node changes
- A new edge relationship between nodes is discovered
- A summary becomes inaccurate

**Always update `graph_index.md`** when adding a new node to ensure it appears in the Quick Index.

---

## Recurrence Root-Cause Gate

When `REGRESSED_N_TIMES` reaches **2 or more**, **stop — do not write a fix yet.**

The counter reaching 2 means a symptomatic fix was applied at least once without eliminating the root cause. Another symptomatic fix will produce recurrence 3. Before touching code, you must answer all three questions below and supply them as the `root_cause` argument to `simplegraph_update_node`. The MCP tool will refuse to increment the counter without it.

### Required answers

**1. SOURCE OF TRUTH**
What is the authoritative source for the state this regression corrupts? Why isn't the code reading that source directly instead of maintaining a local copy, mirror, or derived flag? If the answer is "there is no single source," that IS the root cause — the fix is to establish one.

**2. VIOLATED INVARIANT**
Which rule is being broken? State it as a falsifiable sentence (e.g., "the secured status must always be derived from `securedStatusFromBackend` at render time, never stored separately"). If no Invariant node captures this rule yet, add one with `simplegraph_add_node` before proceeding.

**3. WHY PRIOR FIXES WERE SYMPTOMATIC**
What did fixes 1..N−1 treat instead of the root cause? Be specific. Example: "Fix 1 added a guard in ComponentA. Fix 2 added a preserve call in ComponentB. Both assumed the flag was reliable; neither questioned why it needed to be patched in more than one place."

### The Nth-stamp smell

If the proposed fix adds the *N*th place in the codebase that sets, preserves, or re-stamps the same derived boolean or flag, count the writers. More than ~2 write sites for a single derived value is a strong signal that the code should be reading the source of truth directly rather than maintaining a mirror. Each new write site is a new recurrence waiting to happen.

---

## Node Format

Every node follows this exact format:

```markdown
## NODE: YOUR_NODE_ID
**Type:** Component | Invariant | Regression | Decision | Watchlist
**Priority:** HIGH | MEDIUM | LOW
**Label:** Human-readable name
**Summary:** 2–4 sentences. What this is, why it matters, what went wrong (for regressions).
**Tags:** comma-separated, lowercase, e.g. auth, token, session
**Edges:**
- EDGE_TYPE → OTHER_NODE_ID: brief explanation of the relationship
**Files:** `src/path/to/your/file.ts`, `src/path/to/other.py`
**LastUpdated:** YYYY-MM-DD
```

For Regression nodes, add:
```
**REGRESSED_N_TIMES:** 1
```

### Tags

Tags enable similarity-style search across nodes that don't share explicit edge relationships. Use `simplegraph_search` with a tag name to find all semantically related nodes across the graph.

**Conventions:**
- Lowercase, hyphenated: `auth`, `token-refresh`, `mobile-nav`
- Reflect your project's own domain language — don't use generic CS terms
- 2–5 tags per node; more than that is a sign the node should be split
- Tags are optional but add high value on nodes that share a concern without a direct edge

### Priority / Heat Rules

| Condition | Auto-priority |
|---|---|
| `REGRESSED_N_TIMES >= 2` | **HIGH** — recurring failure source; treat with extra caution |
| `LastUpdated` within the past 14 days | **MEDIUM** — recently changed, still settling |
| Everything else | **LOW** — stable, load only if directly relevant |

When the task routing table points the AI to multiple files, it should load HIGH-priority nodes first and only read MEDIUM/LOW nodes if the task directly touches them.

### Node Types

| Type | Use for | File |
|---|---|---|
| `Component` | A service, module, or subsystem | `components/{NAME}.md` |
| `Invariant` | A hard rule that must never be violated | `invariants.md` |
| `Regression` | A bug that has occurred (especially recurring ones) | `regressions.md` |
| `Decision` | An intentional architectural/design choice | `decisions.md` |
| `Watchlist` | A code area requiring extra caution | `watchlists.md` |

### Edge Types

| Edge | Meaning |
|---|---|
| `DEPENDS_ON` | This node requires the target to function correctly |
| `CAUSES` | Violating this node causes the target problem |
| `MITIGATES` | This node reduces the risk of the target |
| `FIXED_BY` | This regression was resolved by the target decision/node |
| `VIOLATED_BY` | This invariant was broken by the target regression |
| `CONTAINS` | This Watchlist or Component contains the target |
| `SUPERSEDED_BY` | This decision was replaced/reverted by the target (mostly emitted by `sg seed`) |
| `RELATES_TO` | Weak association — shared issue, co-change coupling (mostly emitted by `sg seed`) |

### Seeded nodes

Nodes created by `sg seed` (see `mcp/README.md`) carry two extra fields:

```markdown
**Provenance:** commits: `abc123def456` | locations: `src/auth.ts:41`
**Seeded:** regression-commits@1 | confidence: 0.80 | hash: 1a2b3c4d | seed: v0.3.0
```

- **Provenance** is the audit trail — the commits/locations the node was mined from.
- **Seeded** records the extractor, its confidence (0–1), and a content hash.

You may freely edit or delete seeded nodes. The hash lets re-runs of `sg seed`
detect your edits: **an edited seeded node is never overwritten** — the re-run
reports a conflict and keeps your version. Don't edit the `**Seeded:**` line
itself; delete it only if you want to claim the node as fully hand-authored.

---

## Rules

1. **Node IDs are UPPER_SNAKE_CASE**, unique, and stable. Never rename a node ID.
2. **All edges must reference an existing Node ID.** Run the consistency check before committing.
3. **`LastUpdated` is the date the node was last meaningfully changed**, in `YYYY-MM-DD` format (UTC).
4. **Summaries are max 4 sentences.** If you need more context, link to a doc file.
5. **Agents: update the graph as part of the same commit** that fixes the bug or makes the decision.
6. **New nodes go at the bottom** of multi-node files (`invariants.md`, `regressions.md`, etc.). This minimizes merge conflicts when multiple contributors add nodes concurrently.

---

## Team Merge Strategy

The graph is designed to minimize merge conflicts on teams:

- **`components/` — one file per node.** Two people editing different components never conflict.
- **Multi-node files** (`invariants.md`, `regressions.md`, `decisions.md`, `watchlists.md`) — each node is a self-contained block separated by `---`. **Always append new nodes at the bottom.** Git merges two appends cleanly.
- **`graph_index.md`** — the only file where conflicts are possible (when two people add a node to the same index table simultaneously). Resolution is trivial: accept both new rows.
- **Scratchpad** (`core/.scratchpad.md`) — gitignored, so never conflicts.

> **Large teams (5+ contributors):** If multi-node files still cause frequent conflicts,
> split them into per-node files using the same pattern as `components/`:
> `invariants/{NODE_ID}.md` instead of a single `invariants.md`.

---

## Scaling: Hierarchical Routing

When `graph_index.md` grows beyond ~80 lines (typically 30+ components), restructure
into domain-specific indexes:

```
core/graph_index.md             -- Top level: lists domains only
core/domains/auth_index.md      -- Components, invariants, decisions for auth
core/domains/payments_index.md  -- Components, invariants, decisions for payments
```

The AI reads the top-level index, identifies the relevant domain, loads the domain
index, then loads specific detail files. Each step is small. This scales indefinitely.

---

## Additional Files

| File | Purpose |
|---|---|
| `anti_patterns.md` | Things the AI should **never** generate — prevents wasted correction cycles |
| `.scratchpad.md` | Session-local AI notes (gitignored). Promote to real nodes when ready |
| `auto_map.md` | Auto-generated structural map (gitignored). Regenerate with `core/scripts/auto_map.sh` |

---

## Verification Scripts

```bash
# Consistency check — verify no broken edge references
bash core/scripts/consistency_check.sh

# Stale check — flag old nodes and dead file references
bash core/scripts/stale_check.sh [CORE_DIR] [MAX_AGE_DAYS]

# Auto-map — generate structural repo map (requires ctags)
bash core/scripts/auto_map.sh [PROJECT_DIR]
```

