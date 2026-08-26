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

**The Quick Index in `graph_index.md` is derived from the node files.** If you use
`simplegraph_add_node` / `simplegraph_archive_regression`, it is regenerated for
you automatically. If you hand-edit node files, regenerate it with `sg reindex`
(or the `simplegraph_reindex` tool) rather than editing the table by hand — the
output is sorted and order-independent, which keeps it stable across parallel
branches. Only the Quick Index rows are rewritten; the Task Routing section is
left untouched.

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

In multi-agent setups, a node may also carry attribution — who created it and in
which session — so concurrent or conflicting nodes can be told apart after a
merge:
```
**Author:** agent-name-or-human
**Session:** session-id
```
These are optional. `simplegraph_add_node` stamps them from its `author`/`session`
arguments, or from the `SIMPLEGRAPH_AUTHOR` / `SIMPLEGRAPH_SESSION` environment
variables. Omit them for solo work.

### Anchors — Files, Symbols, Paths

A node's anchors decide when it fires. `simplegraph_check_files` matches on all
three, so pick the ones that describe what the node is really about.

| Field | Matching | Use for |
|---|---|---|
| `**Files:**` | Path suffix — `token.ts` matches `src/auth/token.ts` | The specific files the node is about |
| `**Symbols:**` | Symbol name, qualified or bare — `AuthService.refreshToken` matches `refreshToken` | The function/class/method the node is really about |
| `**Paths:**` | Directory containment — `src/auth` matches everything beneath it | Component ownership of a whole area |

```markdown
**Files:** `src/auth/token.ts`
**Symbols:** `AuthService.refreshToken`, `parseToken`
**Paths:** `src/auth`
```

All three are optional and all three are lists of backtick-wrapped entries.
Backticks are the documented form and what the tools emit, but a plain
comma-separated list is also accepted — hand-written nodes routinely omit them,
and those are the nodes most worth keeping.

**Why anchor to symbols as well as files.** A path-only anchor breaks silently the
moment the file is renamed — the node still looks alive but no longer guards
anything. A symbol survives the move. It also lets the node fire when a *caller*
is edited, which is usually where the bug is actually reintroduced.

**Why `Paths` is only for Components.** Directory ownership is coarse by design.
On a Regression it would fire on every unrelated edit in the area and train the
agent to ignore the tool. On a Component — "this node owns `src/auth`" — it is
exactly right, and it does not churn when files move around inside.

Adding anchors to nodes that predate these fields needs no rewrite:
`simplegraph_update_node` with `field: "Symbols"` inserts the field if it is
missing. Pass the value with each entry in backticks:
`` value: "`AuthService.refreshToken`, `parseToken`" ``.

`scripts/stale_check.sh` verifies both: it reports `Paths` that are no longer
directories, and `Symbols` that are absent from `auto_map.md` (skipped entirely
when no `auto_map.md` has been generated).

### Working with a structural code graph

simplegraph does not parse your source. If you also run a structural code graph —
codebase-memory-mcp, code-review-graph, Graphify, an LSP, or plain
`grep -r <symbol>` — use it **first** to find what your edit touches, then pass
that blast radius to `simplegraph_check_files`:

```
simplegraph_check_files({
  files:           ["src/auth/parse.ts"],       // what you are editing
  symbols:         ["parseToken"],
  related_files:   ["src/auth/service.ts"],     // its callers and dependents
  related_symbols: ["AuthService.refreshToken"] // from the code graph
})
```

Results come back in two groups — *directly affected* first, then *in the blast
radius*. That second group is the one a structural graph alone cannot give you:
it knows those files are affected, but not that one of them has regressed three
times.

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
- **Multi-node files** (`invariants.md`, `regressions.md`, `decisions.md`, `watchlists.md`) — each node is a self-contained block separated by `---`, and `core/.gitattributes` marks these files `merge=union`. Two branches that each **append a new node at the bottom** merge cleanly with no conflict — union merge keeps both additions. (Union can't resolve two edits to the *same* node; the per-graph lock handles that on a shared checkout, and duplicate IDs are caught below.)
- **`graph_index.md`** — the Quick Index is derived, so don't hand-resolve a conflict here. Accept either side of the conflict (or take `--theirs`/`--ours`), then run `sg reindex` to rebuild it from the node files. Because the output is sorted and order-independent, both contributors end up with byte-identical indexes.
- **Concurrent writers on one checkout** — when two agent sessions share a working copy (not separate branches), the MCP server serializes their writes with a per-graph lock and writes atomically, so a lost `REGRESSED_N_TIMES` increment or a torn file can't happen. No manual coordination needed.
- **Duplicate IDs** — if a merge lands two nodes with the same ID (each branch minted it independently), `consistency_check.sh` fails and names the ID. Rename one or merge the two blocks, then `sg reindex`.
- **After any graph merge:** run `sg reindex` (rebuild the index) then `core/scripts/consistency_check.sh` (catch duplicate IDs and broken edges union may have left).
- **Scratchpad** (`core/.scratchpad.md`) — gitignored, so never conflicts.

**Propagation:** a node you record on a feature branch reaches other agents only when that branch merges. Commit graph updates in the same commit as the code and land them promptly, and `git fetch` before starting parallel work so you begin from the current graph. The graph is a git artifact — it propagates exactly as fast as your branches merge, no faster.

**Trust boundary — `shared/`:** a node in the shared (org-level) graph is loaded by *every* repo and agent, so a wrong one becomes org-wide law. The MCP server is **read-only** against `shared/`: no agent can write it, so promoting a node there is always a deliberate human act (copy the node into `shared/`, commit, review). Stamp an `**Author:**` when you promote — `consistency_check.sh` auto-detects a sibling `shared/` graph, validates its IDs and edges alongside `core/`, and warns on any shared node with no attribution (an org-wide rule with no traceable source). Review shared-graph PRs with more care than per-repo ones.

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

