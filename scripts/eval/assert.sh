#!/usr/bin/env bash
# Assert that an agent actually USED the graph on a fixture built by fixture.sh.
# Three independent signals, all required:
#   1. call log shows the agent read the graph (check_files) and wrote to it,
#   2. the code bug was actually fixed,
#   3. a graph node was recorded (core/ changed).
#
# Usage: bash assert.sh <fixture_dir>
# Exit: 0 all signals present, 1 one or more missing (with diagnostics).

set -uo pipefail

FIX="${1:?usage: assert.sh <fixture_dir>}"
CALL_LOG="${FIX}/.sg_calls.log"
FAILS=0

note() { echo "    $*"; }
check() {  # check <description> <condition-cmd...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ✓ ${desc}"; else echo "  ✗ ${desc}"; FAILS=$((FAILS+1)); fi
}

echo "asserting graph usage in ${FIX}"

# 1. The agent read the graph before editing, and wrote back to it.
check "call log shows simplegraph_check_files" grep -q "simplegraph_check_files" "${CALL_LOG}"
if grep -q "simplegraph_add_node\|simplegraph_update_node" "${CALL_LOG}" 2>/dev/null; then
  echo "  ✓ call log shows a graph write (add_node/update_node)"
else
  echo "  ✗ call log shows a graph write (add_node/update_node)"; FAILS=$((FAILS+1))
fi

# 2. The bug was fixed (retryLimit no longer 0).
if grep -Eq "retryLimit:\s*[1-9]" "${FIX}/src/config.ts" 2>/dev/null; then
  echo "  ✓ code fix applied (retryLimit > 0)"
else
  echo "  ✗ code fix applied (retryLimit > 0)"; FAILS=$((FAILS+1))
fi

# 3. A graph node was recorded — core/ changed vs the baseline commit.
if ( cd "${FIX}" && ! git diff --quiet HEAD -- core 2>/dev/null ) \
   || [ -n "$(cd "${FIX}" && git ls-files --others --exclude-standard -- core 2>/dev/null)" ]; then
  echo "  ✓ a graph node was recorded (core/ changed)"
else
  echo "  ✗ a graph node was recorded (core/ changed)"; FAILS=$((FAILS+1))
fi

echo ""
if [ "${FAILS}" -eq 0 ]; then
  echo "PASS — the agent read the graph, fixed the bug, and recorded a node."
  exit 0
fi
note "call log:"; sed 's/^/      /' "${CALL_LOG}" 2>/dev/null | head -20
echo "FAIL — ${FAILS} signal(s) missing."
exit 1
