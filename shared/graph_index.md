# Shared / Org-Level Graph Index

> **Multi-repo teams:** Read this file when working across repo boundaries or on shared
> infrastructure. Each individual repo also has its own `core/graph_index.md`.
> **LastUpdated:** YYYY-MM-DD

---

## What Goes in the Shared Graph

The shared graph captures **cross-repo concerns** that no single repo owns:

| Node Type | Examples |
|---|---|
| **Component** | Shared libraries, internal SDKs, platform services consumed by multiple repos |
| **Invariant** | API contracts between repos, org-wide security rules, shared deployment constraints |
| **Regression** | Bugs that affected multiple repos or were caused by a cross-repo interaction |
| **Decision** | Platform-level architectural decisions (e.g., "all services use X for auth") |
| **Watchlist** | Integration boundaries that have caused problems across repos |

---

## Quick Index

| Category | Nodes | File |
|---|---|---|
| **Shared Components** | _(add shared component node IDs here)_ | `components/{NAME}.md` |
| **Shared Invariants** | _(add shared invariant node IDs here)_ | `invariants.md` |
| **Cross-Repo Regressions** | _(add cross-repo regression node IDs here)_ | `regressions.md` |
| **Platform Decisions** | _(add platform decision node IDs here)_ | `decisions.md` |
| **Integration Watchlists** | _(add watchlist node IDs here)_ | `watchlists.md` |

---

## Setup for Multi-Repo Teams

**Option A — Dedicated org-memory repo** _(recommended for large teams)_
1. Create a new repo (e.g., `your-org/org-memory`) containing this `shared/` directory at the root as `core/`.
2. Clone it alongside your project repos.
3. In each repo's `core/graph_index.md`, set the shared graph path to `../org-memory/core/graph_index.md`.

**Option B — Shared directory in a monorepo** _(for monorepos or small multi-repo setups)_
1. Keep this `shared/` directory at the monorepo root.
2. Each package/service has its own `core/` under its subdirectory.
3. Adapters reference both: read `shared/graph_index.md` AND `packages/{service}/core/graph_index.md`.

---

## Routing — When to Load the Shared Graph

| If working on... | Also load from shared graph |
|---|---|
| **API contract between two repos** | `shared/invariants.md`, `shared/components/{API}.md` |
| **Shared library update** | `shared/components/{LIB}.md`, `shared/watchlists.md` |
| **Cross-service deployment** | `shared/invariants.md`, `shared/decisions.md` |
| **Investigating a cross-repo regression** | `shared/regressions.md` |
