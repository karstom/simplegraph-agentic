# simplegraph-agentic

A lightweight **persistent memory graph** for AI coding assistants.

Your agent accumulates structured knowledge about your codebase — recurring bugs, deliberate decisions, dangerous code areas — and carries it across sessions without bloating every context window. Works with Claude Code, Cursor, GitHub Copilot, Antigravity, Zed, Codex CLI, and any tool that accepts custom instructions.

---

## The Problem

Every AI coding session starts cold. The agent re-introduces the bug you fixed three times, undoes the architectural decision that was intentional, and generates the pattern your team banned. You re-explain the same context over and over — or worse, you don't, and it silently breaks things.

---

## How It Works

### Tiered loading — 29× fewer tokens at session start

Measured on a production codebase with 31 graph files:

| Approach | Session start | Per task |
|---|---|---|
| **simplegraph (tiered)** | **~933 tokens** | **~6,165 tokens** |
| Monolith (flat file) | ~30,700 tokens | ~30,700 tokens |
| No memory | 0 up front, ~500–2,000 per re-explanation | compounds |

**42× reduction** at session start. **6× reduction** for a typical task. The savings compound across every request in a session — the agent reads ~944 tokens once, then loads only the 2–3 files relevant to the current task. Run `bash scripts/token_benchmark.sh` on your own graph to measure your numbers.

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
3. Bootstrap the graph: run `sg seed` (below) or `scripts/seed_prompt.md` in your AI tool.
4. Commit `core/`.

---

## `sg seed` — bootstrap the graph from your repo's history

A new graph doesn't have to start empty. Everything it wants to store is already
latent in your repository: reverted and repeatedly-fixed files are regressions,
merge bodies and ADRs are decisions, emphatic comments and rule-shaped test names
are invariants, TODO/FIXME markers and high-churn files are watchlists, and your
directory structure is the component map. `sg seed` mines all of it —
**deterministically, offline, no API key** — into a draft you review before
anything is written.

```bash
cd mcp && npm install && npm run build && npm link   # installs the `sg` bin
cd /path/to/your/project
sg seed --dry-run     # mine and summarize, write nothing
sg seed               # mine, review the summary, confirm the merge
```

```
sg seed [PATH]
  --dry-run              mine and summarize, write nothing
  --since <ref|date>     history window (default: last 500 commits)
  --min-confidence <n>   drop draft nodes below threshold (default 0.5)
  --types <list>         restrict to given node types
  --max-per-type <n>     cap per type (default 15)
  --output <path>        write the draft bundle here
  --yes                  skip the interactive confirm
```

Every seeded node carries **provenance** (the commits and file locations it was
mined from) plus a confidence score, so you can audit — and delete — anything
that reads as noise. Re-running is safe: output is idempotent at the same
commit, re-runs after new commits add only what's new, and a seeded node you've
hand-edited is never overwritten (the conflict is reported instead). See the
"Seeded nodes" section of `core/HOW_TO_UPDATE.md`.

`scripts/seed_prompt.md` remains the LLM-assisted alternative: richer summaries,
but non-deterministic and model-dependent. `sg seed` is the reproducible baseline.

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
| **Zed** | `adapters/zed/memory.md` | `.zed/rules/memory.md` |
| **Codex CLI** | `adapters/codex/AGENTS_MEMORY.md` | Appended to `AGENTS.md` (setup.sh handles this) |
| **Generic** | `adapters/generic/AGENT_MEMORY.md` | Paste into custom instructions |
| ~~**Antigravity**~~ | ~~`adapters/antigravity/SKILL.md`~~ | ~~**Deprecated** — broken in Antigravity 2.x~~ |

The generic adapter works with ChatGPT Projects, Gemini Gems, Windsurf, Aider, Cline, or any tool that accepts a persistent system prompt.

> **Zed note:** The rules adapter covers Zed's native AI assistant panel. If you're using Claude Code in Zed's terminal or the `claude-acp` external agent, use the Claude Code adapter instead — those paths already read `CLAUDE.md`. See [`mcp/README.md`](mcp/README.md) for the Zed context server (MCP) configuration.

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

## Multi-agent development

When several agents write the graph at once — parallel Claude Code sessions, worktree-based subagents, or a whole team — two failure modes appear that a single-agent setup never hits: concurrent writers racing on the same checkout, and parallel branches diverging before they merge. The MCP server and tooling handle both:

| Hazard | Protection |
|---|---|
| **Torn / lost writes** on a shared checkout | Every write is atomic (temp-file + rename); read-modify-write tool calls hold a per-graph lock, so a `REGRESSED_N_TIMES` increment can't be silently dropped |
| **Conflicts on every parallel append** | `core/.gitattributes` marks the node list files `merge=union`, so two branches that each added a node merge cleanly instead of colliding |
| **`graph_index.md` merge conflicts** across branches | The Quick Index is *derived* — regenerate it with `sg reindex` instead of hand-merging; the output is sorted and order-independent, so either side resolves identically |
| **Duplicate node IDs** from two branches | `consistency_check.sh` fails the build when one ID is defined twice (across `core/` and `shared/`) |
| **"Which agent wrote this?"** after a merge | Optional `**Author:**` / `**Session:**` fields (set `SIMPLEGRAPH_AUTHOR` / `SIMPLEGRAPH_SESSION`, or pass `author` / `session` to `add_node`) record provenance for arbitration |
| **A wrong node becoming org-wide law** | The MCP server is read-only against `shared/`, so promotion is a deliberate, human-reviewed act; `consistency_check.sh` validates the shared graph and warns on untraceable org-wide nodes |

Propagation is not instant: an agent's node reaches others only when its branch merges, so commit graph updates in the same commit as the code and land them promptly. Because a graph node is agent-authored text that other agents later load as guidance, keep it in the PR diff where a human reviews it — the same trust boundary a shared `shared/` graph relies on. See [`mcp/README.md`](mcp/README.md#multi-agent-development) for the full mechanism.

### Seeding, and closing the decision gap

`sg seed` mines the repository deterministically: offline, no API key, full
provenance on every node, and byte-identical output when re-run at the same
commit. That is the whole CLI — it never calls a model.

What it cannot do is judge. Its Decision extractor only fires when a commit
subject starts with an explicit verb (`refactor`, `migrate`, `adopt`, …), so
seeding this repository found 2 Decisions across 43 commits and missed several
recorded in ordinary commit bodies.

That judgment belongs to the agent you already have connected. The MCP server
exposes **`simplegraph_seed_candidates`**, which returns commits whose message
plausibly contains a rationale, along with the message body and a pre-computed
node ID. The agent reads them, decides which actually state *why* rather than
just *what*, and writes the good ones with the ordinary `simplegraph_add_node`.

This means there is no second model, no API key, no separate billing path, and
no new write path — the agent uses whichever model you are already running, and
its writes go through the same atomic, locked, no-clobber tools as everything
else. Two properties make it safe to call repeatedly:

- **Identity comes from git**, not from the agent: a node's ID is derived from
  the commit subject and SHA, so how the agent words it cannot change it.
- **Candidates already written are never returned**, so calling the tool again
  converges on the remaining work instead of duplicating.

The tool's description instructs the agent to skip anything that describes only
what changed. Where the "why" was never written down it cannot be recovered, and
a missing node beats an invented rationale — these are loaded as guidance by
other agents.

Improving the wording of existing nodes needs no special machinery either: read
them with `simplegraph_nodes` and rewrite with `simplegraph_update_node`, which
can now set `Label` as well as `Summary` and `Tags`.

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
| `scripts/consistency_check.sh` | Verify no broken edge references and no duplicate node IDs |
| `scripts/test_consistency_check.sh` | Tests for the above (run before trusting it as a CI gate) |
| `scripts/stale_check.sh` | Flag nodes with old dates or dead file references |
| `scripts/auto_map.sh` | Generate structural repo map (requires Universal Ctags) |
| `scripts/token_benchmark.sh` | Measure token efficiency vs a flat file |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
