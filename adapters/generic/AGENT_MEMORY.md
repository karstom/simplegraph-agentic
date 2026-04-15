# simplegraph-agentic — Generic Adapter

Use this file as a system prompt or paste it into your AI tool's custom instructions
when none of the named adapters (Antigravity, Cursor, Claude Code, Copilot) apply.

Compatible with: ChatGPT Projects, Gemini Gems, Windsurf, Aider, Cline, or any tool that
accepts a persistent system prompt.

---

## Paste this into your tool's custom instructions

> **For tools without file-reading capability** (ChatGPT, Gemini Gems, etc.):
> Also paste the contents of `core/graph_index.md` directly below these instructions.
> This guarantees the agent sees the index — otherwise it has no way to load it.
>
> **For tools with file-reading** (Windsurf, Aider, Cline, etc.):
> The instruction below to read `core/graph_index.md` is sufficient.

```
This project uses a persistent memory graph in the `core/` directory.

MANDATORY: At the start of every session, read `core/graph_index.md` before any other action.
It is approximately 40 lines. It contains a Quick Index of all graph nodes and a Task Routing
table that tells you exactly which files to load for your current task.

Load ONLY the files the task routing table directs you to. Do not read the entire graph.

Node types in this graph:
- Component: a service, module, or subsystem
- Invariant: a hard rule that must never be violated
- Regression: a bug that has occurred, with a REGRESSED_N_TIMES count
- Decision: an intentional architectural choice with documented rationale
- Watchlist: a dangerous code area requiring extra caution

Before modifying any component:
- Check its VIOLATED_BY edges (Invariants it may break)
- Check its WATCHLIST edges (known dangerous areas)
- If REGRESSED_N_TIMES >= 2, treat the code as high-risk

After fixing a bug, making a significant decision, or discovering dangerous behavior:
- Update the graph as part of the same commit/change
- Protocol is in core/HOW_TO_UPDATE.md

Multi-repo: If core/graph_index.md specifies a shared graph path, read that index too
when working across repository boundaries.
```
