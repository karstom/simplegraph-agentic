#!/usr/bin/env bash
# Run the Claude Code CLI headless against a fixture (built by fixture.sh) so a
# real agent decides whether to use the graph. Assertions are separate
# (assert.sh) — this only drives the agent.
#
# Usage: bash run_claude_code.sh <fixture_dir>
# Exit codes: 0 = the agent ran (assert separately); 77 = SKIPPED (CLI or key
#             absent); other = the CLI itself errored.
#
# Requires: the `claude` CLI on PATH and ANTHROPIC_API_KEY. The fixture ships a
# .mcp.json Claude Code auto-loads from the project dir, wiring the simplegraph
# server with its call log. Flags are best-effort for current Claude Code and
# overridable via SIMPLEGRAPH_CLAUDE_FLAGS; the run is time-boxed.

set -uo pipefail

FIX="${1:?usage: run_claude_code.sh <fixture_dir>}"

command -v claude >/dev/null 2>&1 || { echo "SKIP claude-code: 'claude' CLI not on PATH"; exit 77; }
[ -n "${ANTHROPIC_API_KEY:-}" ]    || { echo "SKIP claude-code: ANTHROPIC_API_KEY not set"; exit 77; }

TIMEOUT="${SIMPLEGRAPH_EVAL_TIMEOUT:-300}"
# --dangerously-skip-permissions: the fixture is a throwaway sandbox, so let the
# agent edit files and call MCP tools without prompts. Override the whole flag
# set with SIMPLEGRAPH_CLAUDE_FLAGS if your CLI version differs.
FLAGS="${SIMPLEGRAPH_CLAUDE_FLAGS:---dangerously-skip-permissions}"

TASK="$(cat "${FIX}/TASK.txt")"

echo "run claude-code in ${FIX} (timeout ${TIMEOUT}s)"
( cd "${FIX}" && timeout "${TIMEOUT}" claude -p "${TASK}" ${FLAGS} )
rc=$?
if [ "${rc}" -eq 124 ]; then echo "claude-code timed out after ${TIMEOUT}s"; fi
exit "${rc}"
