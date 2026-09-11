# Antigravity Adapter & Plugin

Simplegraph integrates with Google Antigravity (AGY) as either an all-in-one **Plugin** (`.agents/plugins/simplegraph/`) or via standard **Rules** (`AGENTS.md`).

## What Antigravity 2.x Uses

- **Rules (`AGENTS.md`)**: Automatically loaded into context at session start. Contains the Task Routing guide and points to `simplegraph_index`.
- **Skills (`skills/simplegraph/SKILL.md`)**: Progressively disclosed on-demand runbook for safety checks, recurrence root-cause gates, and graph node authoring.
- **MCP Server (`mcp_config.json`)**: Configures the `simplegraph-mcp` stdio server, exposing all 12 memory tools directly to the agent.
- **Lifecycle Hooks (`hooks.json`)**: Enforces the documentation gate on session Stop when files guarded by HIGH-priority nodes are modified.

## Structure

```
.agents/
└── plugins/
    └── simplegraph/
        ├── plugin.json
        ├── mcp_config.json
        ├── hooks.json
        ├── rules/
        │   └── AGENTS.md
        └── skills/
            └── simplegraph/
                └── SKILL.md
```

`setup.sh --tool antigravity` installs this plugin structure automatically.
