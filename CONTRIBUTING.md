# Contributing to simplegraph-agentic

## Adding a New Adapter

Adapters live in `adapters/{tool-name}/`. A valid adapter must:

1. **Instruct the AI to read `core/graph_index.md` at session start**, before any other action.
2. **Reference the task routing table** — the AI should load only relevant detail files, not the whole graph.
3. **Include the update obligation** — the AI must update the graph after fixing bugs or making decisions, in the same commit.
4. **Include multi-repo handling** — if the graph index specifies a shared graph path, the AI should read it when working across repo boundaries.

Name it after the tool in kebab-case (`my-tool/INSTRUCTIONS.md` or whatever format the tool requires). Add it to the adapter matrix in `README.md`.

## Updating Core Files

The core files (`graph_index.md`, `HOW_TO_UPDATE.md`, node template files) should stay framework-agnostic. Do not add project-specific content. Changes to the node format or edge vocabulary must be reflected in all adapters.

## Keeping Adapters in Sync

If you change the core protocol (e.g., add a new node type or edge type), update all adapters to reflect the change. The adapters are prose instructions — keep them concise and imperative.

## Issues and Discussions

Open an issue for:
- New adapter requests
- Bugs in the consistency check script
- Suggestions for new node types or edge types
