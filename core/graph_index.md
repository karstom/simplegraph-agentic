# [Project Name] Knowledge Graph — Index

> **Session-start mandatory read.** Read this file first, every session.
> Only load detail files listed below when working in those areas.
> **LastUpdated:** YYYY-MM-DD

---

## Multi-Repo Projects

> If this repo is part of a larger multi-repo project, an **org-level shared graph** may exist.
> Check for a `shared/graph_index.md` alongside this file, or a dedicated org-memory repo.
> **If working across repo boundaries, read the shared graph index too.**
>
> Path to shared graph (fill in if applicable): _(e.g., `../org-memory/core/graph_index.md`)_

---

## Quick Index

> **Compact edge notation:** When populating this table, include 1-hop edges inline
> for fast scanning, e.g.: `INV_AUTH_TOKEN ⚠ VIOLATED_BY:REG_TOKEN_LEAK(×2)`
> This lets the AI see high-risk relationships without loading detail files.

| Category | Nodes | File |
|---|---|---|
| **Components** | _(add your component node IDs here)_ | `components/{NAME}.md` |
| **Invariants** | _(add your invariant node IDs here)_ | `invariants.md` |
| **Active Regressions** | _(add your regression node IDs here)_ | `regressions.md` |
| **Decisions** | _(add your decision node IDs here)_ | `decisions.md` |
| **Watchlists & Open Issues** | _(add your watchlist node IDs here)_ | `watchlists.md` |
| **Anti-Patterns** | _(things the AI should never generate)_ | `anti_patterns.md` |
| **Resolved (archive)** | _(resolved regressions go here)_ | `archive/resolved_regressions.md` |

---

## Task Routing — What to Load

> Replace these generic rows with the actual task areas for your project.
> The goal: the AI loads only what's relevant, not the full graph.
> When a task matches multiple rows, load HIGH-priority nodes first.

| If working on... | Load these files |
|---|---|
| **Authentication / identity** | `components/{AUTH_COMPONENT}.md`, `watchlists.md`, `invariants.md` |
| **Database / data layer** | `components/{DB_COMPONENT}.md`, `decisions.md`, `invariants.md` |
| **Deployment / CI/CD** | `watchlists.md`, `invariants.md` |
| **API / backend** | `components/{API_COMPONENT}.md`, `watchlists.md` |
| **Client / frontend** | `components/{CLIENT_COMPONENT}.md`, `decisions.md` |
| **Testing** | `regressions.md`, `watchlists.md` |
| **Investigating a past regression** | `regressions.md`, `archive/resolved_regressions.md` |
| **Locating code / understanding structure** | `auto_map.md` _(generated — run `scripts/auto_map.sh` first)_ |
| **Starting any new code generation** | `anti_patterns.md` _(always check before writing code)_ |

