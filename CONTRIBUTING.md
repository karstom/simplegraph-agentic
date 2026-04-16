# Contributing to simplegraph-agentic

## Adding a New Adapter

### The Relevance Threshold Problem

AI agents that score context files by semantic relevance will **skip a skill if the task doesn't appear related to "memory" or "knowledge graphs."** A UI bug or deployment task won't trigger a skill named "memory" with a description about "persistent knowledge." Every adapter must solve this.

Three techniques, in order of effectiveness:

**1. Write an aggressive description (mandatory)**
The `description` field is the primary relevance signal. It must enumerate the task types it covers:
```
"MANDATORY for all tasks. Contains architecture rules, active bugs, dangerous code
zones, and anti-patterns. Required context for bug fixes, UI work, feature
development, refactoring, and deployments. Read before touching any code."
```

**2. Name the skill to be un-skippable (recommended)**
Use a name that can't be filtered by a task-specific heuristic:
- ✅ `00-mandatory-architecture-context`
- ✅ `codebase-memory` (broad)
- ❌ `memory-graph` (sounds optional)

**3. Register as a Knowledge Item if supported (tool-specific)**
Some tools (e.g. Antigravity) have a hardcoded boot sequence that reads Knowledge Items before any context loading. Packaging a pointer as a KI guarantees a read regardless of task type. Consult your tool's docs for the KI format.

### Adapter Requirements

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
