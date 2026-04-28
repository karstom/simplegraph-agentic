# simplegraph-agentic

A lightweight **persistent memory graph** for AI coding assistants.

Your agent accumulates structured knowledge about your codebase — recurring bugs, deliberate decisions, dangerous code areas — and carries it across sessions without bloating every context window. Works with Claude Code, Cursor, GitHub Copilot, Antigravity, and any tool that accepts custom instructions.

---

## The Problem

Every AI coding session starts cold. The agent re-introduces the bug you fixed three times, undoes the architectural decision that was intentional, and generates the pattern your team banned. You re-explain the same context over and over — or worse, you don't, and it silently breaks things.

---

## How It Works

### Tiered loading — 29× fewer tokens at session start

Measured on a production codebase with 31 graph files:

| Approach | Session start | Per task |
|---|---|---|
| **simplegraph (tiered)** | **~862 tokens** | **~4,300 tokens** |
| Monolith (flat file) | ~25,400 tokens | ~25,400 tokens |
| No memory | 0 up front, ~500–2,000 per re-explanation | compounds |

**29× reduction** at session start. **5× reduction** for a typical task. The savings compound across every request in a session — the agent reads ~862 tokens once, then loads only the 2–3 files relevant to the current task. Run `bash scripts/token_benchmark.sh` on your own graph to measure your numbers.

### Typed nodes and edges — follow risk chains

Nodes have types (**Component**, **Invariant**, **Regression**, **Decision**, **Watchlist**) and typed edges. An agent can follow:

```
AUTH_SERVICE --VIOLATED_BY--> REG_TOKEN_LEAK (×3) --FIXED_BY--> DEC_ROTATE_ON_REFRESH
```

That chain tells the agent exactly what to be careful about and why — in 3 hops.

### Priority — load critical context first

| Signal | Priority |
|---|---|
| `REGRESSED_N_TIMES >= 2` | **HIGH** |
| `LastUpdated` within 14 days | **MEDIUM** |
| Stable, no flags | **LOW** |

### Compared to alternatives

| Approach | Limitation |
|---|---|
| **CLAUDE.md / .cursorrules** | Flat files load everything every time. 31 graph files = ~25,400 tokens wasted per request. |
| **Aider repo-map** | Answers "where is X?" but not "what went wrong?" or "why was this decided?" |
| **Vector DB (Mem0, etc.)** | Requires infrastructure; retrieval is probabilistic — may miss the one invariant that blocks a regression. |
| **Fine-tuned models** | Expensive, opaque, stale the moment code changes. |

---

## Quickstart

```bash
git clone https://github.com/karstom/simplegraph-agentic.git
bash simplegraph-agentic/setup.sh /path/to/your/project
```

The installer copies `core/` into your project, installs the right adapter for your AI tool, and prints next steps including the seed prompt.

**Already installed?** Re-run `setup.sh` on an existing project — it detects the existing graph and prompts you to upgrade in place (scripts and adapters refreshed, graph data untouched) or do a clean reinstall.

### Manual install

1. Copy `core/` into your project root.
2. Pick an adapter from `adapters/` — see the [Adapter Matrix](#adapter-matrix) below.
3. Run `scripts/seed_prompt.md` in your AI tool to bootstrap the graph.
4. Commit `core/`.

---

## MCP Server (recommended for Claude Code)

The `mcp/` directory exposes the graph as callable tools via the Model Context Protocol. This is more reliable than context injection alone — the agent actively calls tools rather than hoping it read a file at session start.

```
simplegraph_index              — Routing table (call at session start)
simplegraph_check_files        — Check files for known issues BEFORE editing
simplegraph_anti_patterns      — Anti-patterns list BEFORE generating code
simplegraph_nodes              — All nodes in a category
simplegraph_search             — Keyword search across all nodes
simplegraph_get_node           — Fetch a single node by exact ID
simplegraph_add_node           — Add a node after a bug fix or decision
simplegraph_update_index       — Add a new node to graph_index.md
simplegraph_update_node        — Update a field; increment REGRESSED_N_TIMES
simplegraph_archive_regression — Move a resolved regression to archive
simplegraph_scratchpad         — Session notes not yet ready to commit as nodes
```

See [`mcp/README.md`](mcp/README.md) for installation (Claude Desktop, Cursor, VS Code, `.claude/settings.json`). The `setup.sh` Claude Code path can generate `.claude/settings.json` automatically.

> **Best practice:** use both — the adapter gives a session-start summary via context injection; the MCP server handles mid-task safety checks and structured updates.

---

## Adapter Matrix

| AI Tool | Adapter | Install path |
|---|---|---|
| **Claude Code** | `adapters/claude-code/CLAUDE_MEMORY.md` | Appended to `CLAUDE.md` (setup.sh handles this) |
| **Cursor** | `adapters/cursor/memory.mdc` | `.cursor/rules/memory.mdc` |
| **GitHub Copilot** | `adapters/copilot/copilot-instructions-memory.md` | `.github/copilot-instructions.md` |
| **Antigravity** | `adapters/antigravity/SKILL.md` | `.agent/skills/memory/SKILL.md` |
| **Generic** | `adapters/generic/AGENT_MEMORY.md` | Paste into custom instructions |

The generic adapter works with ChatGPT Projects, Gemini Gems, Windsurf, Aider, Cline, or any tool that accepts a persistent system prompt.

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

## Keeping the Graph Fresh

The graph only stays useful if it's updated when code changes.

| Task | Mechanism |
|---|---|
| **Edge consistency** (`consistency_check.sh`) | CI required status check — enforced on every PR |
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

## Design Principles

1. **Zero infrastructure.** No databases, no servers. Plain markdown + git.
2. **Stay small.** 5 high-signal nodes beat 50 shallow ones.
3. **AI writes the graph alongside the code.** Graph updates go in the same commit as the fix.
4. **Tiered loading.** The agent reads ~50 lines at session start, not 5,000.
5. **Git-native.** Committed, versioned, branched, and reviewed like code.

---

## Scripts

| Script | Purpose |
|---|---|
| `setup.sh` | Interactive installer and upgrader |
| `scripts/seed_prompt.md` | One-shot prompt to bootstrap the graph from cold |
| `scripts/consistency_check.sh` | Verify no broken edge references |
| `scripts/stale_check.sh` | Flag nodes with old dates or dead file references |
| `scripts/auto_map.sh` | Generate structural repo map (requires Universal Ctags) |
| `scripts/token_benchmark.sh` | Measure token efficiency vs a flat file |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
