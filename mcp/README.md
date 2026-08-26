# simplegraph-mcp

MCP server for [simplegraph-agentic](https://github.com/karstom/simplegraph-agentic).

Exposes your memory graph as callable tools, so AI agents query it on-demand rather than relying on context injection at session start. Fixes the "agent forgets the graph mid-task" and "relevance threshold skips the skill" problems.

## Why MCP vs. the skill/CLAUDE.md approach?

| | Skill / custom instructions | MCP tools |
|---|---|---|
| Graph loaded | Once at session start (if relevance scores high enough) | On-demand — agent calls when needed |
| Mid-task safety check | Agent must remember | `simplegraph_check_files` before every edit |
| Graph updates | Agent must remember to write markdown | Single `simplegraph_add_node` tool call |
| Works offline | ✅ | ✅ (reads local files) |
| Requires running process | ❌ | ✅ |

Use both: keep the skill/CLAUDE.md as a session-start summary and use MCP for mid-task safety checks and graph updates.

## Tools

| Tool | When to call | What it does |
|---|---|---|
| `simplegraph_index` | Session start | Returns graph_index.md — routing table and quick index |
| `simplegraph_nodes` | When routing table points to a category | Returns all nodes for regressions / invariants / decisions / watchlists / anti_patterns / components |
| `simplegraph_check_files` | **Before editing any file** | Returns regressions, watchlists, invariants anchored to the code you're touching — and, if you supply a blast radius, to the code around it. See [Working on top of a code graph](#working-on-top-of-a-code-graph) |
| `simplegraph_anti_patterns` | Before generating code | Returns the anti-patterns list |
| `simplegraph_search` | When looking for context by keyword | Searches IDs, labels, summaries, edges, file references |
| `simplegraph_add_node` | After fixing a bug / making a decision | Appends a new node (optionally stamped with `author`/`session`) and regenerates the Quick Index |
| `simplegraph_update_node` | When a bug recurs | Increments `REGRESSED_N_TIMES`, auto-upgrades priority to HIGH at ≥2 |
| `simplegraph_reindex` | After a git merge or manual edit | Rebuilds the Quick Index from the node files, deterministically |
| `simplegraph_archive_regression` | When a bug is permanently fixed | Moves a Regression to the archive and refreshes the index |

Writes are safe under concurrent agents: every graph mutation is atomic
(temp-file + rename) and read-modify-write tool calls hold a per-graph advisory
lock, so parallel sessions can't lose each other's updates. See
[Multi-agent development](#multi-agent-development).

## Installation

```bash
cd mcp
npm install
npm run build
```

## Bundled CLI: `sg seed`

This package also ships the `sg` bin. `sg seed` bootstraps a memory graph by
mining a repository's git history and working tree — reverts/fix commits →
Regressions, ADRs and merge bodies → Decisions, rule comments and test names →
Invariants, TODO/churn → Watchlists, directory structure → Components.
Deterministic, offline, no API key; every node carries provenance and a
confidence score, and nothing is written without review (`--dry-run` /
interactive confirm / `--yes`). See the root README for the full flag list.

```bash
npm link          # or: node dist/seed/cli.js seed --help
sg seed /path/to/your/project --dry-run
```

The `sg` bin also provides `sg reindex`, which regenerates `graph_index.md`'s
Quick Index from the current node files. Because the output is sorted and
order-independent, it's the intended way to resolve a `graph_index.md` merge
conflict after two branches both added nodes: take either side, then run
`sg reindex`.

```bash
sg reindex /path/to/your/project     # or: node dist/seed/cli.js reindex --help
```

## Configuration

### Antigravity

Add to `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "sg-my-project": {
      "command": "node",
      "args": ["/absolute/path/to/simplegraph-agentic/mcp/dist/index.js"],
      "env": {
        "SIMPLEGRAPH_ROOT": "/absolute/path/to/your-project/core"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application\ Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "simplegraph": {
      "command": "node",
      "args": ["/absolute/path/to/simplegraph-agentic/mcp/dist/index.js"],
      "env": {
        "SIMPLEGRAPH_ROOT": "/absolute/path/to/your-project/core"
      }
    }
  }
}
```

### Claude Code CLI

Add to `.mcp.json` in your project root (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "simplegraph": {
      "command": "/bin/bash",
      "args": ["-c", "SIMPLEGRAPH_ROOT=/absolute/path/to/your-project/core node /absolute/path/to/simplegraph-agentic/mcp/dist/index.js"]
    }
  }
}
```

Then add `enableAllProjectMcpServers` to `.claude/settings.json` to auto-approve the server without prompting:

```json
{
  "enableAllProjectMcpServers": true
}
```

> **Important:** `mcpServers` is **not** a valid field in `.claude/settings.json` — it is silently ignored. MCP servers for Claude Code CLI must be configured in `.mcp.json`. The bash wrapper is required instead of the `env` field because Claude Code strips the process environment when `env` is set, causing module resolution failures even with an absolute command path.

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "simplegraph": {
      "command": "node",
      "args": ["/absolute/path/to/simplegraph-agentic/mcp/dist/index.js"],
      "env": {
        "SIMPLEGRAPH_ROOT": "${workspaceFolder}/core"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "simplegraph": {
      "command": "node",
      "args": ["/absolute/path/to/simplegraph-agentic/mcp/dist/index.js"],
      "env": {
        "SIMPLEGRAPH_ROOT": "${workspaceFolder}/core"
      }
    }
  }
}
```

### Codex CLI

Add to `.codex/config.toml` in your project root (create it if it doesn't exist):

```toml
[mcp_servers.simplegraph]
command = "node"
args = ["/absolute/path/to/simplegraph-agentic/mcp/dist/index.js"]
env = { SIMPLEGRAPH_ROOT = "/absolute/path/to/your-project/core" }
```

You can also add this to `~/.codex/config.toml` for a global install (useful if you
work across multiple projects — pair with named instances as described in
[Multi-project setup](#multi-project-setup)).

### Zed

Add to `.zed/settings.json` in your project root (create it if it doesn't exist):

```json
{
  "context_servers": {
    "simplegraph": {
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/simplegraph-agentic/mcp/dist/index.js"],
        "env": {
          "SIMPLEGRAPH_ROOT": "/absolute/path/to/your-project/core"
        }
      },
      "settings": {}
    }
  }
}
```

> **Note:** Zed does not support workspace variable substitution in context server config, so absolute paths are required. For multi-project setups, each project needs its own `.zed/settings.json` with the correct `SIMPLEGRAPH_ROOT` path.

> **Using Claude Code CLI?** See the Claude Code CLI section above — it uses `.mcp.json`, not `.zed/settings.json`. This Zed config is for Zed's native AI assistant panel only.

## Multi-project setup

The MCP server is inherently project-scoped — it reads one `core/` directory. How you handle
multiple projects depends on the client:

### Cursor / VS Code — automatic

Use `${workspaceFolder}` in the config. Each workspace resolves independently:

```json
"env": { "SIMPLEGRAPH_ROOT": "${workspaceFolder}/core" }
```

No per-project configuration needed.

### Antigravity / Claude Desktop — named server instances

Both use a global config file, so register one entry per project with a unique name.
The agent namespaces tools by server name and naturally calls the right one:

```json
{
  "mcpServers": {
    "sg-zerofeed": {
      "command": "node",
      "args": ["/path/to/simplegraph-agentic/mcp/dist/index.js"],
      "env": { "SIMPLEGRAPH_ROOT": "/path/to/zerofeed/core" }
    },
    "sg-other-project": {
      "command": "node",
      "args": ["/path/to/simplegraph-agentic/mcp/dist/index.js"],
      "env": { "SIMPLEGRAPH_ROOT": "/path/to/other-project/core" }
    }
  }
}
```

_(Antigravity: `~/.gemini/antigravity/mcp_config.json` — Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`)_

### Shared / cross-repo graph

If your team uses a `shared/` graph (see simplegraph's multi-repo feature), add
`SIMPLEGRAPH_SHARED` alongside `SIMPLEGRAPH_ROOT`. The server merges both:
- Read: all tools search both graphs; shared nodes are tagged `[shared]` in results
- Write: `add_node` and `update_node` always write to the primary project graph

```json
"env": {
  "SIMPLEGRAPH_ROOT": "/path/to/project/core",
  "SIMPLEGRAPH_SHARED": "/path/to/shared/core"
}
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SIMPLEGRAPH_ROOT` | `./core` (relative to cwd) | Path to your project's `core/` directory |
| `SIMPLEGRAPH_SHARED` | _(none)_ | Optional: path to shared team graph `core/` — merged into all read operations |
| `SIMPLEGRAPH_AUTHOR` | _(none)_ | Optional: default `Author` stamped on nodes this server creates (agent/tool name). Per-call `author` argument overrides it. |
| `SIMPLEGRAPH_SESSION` | _(none)_ | Optional: default `Session` stamped on nodes this server creates. Per-call `session` argument overrides it. |
| `SIMPLEGRAPH_CHECK_DETAIL_LIMIT` | `5` | `check_files`: how many direct hits get a full record. The rest are summarized, never hidden. `0` = summarize all. |
| `SIMPLEGRAPH_CHECK_DIGEST_LIMIT` | `20` | `check_files`: how many blast-radius nodes to list. Beyond this, a count is reported. |
| `SIMPLEGRAPH_CHECK_DIGEST_CHARS` | `180` | `check_files`: summary length in a digest entry. |
| `SIMPLEGRAPH_EDGE_PREVIEW` | `6` | Edges shown inline before `_(+N more)_`, in every tool that summarizes nodes. |

The four budget values above are tuned against a 251-node production graph. Raise
them on a small graph where full records are affordable; lower them if many nodes
match a single edit. A malformed value falls back to the default rather than
collapsing to zero and suppressing output.

## Example agent workflow

With MCP configured, a well-tuned agent will:

1. Call `simplegraph_index` → get the routing table
2. Call `simplegraph_check_files({files: ["DuckDBProvider.ts"]})` → get 8 relevant nodes before touching the file
   (better: ask your code graph for the callers first and pass them as `related_files`)
3. Call `simplegraph_nodes("regressions")` → read active regression details
4. Make the code change
5. Call `simplegraph_add_node(...)` → record the fix (the Quick Index is regenerated automatically — no separate index call needed)
6. Call `simplegraph_update_node({id:"REG_X", field:"REGRESSED_N_TIMES", value:"increment"})` if it recurred

## Working on top of a code graph

This server stores **judgment** — what regressed, what's forbidden, why the code is
the way it is. It does not parse your source, and it will not try to: computing a
call graph is what structural code-graph tools already do well.

The two compose. A structural graph can tell you that fifteen files are affected by
your edit. It has nothing to say about *which one of them has regressed three times*.

`simplegraph_check_files` takes four lists so you can hand it the answer:

| Argument | Meaning |
|---|---|
| `files` | Files you are editing |
| `symbols` | Symbols you are editing — qualified (`AuthService.refreshToken`) or bare (`refreshToken`) |
| `related_files` | Files that call, depend on, or test what you're editing |
| `related_symbols` | Callers and dependents of the symbols you're editing |

The first two are direct hits; the last two are the blast radius. Fill the radius
from whatever structural tool you already have — codebase-memory-mcp,
code-review-graph, Graphify, an LSP, or `grep -r <symbol>`:

```jsonc
{
  "files":           ["src/auth/parse.ts"],
  "symbols":         ["parseToken"],
  "related_files":   ["src/auth/service.ts", "src/auth/session.ts"],
  "related_symbols": ["AuthService.refreshToken"]
}
```

Results come back grouped — **Directly affected** first, then **In the blast radius
(not edited directly)** — with a `Matched on:` line explaining why each node fired,
so a widened radius adds context without burying the file you're actually editing.

The response is budgeted. Full records go to the top-ranked direct hits; everything
else is digested to one line plus a clipped summary, and long inline edge lists are
capped. Nothing on the direct path is ever hidden — past the detail limit it is
summarized, not dropped. Expand any digest with `simplegraph_get_node <ID>`, and
tune the budget with the `SIMPLEGRAPH_CHECK_*` environment variables below.

Nodes participate by anchoring to `**Files:**`, `**Symbols:**`, and (for Components)
`**Paths:**`. A symbol anchor keeps a node matchable after its file is renamed; a
`Paths` anchor lets a Component claim a directory, so it fires for files that did not
exist when the node was written. All three are optional — an unanchored graph behaves
exactly as before.

## Multi-agent development

The graph is plain markdown in git, mutated by a short-lived server process per
agent session. Concurrency shows up in two forms — several sessions on one
checkout, and several branches/worktrees that merge later. Both are handled.

### On a shared checkout

When sessions share one working copy, the server keeps writes safe:

- **Atomic writes.** Every write is a temp-file-plus-rename, so another session
  never reads a half-written node file.
- **Per-graph lock.** `add_node`, `update_node`, `archive_regression`, and
  scratchpad appends hold one advisory lock (`.sg.lock` in the graph root) across
  the whole read-modify-write. This is what prevents two sessions from both
  reading `REGRESSED_N_TIMES = N` and both writing `N+1` — the lost-update race
  that would silently drop a recurrence. A lock left by a crashed process is
  reclaimed automatically after a few seconds.

### Across branches and worktrees

When agents work on parallel branches, the graph diverges and merges later. Two
things keep that friction low so graph updates don't get deferred:

- **Union-merged list files.** `core/.gitattributes` marks the append-only node
  files (`regressions.md`, `invariants.md`, `decisions.md`, `watchlists.md`,
  `anti_patterns.md`, and the archive) as `merge=union` — a built-in git driver,
  no config needed. Two branches that each appended a node then merge cleanly
  instead of conflicting on every add.
- **Derived Quick Index.** `graph_index.md` is *not* union-merged (it's a table);
  it's regenerated from the node files. After a merge, run `sg reindex` (or the
  `simplegraph_reindex` tool) — the output is sorted and order-independent, so
  both sides resolve to the same index. `components/*.md` is one node per file,
  so parallel work touches different files.
- **Propagation is not instant.** An agent's node reaches other agents only when
  its branch merges. Commit graph updates in the *same commit* as the code and
  land them promptly; `git fetch` before starting parallel work so you begin from
  the current graph. This is convention, not enforcement — the graph is a git
  artifact and follows your git workflow.
- **After any graph merge:** `sg reindex` then `core/scripts/consistency_check.sh`
  — the latter catches duplicate IDs a union merge can produce when two branches
  minted the same ID (git raises no conflict for that on its own).

### Attribution and the trust boundary

A graph node is agent-authored text that other agents later load as *guidance* —
so a wrong node (a hallucinated "invariant") would be obeyed by every agent that
reads it. The controls:

- **It's in the diff.** Graph writes land in `core/` in the same commit as the
  code, so every node change shows up in code review like any other change. Keep
  it that way — review graph changes, don't rubber-stamp them.
- **Attribution.** Set `SIMPLEGRAPH_AUTHOR`/`SIMPLEGRAPH_SESSION` (or pass
  `author`/`session` to `add_node`) so each node records which agent and session
  created it — the signal for arbitrating conflicting nodes after a merge.
- **Duplicate-ID guard.** `consistency_check.sh` fails if two nodes share an ID.
  Run it in CI or a pre-commit hook.
- **The `shared/` tier is highest-stakes.** A shared node is loaded by *every*
  repo and agent in the org. The server is **read-only** against `SIMPLEGRAPH_SHARED`
  — no agent can write it — so promoting a node to `shared/` is always a
  deliberate human act (copy the node, commit, review). Treat those PRs with more
  scrutiny than per-repo graph changes. `consistency_check.sh` auto-detects a
  sibling `shared/` graph (or take `--shared <dir>`), validates its edges and IDs
  alongside `core/`, and warns when a shared node carries no attribution — an
  org-wide rule with no traceable source.

## Recommended: use both MCP and the adapter

The skill/CLAUDE.md adapter and the MCP server complement each other:

- **Adapter**: injects the graph index at session start as passive context
- **MCP**: provides active tools for mid-task safety checks and structured updates

Install both via `setup.sh` (adapter) and follow this README (MCP).
