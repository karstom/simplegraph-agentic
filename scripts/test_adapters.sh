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
check_adapter_content "${REPO_DIR}/adapters/codex/AGENTS_MEMORY.md"   "Codex"
check_adapter_content "${REPO_DIR}/adapters/copilot/copilot-instructions-memory.md" "Copilot"
check_adapter_content "${REPO_DIR}/adapters/generic/AGENT_MEMORY.md"  "Generic"

# The claude-code and codex adapters are appended verbatim into a user's
# CLAUDE.md / AGENTS.md, so any installer meta-instruction ("Add this section to
# your project's CLAUDE.md…") leaks in and reads as a nonsensical self-reference.
# Generic/Antigravity are pasted by hand, so their paste-instructions are fine —
# this guard applies only to the auto-injected pair.
FORBIDDEN_META='Add this section to your project|paste [^.]*into your|to enable persistent memory graph support'
check_no_install_meta() {
  local file="$1" name="$2"
  if grep -qiE "${FORBIDDEN_META}" "$file"; then
    fail "${name}: installer meta-text would leak into the user's file:"
    grep -niE "${FORBIDDEN_META}" "$file" | sed 's/^/        /'
  else
    pass "${name}: no installer meta-text leaks into injected content"
  fi
}
check_no_install_meta "${REPO_DIR}/adapters/claude-code/CLAUDE_MEMORY.md" "Claude Code"
check_no_install_meta "${REPO_DIR}/adapters/codex/AGENTS_MEMORY.md"       "Codex"

# Antigravity plugin manifest & rules check
section "Antigravity plugin files"
if [ -f "${REPO_DIR}/adapters/antigravity/plugin.json" ] && [ -f "${REPO_DIR}/adapters/antigravity/rules/AGENTS.md" ]; then
  pass "Antigravity plugin manifest and rules present"
else
  fail "Antigravity plugin.json or rules/AGENTS.md missing"
fi

# ── Install each adapter via setup.sh and verify ──────────────────────────────
section "Antigravity install test (setup.sh option 1)"
TMPDIR_AG=$(mktemp -d /tmp/sg_test_ag.XXXXXX)
trap "rm -rf ${TMPDIR_AG}" EXIT

bash "${REPO_DIR}/setup.sh" "${TMPDIR_AG}" --tool antigravity --mcp --yes > /tmp/sg_setup_output.txt 2>&1

if [ -f "${TMPDIR_AG}/AGENTS.md" ] && grep -q "Memory Graph" "${TMPDIR_AG}/AGENTS.md"; then
  pass "Antigravity: AGENTS.md installed with memory section"
else
  fail "Antigravity: AGENTS.md missing or without memory section"
fi

PLUGIN_DEST="${TMPDIR_AG}/.agents/plugins/simplegraph"
if [ -f "${PLUGIN_DEST}/plugin.json" ] && [ -f "${PLUGIN_DEST}/rules/AGENTS.md" ]; then
  pass "Antigravity: plugin installed at .agents/plugins/simplegraph"
else
  fail "Antigravity: plugin missing from ${PLUGIN_DEST}"
fi

if [ -f "${PLUGIN_DEST}/skills/simplegraph/SKILL.md" ] && [ -f "${PLUGIN_DEST}/hooks.json" ]; then
  pass "Antigravity: skill and hooks installed in plugin"
else
  fail "Antigravity: skill or hooks missing from plugin"
fi

if [ -f "${PLUGIN_DEST}/mcp_config.json" ] || [ -f "${TMPDIR_AG}/.agents/mcp_config.json" ]; then
  pass "Antigravity: MCP configuration installed"
else
  fail "Antigravity: MCP configuration missing"
fi

if [ ! -e "${TMPDIR_AG}/.agent/skills/memory/SKILL.md" ] && [ ! -e "${TMPDIR_AG}/.antigravityrules" ]; then
  pass "Antigravity: no legacy .agent/skills or .antigravityrules artifacts"
else
  fail "Antigravity: legacy skill/.antigravityrules artifact still written"
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
printf "n\n2\ny\n" | bash "${REPO_DIR}/setup.sh" "${TMPDIR_CU}" > /dev/null 2>&1
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

if [ -f "${TMPDIR_CU}/.cursor/mcp.json" ]; then
  pass "Cursor: .cursor/mcp.json written with MCP config"
else
  fail "Cursor: .cursor/mcp.json missing"
fi

# ── Copilot adapter install ────────────────────────────────────────────────────
section "Copilot install test (setup.sh option 4)"
TMPDIR_CP=$(mktemp -d /tmp/sg_test_cp.XXXXXX)
trap "rm -rf ${TMPDIR_CP}" EXIT
printf "n\n4\ny\n" | bash "${REPO_DIR}/setup.sh" "${TMPDIR_CP}" > /dev/null 2>&1
if [ -f "${TMPDIR_CP}/.github/copilot-instructions.md" ]; then
  pass "Copilot: copilot-instructions.md installed at .github/"
else
  fail "Copilot: copilot-instructions.md not found"
fi

if [ -f "${TMPDIR_CP}/.vscode/mcp.json" ]; then
  pass "Copilot: .vscode/mcp.json written with MCP config"
else
  fail "Copilot: .vscode/mcp.json missing"
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

# ── portable process limits ───────────────────────────────────────────────────
# `timeout` is GNU coreutils and `setsid` is util-linux: macOS ships neither.
# Using them bare made three test groups fail on macOS for a reason that had
# nothing to do with the code under test — and worse, made
# "rejects unknown options" pass for the wrong reason, because that assertion
# expects a non-zero exit and `timeout: command not found` is non-zero.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"          # coreutils via Homebrew
else
  TIMEOUT_CMD=""
fi

# run_limited SECONDS COMMAND... — enforce a wall-clock limit anywhere.
# Falls back to a background process plus a poll loop when no timeout binary
# exists, so a hang is still caught rather than blocking the suite forever.
# Returns 124 on timeout, matching GNU timeout.
run_limited() {
  local secs="$1"; shift
  if [ -n "${TIMEOUT_CMD}" ]; then
    "${TIMEOUT_CMD}" "${secs}" "$@"
    return $?
  fi
  "$@" &
  local pid=$! waited=0 rc=0
  while kill -0 "${pid}" 2>/dev/null && [ "${waited}" -lt "${secs}" ]; do
    sleep 1; waited=$((waited + 1))
  done
  if kill -0 "${pid}" 2>/dev/null; then
    kill -9 "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
    return 124
  fi
  wait "${pid}"; rc=$?
  return "${rc}"
}

# ── Non-interactive install (the one-liner path) ──────────────────────────────
# setup.sh must be drivable three ways, and all three have broken before:
#   • piped answers        printf "n\n1\n" | bash setup.sh DIR      (tested above)
#   • explicit flags       bash setup.sh DIR --tool X --yes
#   • no terminal at all   setsid ... < /dev/null                  (CI)
# The failure mode is a hang, so every case here runs under `timeout`.
section "Non-interactive install (flags)"
TMPDIR_NI=$(mktemp -d /tmp/sg_test_ni.XXXXXX)
trap "rm -rf ${TMPDIR_AG} ${TMPDIR_NI}" EXIT

if run_limited 120 bash "${REPO_DIR}/setup.sh" "${TMPDIR_NI}" --tool claude-code --yes \
     > /tmp/sg_setup_ni.txt 2>&1; then
  pass "setup.sh --tool claude-code --yes completes without input"
else
  fail "setup.sh with flags failed or hung (see /tmp/sg_setup_ni.txt)"
fi
[ -f "${TMPDIR_NI}/CLAUDE.md" ] && pass "flags installed the named adapter" \
                               || fail "flags did not install CLAUDE.md"
[ -d "${TMPDIR_NI}/core" ]      && pass "flags installed the graph" \
                               || fail "flags did not install core/"
[ -f "${TMPDIR_NI}/.claude/settings.json" ] && grep -q '"Stop"' "${TMPDIR_NI}/.claude/settings.json" \
  && pass "Claude Code Stop hook wired by default under --yes" \
  || fail "Claude Code Stop hook missing from .claude/settings.json"

section "Non-interactive install (no terminal)"
TMPDIR_CI=$(mktemp -d /tmp/sg_test_ci.XXXXXX)
trap "rm -rf ${TMPDIR_AG} ${TMPDIR_NI} ${TMPDIR_CI}" EXIT

# setsid detaches from the controlling terminal so /dev/tty is unavailable, and
# every prompt must fall through to its default rather than blocking forever.
# There is no macOS equivalent, so skip rather than report a failure that is
# really a missing tool.
if ! command -v setsid >/dev/null 2>&1; then
  skip "no-terminal test needs setsid (util-linux); not available on this platform"
elif run_limited 120 setsid bash "${REPO_DIR}/setup.sh" "${TMPDIR_CI}" --tool skip \
       < /dev/null > /tmp/sg_setup_ci.txt 2>&1; then
  pass "setup.sh completes with no terminal available"
  [ -d "${TMPDIR_CI}/core" ] && pass "graph installed without a terminal" \
                             || fail "core/ missing after headless install"
else
  fail "setup.sh hung or failed without a terminal (see /tmp/sg_setup_ci.txt)"
fi

section "Multi-tool install test (--tool antigravity,claude-code)"
TMPDIR_MULTI=$(mktemp -d /tmp/sg_test_multi.XXXXXX)
trap "rm -rf ${TMPDIR_AG} ${TMPDIR_NI} ${TMPDIR_CI} ${TMPDIR_MULTI}" EXIT

if run_limited 120 bash "${REPO_DIR}/setup.sh" "${TMPDIR_MULTI}" --tool antigravity,claude-code --mcp --yes \
     > /tmp/sg_setup_multi.txt 2>&1; then
  pass "setup.sh --tool antigravity,claude-code --mcp --yes completes without input"
else
  fail "setup.sh with multiple tools failed (see /tmp/sg_setup_multi.txt)"
fi
[ -f "${TMPDIR_MULTI}/AGENTS.md" ] && pass "multi-tool: AGENTS.md installed" \
                               || fail "multi-tool: AGENTS.md missing"
[ -f "${TMPDIR_MULTI}/.agents/plugins/simplegraph/plugin.json" ] && pass "multi-tool: Antigravity plugin installed" \
                               || fail "multi-tool: Antigravity plugin missing"
[ -f "${TMPDIR_MULTI}/CLAUDE.md" ] && pass "multi-tool: CLAUDE.md installed" \
                               || fail "multi-tool: CLAUDE.md missing"
[ -f "${TMPDIR_MULTI}/.mcp.json" ] && pass "multi-tool: .mcp.json installed for Claude Code" \
                               || fail "multi-tool: .mcp.json missing"
[ -f "${TMPDIR_MULTI}/.claude/settings.json" ] && grep -q '"Stop"' "${TMPDIR_MULTI}/.claude/settings.json" \
  && pass "multi-tool: Claude Code Stop hook configured" \
  || fail "multi-tool: Claude Code Stop hook missing"
[ -d "${TMPDIR_MULTI}/core" ] && pass "multi-tool: core graph installed" \
                             || fail "multi-tool: core/ missing"

section "Multi-tool interactive piped test (1,2)"
TMPDIR_PIPE=$(mktemp -d /tmp/sg_test_pipe.XXXXXX)
trap "rm -rf ${TMPDIR_AG} ${TMPDIR_NI} ${TMPDIR_CI} ${TMPDIR_MULTI} ${TMPDIR_PIPE}" EXIT

printf "n\n1,2\ny\ny\n" | bash "${REPO_DIR}/setup.sh" "${TMPDIR_PIPE}" > /tmp/sg_setup_pipe.txt 2>&1 || true
[ -f "${TMPDIR_PIPE}/AGENTS.md" ] && pass "piped multi-tool: AGENTS.md installed" \
                             || fail "piped multi-tool: AGENTS.md missing"
[ -f "${TMPDIR_PIPE}/.cursor/rules/memory.mdc" ] && pass "piped multi-tool: Cursor rule installed" \
                             || fail "piped multi-tool: Cursor rule missing"
[ -f "${TMPDIR_PIPE}/.cursor/mcp.json" ] && pass "piped multi-tool: Cursor mcp.json installed" \
                             || fail "piped multi-tool: Cursor mcp.json missing"

section "Installer entrypoint"
if [ -f "${REPO_DIR}/install.sh" ]; then
  pass "install.sh present"
  bash -n "${REPO_DIR}/install.sh" 2>/dev/null && pass "install.sh parses" \
                                               || fail "install.sh has a syntax error"
  run_limited 30 bash "${REPO_DIR}/install.sh" --help >/dev/null 2>&1 \
    && pass "install.sh --help exits cleanly" || fail "install.sh --help failed"
  if run_limited 30 bash "${REPO_DIR}/install.sh" --bogus >/dev/null 2>&1; then
    fail "install.sh accepted an unknown option"
  else
    pass "install.sh rejects unknown options"
  fi
else
  fail "install.sh not found"
fi

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
