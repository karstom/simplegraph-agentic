#!/usr/bin/env bash
# Deterministic self-test for the eval harness — no API key, no external CLI.
# Proves the fixture, the MCP call log, and the assertions actually work by
# driving the fixture with the mock agent (which does what a real agent should),
# and proves the assertions aren't vacuous by running them against an untouched
# fixture and requiring a FAIL.
#
# This is the part of the eval layer that belongs in CI. The real Claude Code /
# Codex runs stay opt-in (run_evals.sh).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PASS=0; FAIL=0

# The mock agent and assertions need the built server.
if [ ! -f "${REPO}/mcp/dist/index.js" ]; then
  ( cd "${REPO}/mcp" && npm run build >/dev/null 2>&1 ) || { echo "ERROR: could not build the MCP server"; exit 2; }
fi

expect() {  # expect <name> <want-exit> <actual-exit>
  if [ "$2" -eq "$3" ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1 (want exit $2, got $3)"; FAIL=$((FAIL+1)); fi
}

echo "eval harness self-test"

# ── positive: the mock agent uses the graph → assertions PASS ─────────────────
POS=$(mktemp -d "${TMPDIR:-/tmp}/sg_eval_pos.XXXXXX")
bash "${SCRIPT_DIR}/fixture.sh" "${POS}" >/dev/null
node "${SCRIPT_DIR}/mock_agent.mjs" "${POS}" >/dev/null 2>&1
rc=0; bash "${SCRIPT_DIR}/assert.sh" "${POS}" >/dev/null 2>&1 || rc=$?
expect "mock agent that uses the graph passes assertions" 0 "${rc}"
rm -rf "${POS}"

# ── negative: an untouched fixture → assertions FAIL (not vacuous) ─────────────
NEG=$(mktemp -d "${TMPDIR:-/tmp}/sg_eval_neg.XXXXXX")
bash "${SCRIPT_DIR}/fixture.sh" "${NEG}" >/dev/null
rc=0; bash "${SCRIPT_DIR}/assert.sh" "${NEG}" >/dev/null 2>&1 || rc=$?
expect "untouched fixture fails assertions" 1 "${rc}"
rm -rf "${NEG}"

echo ""
echo "  ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
