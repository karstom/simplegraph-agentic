# simplegraph-agentic

**Your AI coding agent forgets everything between sessions. This gives it a memory that doesn't.**

Not a vector database. Not a code index. A small, typed graph of the things that only get learned the hard way — the bug that came back six times, the rule nobody wrote down, the decision that looks wrong until you know why. Plain markdown, in your repo, in git.

Works with Claude Code, Cursor, Copilot, Zed, Codex CLI, and anything that takes custom instructions.

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

That node is real — six recurrences on a production codebase, anonymized here. Without it, the agent confidently writes fix number seven, in a seventh location. With it, the agent knows the shape of the trap before it steps in.

**That is the whole product.** Everything below is in service of it.

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

Options: `--tool cursor`, `--dir path/to/project`, `--no-mcp`, `--yes`. Through a pipe, pass them with `bash -s --`. Re-run the same command to upgrade. Linux, WSL, and macOS; bash 3.2+.

## Then give it something to remember

A new graph doesn't have to start empty — most of what it wants is already in your git history:

```bash
sg seed --dry-run     # mine reverts, repeat-fixes, ADRs, and TODOs. Write nothing.
sg seed               # review the draft, then commit it
```

Deterministic, offline, no API key, full provenance on every node. On a 718-commit repo it finds around 60 nodes to start from. See [seeding](docs/seeding.md).

---

## Why a graph and not a bigger CLAUDE.md

A flat memory file gets read in full on every single request. A graph gets *routed* — the agent reads a ~50-line index, then loads only the two or three files that matter for the task in front of it.

Measured on a production graph of 36 files and 251 nodes, built over 718 commits of real use:

| | Session start | Per task |
|---|---|---|
| **simplegraph** (tiered) | **~974 tokens** | **~6,343 tokens** |
| One flat file | ~52,300 tokens | ~52,300 tokens |

**53× less** at session start, **8× less** for a typical task.

The gap widens as you learn more. Between two measurements this graph grew from 31 files to 36, and the flat-file cost went from ~30,700 to ~52,300 tokens while session start stayed under 1,000. A monolith gets more expensive every time you record something; a routed graph doesn't.

*(Estimated at 1.3 tokens/word — read them as ratios. `bash scripts/token_benchmark.sh` measures your own.)*

---

## What makes it more than notes

**Typed nodes and edges.** Nodes are Components, Invariants, Regressions, Decisions, or Watchlists, connected by typed edges. The agent can follow a chain:

```
AUTH_SERVICE --VIOLATED_BY--> REG_TOKEN_LEAK (×3) --FIXED_BY--> DEC_ROTATE_ON_REFRESH
```

Three hops tell it what is fragile here and why.

**A counter that means something.** Every recurrence increments `REGRESSED_N_TIMES`. At 2, the MCP server *refuses* to record another recurrence until the agent answers three questions: what is the source of truth, which invariant is being violated, and why every previous fix was symptomatic. A bug that keeps coming back is a design problem, and the tool makes the agent say so out loud before it patches again.

**Anchors that survive refactors.** Nodes attach to files, to symbols (`AuthService.refreshToken`), and to owned directories. A symbol anchor still fires after the file is renamed — and fires when a *caller* is edited, which is usually where the bug actually returns.

**It composes with your code index.** simplegraph doesn't parse your source, and won't try. If you run a structural code graph — codebase-memory-mcp, code-review-graph, Graphify, or an LSP — hand its blast radius to `simplegraph_check_files` and get back which of those files have a history. They know what your code *is*; this knows what it has *done to you*. See [code graphs](docs/code-graphs.md).

**Zero infrastructure.** No database, no server, no embeddings, no API key. Markdown and git. It reviews in the PR diff like everything else, because a memory node is agent-written text that other agents will later trust.

---

## Editor support

| Tool | Installed to |
|---|---|
| Claude Code | `CLAUDE.md` + `.mcp.json` (MCP server) |
| Cursor | `.cursor/rules/memory.mdc` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Zed | `.zed/rules/memory.md` + context server |
| Codex CLI | `AGENTS.md` + `.codex/config.toml` |
| Anything else | Generic adapter for custom instructions |

The installer picks the right one automatically. With the MCP server, the agent gets eleven tools — the important ones being `simplegraph_check_files` before an edit, `simplegraph_anti_patterns` before generating code, and `simplegraph_add_node` after a fix. See [`mcp/README.md`](mcp/README.md).

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

1. **Zero infrastructure.** Markdown and git. Nothing to run, nothing to host.
2. **Stay small.** Five high-signal nodes beat fifty shallow ones.
3. **The agent writes the graph alongside the code.** Graph updates ship in the same commit as the fix.
4. **Tiered loading.** Read fifty lines at session start, not five thousand.
5. **Git-native.** Committed, versioned, branched, and reviewed like code.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). If you use this, an issue describing what your graph looks like after a month is genuinely useful.

## License

MIT
