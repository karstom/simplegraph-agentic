#!/usr/bin/env bash
# simplegraph-agentic adapter test suite
# Tests setup.sh installation and adapter content for all supported AI tools.
#
# Usage: bash scripts/test_adapters.sh
# Exit code: 0 = all pass, 1 = failures found

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
PASS=0
FAIL=0
SKIP=0

GREEN=$(tput setaf 2 2>/dev/null || echo "")
RED=$(tput setaf 1 2>/dev/null || echo "")
YELLOW=$(tput setaf 3 2>/dev/null || echo "")
RESET=$(tput sgr0 2>/dev/null || echo "")

pass() { echo "${GREEN}  ✓ $*${RESET}"; PASS=$((PASS+1)); }
fail() { echo "${RED}  ✗ $*${RESET}"; FAIL=$((FAIL+1)); }
skip() { echo "${YELLOW}  ~ $*${RESET}"; SKIP=$((SKIP+1)); }
section() { echo ""; echo "── $* ──────────────────────────────────────────────"; }

# ── Required phrases all adapters must contain ────────────────────────────────
# Keys things every adapter must tell the agent to do:
REQUIRED_PHRASES=(
  "graph_index"      # must reference the index
  "session"          # must mention session-start loading
  "routing|task routing|Routing"  # must mention task routing
  "update|Update"   # must mention updating the graph
)

check_adapter_content() {
  local file="$1"
  local name="$2"
  if [ ! -f "$file" ]; then
    fail "${name}: file not found at ${file}"
    return
  fi
  for phrase in "${REQUIRED_PHRASES[@]}"; do
    if grep -qiE "$phrase" "$file"; then
      pass "${name}: contains '${phrase}'"
    else
      fail "${name}: missing required phrase '${phrase}'"
    fi
  done
}

# ── Check all adapter source files exist and have required content ─────────────
section "Adapter source content checks"

check_adapter_content "${REPO_DIR}/adapters/antigravity/SKILL.md"     "Antigravity"
check_adapter_content "${REPO_DIR}/adapters/cursor/memory.mdc"         "Cursor"
check_adapter_content "${REPO_DIR}/adapters/claude-code/CLAUDE_MEMORY.md" "Claude Code"
check_adapter_content "${REPO_DIR}/adapters/copilot/copilot-instructions-memory.md" "Copilot"
check_adapter_content "${REPO_DIR}/adapters/generic/AGENT_MEMORY.md"  "Generic"

# Antigravity-specific: must have the embed TODO placeholder
section "Antigravity embed placeholder"
if grep -q "<!-- TODO:" "${REPO_DIR}/adapters/antigravity/SKILL.md"; then
  pass "SKILL.md template has embed TODO placeholder"
else
  fail "SKILL.md template missing embed TODO placeholder (setup.sh can't inject index)"
fi

# ── Install each adapter via setup.sh and verify ──────────────────────────────
section "Antigravity install test (setup.sh option 1)"
TMPDIR_AG=$(mktemp -d /tmp/sg_test_ag.XXXXXX)
trap "rm -rf ${TMPDIR_AG}" EXIT

printf "n\n1\n" | bash "${REPO_DIR}/setup.sh" "${TMPDIR_AG}" > /tmp/sg_setup_output.txt 2>&1

SKILL_DEST="${TMPDIR_AG}/.agent/skills/memory/SKILL.md"
if [ -f "${SKILL_DEST}" ]; then
  pass "Antigravity: SKILL.md installed at correct path"
else
  fail "Antigravity: SKILL.md not found at ${SKILL_DEST}"
fi

# Check embed worked (index content should replace TODO)
if [ -f "${SKILL_DEST}" ]; then
  if grep -q "TODO" "${SKILL_DEST}"; then
    fail "Antigravity: TODO placeholder not replaced (embed failed)"
  else
    pass "Antigravity: graph index embedded (no TODO placeholder)"
  fi
  INDEX_LINES=$(grep -c "Quick Index\|Task Routing\|graph_index\|## Quick\|## Task" "${SKILL_DEST}" || echo 0)
  if [ "${INDEX_LINES}" -gt 0 ]; then
    pass "Antigravity: embedded content contains index sections (${INDEX_LINES} matches)"
  else
    fail "Antigravity: embedded SKILL.md missing expected index content"
  fi
fi

# Check scripts were installed
if [ -d "${TMPDIR_AG}/core/scripts" ] && [ -f "${TMPDIR_AG}/core/scripts/consistency_check.sh" ]; then
  pass "Antigravity: core/scripts/ installed correctly"
else
  fail "Antigravity: core/scripts/ missing from installed project"
fi

# Check consistency check passes on fresh install
section "Consistency check on fresh install"
if bash "${TMPDIR_AG}/core/scripts/consistency_check.sh" 2>/dev/null; then
  pass "Consistency check: passes on fresh install"
else
  fail "Consistency check: failed on fresh install"
fi

# ── Cursor adapter install ─────────────────────────────────────────────────────
section "Cursor install test (setup.sh option 2)"
TMPDIR_CU=$(mktemp -d /tmp/sg_test_cu.XXXXXX)
trap "rm -rf ${TMPDIR_CU}" EXIT
printf "n\n2\n" | bash "${REPO_DIR}/setup.sh" "${TMPDIR_CU}" > /dev/null 2>&1
if [ -f "${TMPDIR_CU}/.cursor/rules/memory.mdc" ]; then
  pass "Cursor: memory.mdc installed at .cursor/rules/"
else
  fail "Cursor: memory.mdc not found at .cursor/rules/memory.mdc"
fi

# Check alwaysApply is set
if grep -q "alwaysApply: true" "${TMPDIR_CU}/.cursor/rules/memory.mdc"; then
  pass "Cursor: alwaysApply: true is set"
else
  fail "Cursor: alwaysApply: true is missing — rule won't load automatically"
fi

# ── Copilot adapter install ────────────────────────────────────────────────────
section "Copilot install test (setup.sh option 4)"
TMPDIR_CP=$(mktemp -d /tmp/sg_test_cp.XXXXXX)
trap "rm -rf ${TMPDIR_CP}" EXIT
printf "n\n4\n" | bash "${REPO_DIR}/setup.sh" "${TMPDIR_CP}" > /dev/null 2>&1
if [ -f "${TMPDIR_CP}/.github/copilot-instructions.md" ]; then
  pass "Copilot: copilot-instructions.md installed at .github/"
else
  fail "Copilot: copilot-instructions.md not found"
fi

# ── Scripts exist and are executable ─────────────────────────────────────────
section "Script file checks"
for script in consistency_check.sh stale_check.sh auto_map.sh token_benchmark.sh; do
  if [ -x "${REPO_DIR}/scripts/${script}" ]; then
    pass "scripts/${script}: exists and is executable"
  elif [ -f "${REPO_DIR}/scripts/${script}" ]; then
    fail "scripts/${script}: exists but not executable (run chmod +x)"
  else
    fail "scripts/${script}: not found"
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Results: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"
echo "═══════════════════════════════════════════════════"
echo ""
if [ "${FAIL}" -gt 0 ]; then
  echo "${RED}✗ ${FAIL} test(s) failed. Fix before pushing.${RESET}"
  exit 1
else
  echo "${GREEN}✓ All tests passed.${RESET}"
  exit 0
fi
