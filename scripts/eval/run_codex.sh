#!/usr/bin/env bash
# Run the Codex CLI headless against a fixture (built by fixture.sh). Codex reads
# MCP servers from .codex/config.toml, so this writes one pointing at the same
# built server and call log the fixture's .mcp.json uses, then runs `codex exec`.
#
# Usage: bash run_codex.sh <fixture_dir>
# Exit codes: 0 = the agent ran (assert separately); 77 = SKIPPED (CLI or key
#             absent); other = the CLI itself errored.
#
# Requires: the `codex` CLI on PATH and OPENAI_API_KEY. Flags are best-effort for
# current Codex and overridable via SIMPLEGRAPH_CODEX_FLAGS; the run is time-boxed.

set -uo pipefail

FIX="${1:?usage: run_codex.sh <fixture_dir>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MCP_DIST="${REPO}/mcp/dist/index.js"

command -v codex >/dev/null 2>&1 || { echo "SKIP codex: 'codex' CLI not on PATH"; exit 77; }
[ -n "${OPENAI_API_KEY:-}" ]      || { echo "SKIP codex: OPENAI_API_KEY not set"; exit 77; }

# Codex MCP config for this fixture — same server + call log as the .mcp.json.
mkdir -p "${FIX}/.codex"
cat > "${FIX}/.codex/config.toml" <<TOML
[mcp_servers.simplegraph]
command = "/bin/bash"
args = ["-c", "SIMPLEGRAPH_ROOT='${FIX}/core' SIMPLEGRAPH_CALL_LOG='${FIX}/.sg_calls.log' node '${MCP_DIST}'"]
TOML

TIMEOUT="${SIMPLEGRAPH_EVAL_TIMEOUT:-300}"
FLAGS="${SIMPLEGRAPH_CODEX_FLAGS:-}"
TASK="$(cat "${FIX}/TASK.txt")"

echo "run codex in ${FIX} (timeout ${TIMEOUT}s)"
# CODEX_HOME=.codex so it reads the fixture-local config, not the user's global one.
( cd "${FIX}" && CODEX_HOME="${FIX}/.codex" timeout "${TIMEOUT}" codex exec ${FLAGS} "${TASK}" )
rc=$?
if [ "${rc}" -eq 124 ]; then echo "codex timed out after ${TIMEOUT}s"; fi
exit "${rc}"
