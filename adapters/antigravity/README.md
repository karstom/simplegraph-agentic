# Antigravity adapter

Antigravity 2.x doesn't need a bespoke instruction file. It reads **`AGENTS.md`**
at session start natively (IDE v1.20.3+), and loads MCP servers from
**`.agents/mcp_config.json`** (workspace) or `~/.gemini/config/mcp_config.json`
(global, shared by the IDE, CLI, and 2.0). So `setup.sh --tool antigravity`:

1. Installs the shared **`AGENTS.md`** memory section — the same tool-neutral
   content the Codex adapter uses (`adapters/codex/AGENTS_MEMORY.md`), so there's
   one source of truth for AGENTS.md rather than a per-tool copy that drifts.
2. Writes **`.agents/mcp_config.json`** wiring the simplegraph MCP server, which
   is how the agent calls `simplegraph_index` / `simplegraph_check_files` — no
   index embedding required.

This replaces the pre-2.x adapter, which used a project-local
`.agent/skills/memory/SKILL.md` with the index embedded plus a `.antigravityrules`
`view_file` mandate. All three of those mechanisms moved or were removed in
Antigravity 2.x.

**Optional, more idiomatic:** an "Always On" rule at `.agents/rules/simplegraph.md`
for the mandatory session-start read. AGENTS.md covers it for most setups; add the
rule if your Antigravity build doesn't reliably read AGENTS.md first.
