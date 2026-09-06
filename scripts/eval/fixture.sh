#!/usr/bin/env bash
# Build a throwaway project fixture for a live-harness eval into $1.
#
# The fixture is a git repo with:
#   • a planted bug in src/config.ts (retry limit is 0),
#   • simplegraph installed with a HIGH-priority Watchlist node that already
#     points at src/config.ts, so a graph-aware agent has something to find,
#   • the Claude Code adapter (CLAUDE.md) and a .mcp.json wiring the built MCP
#     server with SIMPLEGRAPH_ROOT and SIMPLEGRAPH_CALL_LOG,
#   • a TASK.txt telling the agent to consult the graph, fix the bug, and record
#     what it did.
#
# The eval then asserts (assert.sh) that the agent actually used the graph:
# the call log shows check_files + a write, the code changed, and a node landed.
#
# Usage: bash fixture.sh <target_dir>

set -euo pipefail

TARGET="${1:?usage: fixture.sh <target_dir>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MCP_DIST="${REPO}/mcp/dist/index.js"

[ -f "${MCP_DIST}" ] || { echo "ERROR: build the MCP server first (cd mcp && npm run build): ${MCP_DIST} missing" >&2; exit 1; }

mkdir -p "${TARGET}/src"
CALL_LOG="${TARGET}/.sg_calls.log"
: > "${CALL_LOG}"

# ── the planted bug ───────────────────────────────────────────────────────────
cat > "${TARGET}/src/config.ts" <<'TS'
// Network client configuration.
export const config = {
  timeoutMs: 5000,
  retryLimit: 0, // BUG: zero means requests never retry on transient failure
};
TS

# ── simplegraph graph, seeded with a danger zone for that file ─────────────────
cp -r "${REPO}/core" "${TARGET}/core"
# A HIGH-priority Watchlist node an agent should surface via check_files.
cat > "${TARGET}/core/watchlists.md" <<'MD'
## NODE: WATCH_RETRY_CONFIG
**Type:** Watchlist
**Priority:** HIGH
**Label:** Retry configuration is fragile
**Summary:** src/config.ts holds retry/timeout knobs. A zero retryLimit has shipped before and silently disables retries. Changes here need care.
**Tags:** network, retry, config
**Edges:** _(none)_
**Files:** `src/config.ts`
**LastUpdated:** 2026-01-01
MD
: > "${TARGET}/core/regressions.md"
: > "${TARGET}/core/invariants.md"
: > "${TARGET}/core/decisions.md"

# ── Claude Code adapter so the agent knows to consult the graph ────────────────
cat "${REPO}/adapters/claude-code/CLAUDE_MEMORY.md" > "${TARGET}/CLAUDE.md" 2>/dev/null || \
  echo "# Memory: call the simplegraph MCP tools (index, check_files) before editing, and record changes as nodes." > "${TARGET}/CLAUDE.md"

# ── MCP config: bash wrapper form so env reliably reaches the server ───────────
# (Claude Code strips the process env when a server sets `env`, hence the wrapper.)
cat > "${TARGET}/.mcp.json" <<JSON
{
  "mcpServers": {
    "simplegraph": {
      "command": "/bin/bash",
      "args": ["-c", "SIMPLEGRAPH_ROOT='${TARGET}/core' SIMPLEGRAPH_CALL_LOG='${CALL_LOG}' node '${MCP_DIST}'"]
    }
  }
}
JSON

# ── the task ──────────────────────────────────────────────────────────────────
cat > "${TARGET}/TASK.txt" <<'TXT'
There is a bug in src/config.ts: retryLimit is 0, so failed requests never retry.

Before editing, consult the project memory graph via the simplegraph MCP tools
(call simplegraph_check_files on src/config.ts to see known issues). Then set
retryLimit to 3. Finally, record what you did in the graph with
simplegraph_add_node (a Regression describing the zero-retry bug and the fix).
TXT

# ── baseline commit so the eval can diff what the agent changed ────────────────
( cd "${TARGET}"
  git init -q -b main
  git -c user.email=eval@test -c user.name=eval add -A
  git -c user.email=eval@test -c user.name=eval commit -q -m "fixture baseline"
)

echo "${TARGET}"
