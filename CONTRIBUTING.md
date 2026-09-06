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

## Testing

Run the full deterministic suite before you push — it's what CI runs, needs no
API keys, and covers everything below in one command:

```bash
bash scripts/test_all.sh
```

It aggregates:

| Suite | What it proves |
|---|---|
| `mcp` — `npm run build && npm test` | MCP handler logic **and** an stdio *contract* test that spawns the real server and drives it over JSON-RPC (`src/contract.test.ts`) |
| `scripts/test_consistency_check.sh` | the edge/duplicate-ID gate fails loudly instead of passing silently |
| `scripts/test_require_documentation.sh` | the "document before you finish" Stop hook blocks and fails open correctly |
| `scripts/test_adapters.sh` | `setup.sh --tool X` installs the right files/content for every adapter |
| `scripts/eval/test_eval_harness.sh` | the live-eval fixture, MCP call log, and assertions work — driven by a deterministic mock agent, plus a negative case proving the assertions aren't vacuous |
| `scripts/consistency_check.sh` | this repo's own graph is consistent |

CI (`.github/workflows/ci.yml`) runs the same script on **ubuntu-latest and
macos-latest** — the macOS runner exists because the shell scripts are hardened
for bash 3.2 and BSD grep/sed, and that claim should be tested, not trusted.

### Live-harness evals (opt-in)

The layers above are deterministic and key-free. Whether a *real* agent actually
uses the graph — reads it before editing, records what it changed — is proven by
a separate, opt-in eval that drives the CLI-scriptable harnesses against a
throwaway fixture:

```bash
SIMPLEGRAPH_EVALS=1 ANTHROPIC_API_KEY=... bash scripts/eval/run_evals.sh   # Claude Code
SIMPLEGRAPH_EVALS=1 OPENAI_API_KEY=...    bash scripts/eval/run_evals.sh   # Codex
```

`fixture.sh` plants a bug in a repo that has simplegraph installed and a
HIGH-priority Watchlist pointing at the buggy file; the agent is asked to consult
the graph, fix the bug, and record a node. `assert.sh` then checks three
independent signals: the **call log** (an opt-in server feature,
`SIMPLEGRAPH_CALL_LOG`) shows `check_files` then a write, the code was fixed, and
a node landed in `core/`. A harness with no CLI or key is **skipped, not failed**.

Kept out of the default gate on purpose: agent runs cost API tokens and are
non-deterministic, so they're smoke evals, not pass/fail CI. GUI harnesses
(Cursor, Zed, Antigravity) can't be driven headless — they're validated at the
install/adapter layer by `test_adapters.sh` instead. The *harness itself* (fixture,
call log, assertions) is CI-tested without keys via `scripts/eval/test_eval_harness.sh`.

## Issues and Discussions

Open an issue for:
- New adapter requests
- Bugs in the consistency check script
- Suggestions for new node types or edge types
