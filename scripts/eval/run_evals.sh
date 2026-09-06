#!/usr/bin/env bash
# Live-harness evals: run each available coding agent against a fresh fixture and
# assert it actually used the graph. OPT-IN and key-gated — it never runs as part
# of the default test suite.
#
#   SIMPLEGRAPH_EVALS=1 ANTHROPIC_API_KEY=... bash scripts/eval/run_evals.sh
#
# A harness with no CLI or no key is SKIPPED, not failed. GUI harnesses (Cursor,
# Zed, Antigravity) can't be driven headless and are validated at the
# install/adapter layer by test_adapters.sh instead.
#
# Exit: 0 if every harness that ran passed (skips are fine), 1 if any FAILED.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [ "${SIMPLEGRAPH_EVALS:-}" != "1" ]; then
  cat <<EOF
Live-harness evals are opt-in (they call real agents and cost API tokens).
Enable with SIMPLEGRAPH_EVALS=1 and the relevant key:

  SIMPLEGRAPH_EVALS=1 ANTHROPIC_API_KEY=... bash scripts/eval/run_evals.sh   # Claude Code
  SIMPLEGRAPH_EVALS=1 OPENAI_API_KEY=...    bash scripts/eval/run_evals.sh   # Codex

The deterministic harness self-test (no keys) is: bash scripts/eval/test_eval_harness.sh
EOF
  exit 0
fi

# The agents talk to the built server.
if [ ! -f "${REPO}/mcp/dist/index.js" ]; then
  ( cd "${REPO}/mcp" && npm run build >/dev/null 2>&1 ) || { echo "ERROR: could not build the MCP server"; exit 2; }
fi

PASS=0; FAIL=0; SKIP=0
declare -a FAILED=()

run_one() {  # run_one <label> <runner-script>
  local label="$1" runner="$2"
  echo ""; echo "━━━━ ${label} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  local fix rc=0
  fix=$(mktemp -d "${TMPDIR:-/tmp}/sg_eval_${label}.XXXXXX")
  bash "${SCRIPT_DIR}/fixture.sh" "${fix}" >/dev/null

  bash "${runner}" "${fix}"; rc=$?
  if [ "${rc}" -eq 77 ]; then
    SKIP=$((SKIP+1)); rm -rf "${fix}"; return
  fi
  if [ "${rc}" -ne 0 ]; then
    echo "  runner errored (exit ${rc})"; FAIL=$((FAIL+1)); FAILED[${#FAILED[@]}]="${label} (runner exit ${rc}) — kept: ${fix}"; return
  fi
  if bash "${SCRIPT_DIR}/assert.sh" "${fix}"; then
    PASS=$((PASS+1)); rm -rf "${fix}"
  else
    FAIL=$((FAIL+1)); FAILED[${#FAILED[@]}]="${label} — fixture kept for inspection: ${fix}"
  fi
}

run_one "claude-code" "${SCRIPT_DIR}/run_claude_code.sh"
run_one "codex"       "${SCRIPT_DIR}/run_codex.sh"

echo ""
echo "═══════════════════════════════════════════════════"
echo "eval results: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"
if [ "${FAIL}" -eq 0 ]; then
  [ "${PASS}" -eq 0 ] && echo "(nothing ran — no harness CLI/key available)"
  exit 0
fi
for f in "${FAILED[@]}"; do echo "  ✗ ${f}"; done
exit 1
