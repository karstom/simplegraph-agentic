#!/usr/bin/env bash
# simplegraph-agentic — run every deterministic test suite in one shot.
#
# Covers: the MCP unit + stdio-contract tests (TypeScript), the shell gates
# (consistency check, documentation Stop hook), the adapter install matrix
# across all supported tools, and the repo's own graph consistency. No API keys,
# no network beyond `npm ci`. This is exactly what CI runs — run it before you
# push. Exit 0 only if everything passes.

set -uo pipefail   # NOT -e: we run every suite and summarize, even after a failure.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
declare -a FAILED=()

step() {
  local name="$1"; shift
  echo ""
  echo "━━━━ ${name} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if "$@"; then
    echo "✓ ${name}"
  else
    echo "✗ ${name}"
    FAILED[${#FAILED[@]}]="${name}"   # bash 3.2-safe append (no += on maybe-unset)
  fi
}

mcp_suite() {
  ( cd "${ROOT}/mcp" || return 1
    # Self-sufficient locally; CI installs separately but this is idempotent.
    if [ ! -d node_modules ]; then npm ci --silent --no-fund --no-audit || return 1; fi
    npm run build --silent || return 1   # tsc is also a type check
    npm test )
}

step "MCP unit + contract tests"  mcp_suite
step "consistency-check gate"     bash "${ROOT}/scripts/test_consistency_check.sh"
step "documentation Stop hook"    bash "${ROOT}/scripts/test_require_documentation.sh"
step "adapter install matrix"     bash "${ROOT}/scripts/test_adapters.sh"
step "eval harness self-test"     bash "${ROOT}/scripts/eval/test_eval_harness.sh"
step "repo graph consistency"     bash "${ROOT}/scripts/consistency_check.sh"

echo ""
echo "═══════════════════════════════════════════════════"
if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "✓ All suites passed."
  exit 0
fi
echo "✗ Failed suites: ${FAILED[*]}"
exit 1
