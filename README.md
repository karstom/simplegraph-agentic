# simplegraph-agentic

**Your AI coding agent forgets everything between sessions. This gives it a memory that doesn't.**

Not a vector database. Not a code index. A small, typed graph of the things that only get learned the hard way — the bug that came back six times, the rule nobody wrote down, the decision that looks wrong until you know why. Plain markdown, in your repo, in git.

Works with Antigravity, Claude Code, Cursor, Copilot, Zed, Codex CLI, and anything that takes custom instructions.

---

## What this looks like in practice

You ask your agent to change how sessions are stored. Before it edits anything, it checks the graph:

```
⚠ Found 1 node(s) (1 HIGH priority):

## Directly affected (1)

**Matched on:** edited file `src/auth/session.ts`
### REG_SESSION_FLAG_RESET
**Type:** Regression | **Priority:** HIGH
**Label:** "Secured" badge reappears for protected users after every deploy
**REGRESSED_N_TIMES:** 6
**RootCause:** "Secured" was inferred from three independently-wipeable
sentinels instead of read from one source of truth. Fixes 1–5 each added
another place that re-stamps the flag; none removed the ambiguity.
**Files:** `src/auth/session.ts`, `src/auth/keystore.ts`
```

That node is real — multiple recurrences on a production codebase, anonymized here. Without the graph, the agent confidently writes fix number seven, in a seventh location. With this data, the agent knows the shape of the trap before it steps in.

**That is the whole thing.** It's as simple as possible on purpose. Read below to learn how to use it for your projects.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/karstom/simplegraph-agentic/main/install.sh | bash
```

Run it from inside your project. It detects your AI tool, installs the graph, and — if Node 18+ is available — builds and wires the MCP server so your agent can call the graph directly.

Prefer to read before you pipe:

```bash
curl -fsSL https://raw.githubusercontent.com/karstom/simplegraph-agentic/main/install.sh -o install.sh
less install.sh && bash install.sh
```

Options: `--tool antigravity` (or comma-separated `--tool antigravity,claude-code`), `--tool cursor`, `--dir path/to/project`, `--no-mcp`, `--yes`. Through a pipe, pass them with `bash -s --`. Re-run the same command to upgrade. Supported on Linux, WSL, and macOS.

**On Windows (PowerShell / CMD):**
Clone the repository and install the cross-platform Node CLI:
```powershell
cd mcp
npm install
npm run build
npm link    # exposes `sg` globally, or run via: node dist/seed/cli.js <cmd>
```

## Then give it something to remember

A new graph doesn't have to start empty — most of what it wants is already in your git history:

```bash
sg seed --dry-run     # mine reverts, repeat-fixes, ADRs, and TODOs. Write nothing.
sg seed               # review the draft, then commit it
```

Deterministic, offline, no API key, full provenance on every node. On a 718-commit repo it finds around 60 nodes to start from. See [seeding](docs/seeding.md).

The bundled `sg` CLI also provides cross-platform graph maintenance without bash dependencies:
- `sg check` — validates edge targets and duplicate node IDs across `core/` and `shared/`
- `sg stale` — detects outdated nodes (>90 days) and broken file/symbol anchors
- `sg reindex` — rebuilds `graph_index.md` Quick Index deterministically to resolve merge conflicts

---

## Why a graph and not a bigger AGENT.md

A flat memory file gets read in full on every single request. A graph gets *routed* — the agent reads a ~50-line index, then loads only the two or three files that matter for the task in front of it.

Measured on a production graph of 36 files and 251 nodes, built over 718 commits of real use:

| | Session start | Per task |
|---|---|---|
| **simplegraph** (tiered) | **~974 tokens** | **~6,343 tokens** |
| One flat file | ~52,300 tokens | ~52,300 tokens |

**53× less** at session start, **8× less** for a typical task.

The gap widens as you learn more. Between two measurements this graph grew from 31 files to 36, and the flat-file cost went from ~30,700 to ~52,300 tokens while session start stayed under 1,000. A monolith gets more expensive every time you record something; a routed graph doesn't.

*(Estimated at 1.3 tokens/word — read them as ratios. `bash scripts/token_benchmark.sh` measures your own.)*

### The bigger problem isn't cost — it's whether the right info surfaces at all

A flat file loaded in full doesn't *miss* anything, exactly. It's all in
there. But one invariant is competing with thousands of tokens of other content and
the task itself. Chunk that file and search it instead, and recall becomes
probabilistic — embedding similarity doesn't signal causality, and a missed reference is invisible until the agent makes the same error **again**.

**simplegraph** works in part because the trigger isn't a query. `check_files` is
an exact join on the path and symbol the agent is *already* editing.

For example: Your agent adds a logging call to `IdentityService.ts`. Semantic
search on *"add logging to identity service"* will not surface a node about the reason for the logging - a
user badge that reappeared after every deploy when it should not have. Searching instead for a path key surfaces the issue directly
— sixth recurrence, root cause attached.

**Semantic search needs the agent to remember to ask. This fires because the agent opened
a file.**

| Approach | Where it breaks |
|---|---|
| **Flat `AGENT.md`** | Nothing is absent, but one line competes with everything else — and you burn tokens for all of it on every request |
| **Semantic search / vector DB** | Retrieval is probabilistic and missed retrieval is a silent failure; needs infrastructure to run |
| **Code index** (LSP, code graph) | Knows what the code *is*, not what it has *done to you* — [compose with it](docs/code-graphs.md) instead |
| **Fine-tuning** | Expensive, opaque, but worse - stale the moment the code changes |

**simplegraph** is intentionally limited: recall is bounded by what was recorded — a vector DB over your docs at least contains
everything anyone ever typed. And for open-ended *"what's our approach to X?"*
questions, semantic search over prose beats **simplegraph's** keyword search
outright. **simplegraph** was built for answering this question: **what do I
need to know before touching this file?**

This is more important than it sounds. Higher tier models do a better job choosing the "right" answer more frequently than lower tier models. With **simplegraph** every mistake or invariant gets recorded, and the intelligence required to make the right call goes down. In testing, a project with a well-maintained graph was able to move many functions off of frontier models to cheaper cloud or even locally-hosted models. This tool doesn't prevent a first mistake, but it does a good job of preventing a reoccurrence of a bad pattern once identified. This can make smaller models more cost-effective to run since they spend less time re-learning lessons already recorded in the graph. 

---

## What makes this worth more than notes

**Typed nodes and edges.** Nodes are Components, Invariants, Regressions, Decisions, or Watchlists, connected by typed edges. The agent can follow a chain:

```
AUTH_SERVICE --VIOLATED_BY--> REG_TOKEN_LEAK (×3) --FIXED_BY--> DEC_ROTATE_ON_REFRESH
```

Three hops tell your agent what is fragile here and why.

**A counter that means something.** Every recurrence increments `REGRESSED_N_TIMES`. At 2, the MCP server *refuses* to record another recurrence until the agent answers three questions: what is the source of truth, which invariant is being violated, and why every previous fix was symptomatic. A bug that keeps coming back is often a design problem, and the tool makes the agent work through that before it patches again.

**Anchors that survive refactors.** Nodes attach to files, to symbols (`AuthService.refreshToken`), and to owned directories. A symbol anchor still fires after the file is renamed — and fires when a *caller* is edited, which is usually where the bug actually returns.

**It composes with your code index.** **simplegraph** doesn't parse your source, and won't try. If you run a structural code graph — codebase-memory-mcp, code-review-graph, Graphify, or an LSP — hand its blast radius to `simplegraph_check_files` and get back which of those files have a history. They know what your code *is*; the graph knows what it has *done to you*. See [code graphs](docs/code-graphs.md).

**Zero infrastructure.** No database, no server, no embeddings, no API key. Markdown and git. It reviews in the PR diff like everything else, because a memory node is agent-written text that other agents will later trust.

---

## Editor support

| Tool | Installed to |
|---|---|
| Antigravity | `.agents/plugins/simplegraph/` + `AGENTS.md` |
| Claude Code | `CLAUDE.md` + `.mcp.json` + `.claude/settings.json` (Stop hook) |
| Cursor | `.cursor/rules/memory.mdc` + `.cursor/mcp.json` |
| GitHub Copilot | `.github/copilot-instructions.md` + `.vscode/mcp.json` |
| Zed | `.zed/rules/memory.md` + `.zed/settings.json` context server |
| Codex CLI | `AGENTS.md` + `.codex/config.toml` |
| Anything else | Generic adapter for custom instructions |

The installer picks the right one automatically (or pass multiple comma-separated tools, e.g. `--tool antigravity,claude-code` or interactive choices `1,3`). With the MCP server, the agent gets thirteen tools — the three that matter day to day being `simplegraph_check_files` before an edit, `simplegraph_anti_patterns` before generating code, and `simplegraph_add_node` after a fix. See [`mcp/README.md`](mcp/README.md).

### Determinism & enforcement by tool

Different coding agents provide different levels of enforcement. **simplegraph** supports three tiers depending on the host platform:

| Tool | Session-start context | Mid-task safety (MCP) | Turn-end gate (Stop hook) | Enforcement level |
|---|---|---|---|---|
| **Antigravity** | `.agents/plugins/simplegraph/rules/` + `AGENTS.md` | `.agents/plugins/simplegraph/mcp_config.json` | `hooks.json` (`sg hook require-doc`) | **Deterministic** |
| **Claude Code** | `CLAUDE.md` | `.mcp.json` | `.claude/settings.json` (`sg hook require-doc`) | **Deterministic** |
| **Cursor** | `.cursor/rules/memory.mdc` (`alwaysApply: true`) | `.cursor/mcp.json` | _(Not supported by tool)_ | **Advisory (MCP-backed)** |
| **Zed** | `.zed/rules/memory.md` | `.zed/settings.json` context server | _(Not supported by tool)_ | **Advisory (MCP-backed)** |
| **Codex CLI** | `AGENTS.md` | `.codex/config.toml` | _(Not supported by tool)_ | **Advisory (MCP-backed)** |
| **GitHub Copilot** | `.github/copilot-instructions.md` | `.vscode/mcp.json` | _(Not supported by tool)_ | **Advisory (MCP-backed)** |
| **Generic** | Custom instructions | Manual config | _(Not supported by tool)_ | **Passive** |

- **Deterministic:** The agent is gated by active lifecycle hooks (`Stop`). If a HIGH-priority danger zone was touched without updating the memory graph, the agent is blocked and reminded to document before finishing.
- **Advisory (MCP-backed):** The agent is equipped with MCP tools for checking regressions and updating nodes, but enforcement is prompt-driven (the model decides when to query).
- **Passive:** Relies on custom prompt instructions and manual file reading.

---

## Documentation

| | |
|---|---|
| [Seeding](docs/seeding.md) | Bootstrap a graph from git history |
| [Graph format](docs/graph-format.md) | Node types, edge types, anchors, layout |
| [Maintenance](docs/maintenance.md) | The CI gate, staleness checks, scaling |
| [Code graphs](docs/code-graphs.md) | Composing with a structural index |
| [Multi-agent](docs/multi-agent.md) | Parallel agents, branches, shared org graphs |
| [MCP server](mcp/README.md) | Tools, configuration, environment variables |
| [Updating a graph](core/HOW_TO_UPDATE.md) | When to add a node, and the root-cause gate |

---

## Design principles

1. **Near Zero infrastructure.** Markdown and git. Nothing to run, nothing to host unless you want MCP.
2. **Stay small.** Five high-signal nodes beat fifty shallow ones.
3. **The agent writes the graph alongside the code.** Graph updates ship in the same commit as the fix.
4. **Tiered loading.** Read fifty lines at session start, not five thousand.
5. **Git-native.** Committed, versioned, branched, and reviewed like code.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). If you use this, an issue describing what your graph looks like after a month is genuinely useful.

## License

MIT
