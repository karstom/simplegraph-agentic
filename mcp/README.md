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
| `simplegraph_check_files` | **Before editing any file** | Returns regressions, watchlists, invariants that reference those files |
| `simplegraph_anti_patterns` | Before generating code | Returns the anti-patterns list |
| `simplegraph_search` | When looking for context by keyword | Searches IDs, labels, summaries, edges, file references |
| `simplegraph_add_node` | After fixing a bug / making a decision | Appends a new node to the correct file |
| `simplegraph_update_node` | When a bug recurs | Increments `REGRESSED_N_TIMES`, auto-upgrades priority to HIGH at ≥2 |

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

## Example agent workflow

With MCP configured, a well-tuned agent will:

1. Call `simplegraph_index` → get the routing table
2. Call `simplegraph_check_files(["DuckDBProvider.ts"])` → get 8 relevant nodes before touching the file
3. Call `simplegraph_nodes("regressions")` → read active regression details
4. Make the code change
5. Call `simplegraph_add_node(...)` → record the fix
6. Call `simplegraph_update_node({id:"REG_X", field:"REGRESSED_N_TIMES", value:"increment"})` if it recurred

## Recommended: use both MCP and the adapter

The skill/CLAUDE.md adapter and the MCP server complement each other:

- **Adapter**: injects the graph index at session start as passive context
- **MCP**: provides active tools for mid-task safety checks and structured updates

Install both via `setup.sh` (adapter) and follow this README (MCP).
