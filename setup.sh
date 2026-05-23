#!/usr/bin/env bash
# simplegraph-agentic setup
# Installs the memory graph scaffold into an existing project.
# Usage: bash setup.sh [TARGET_DIR]
# If TARGET_DIR is omitted, installs into the current directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$(pwd)}"

# ── colours ────────────────────────────────────────────────────────────────────
bold=$(tput bold 2>/dev/null || echo "")
reset=$(tput sgr0 2>/dev/null || echo "")
green=$(tput setaf 2 2>/dev/null || echo "")
yellow=$(tput setaf 3 2>/dev/null || echo "")
cyan=$(tput setaf 6 2>/dev/null || echo "")

say()  { echo "${cyan}▶ $*${reset}"; }
ok()   { echo "${green}✓ $*${reset}"; }
warn() { echo "${yellow}! $*${reset}"; }
ask()  { printf "%s" "${bold}$* ${reset}"; }

# Replace the <!-- simplegraph-memory-start/end --> block in a file with new content,
# or append if the markers are not present. Falls back to plain append without python3.
update_adapter_section() {
  local target_file="$1"
  local source_file="$2"
  if grep -q "simplegraph-memory-start" "${target_file}" 2>/dev/null && command -v python3 &>/dev/null; then
    python3 - "${target_file}" "${source_file}" <<'PYEOF'
import sys, re
target, source = sys.argv[1], sys.argv[2]
content = open(target).read()
new_section = open(source).read().strip()
pattern = r'<!-- simplegraph-memory-start -->.*?<!-- simplegraph-memory-end -->'
result = re.sub(pattern, new_section, content, flags=re.DOTALL)
open(target, 'w').write(result)
PYEOF
  else
    echo "" >> "${target_file}"
    cat "${source_file}" >> "${target_file}"
  fi
}

echo ""
echo "${bold}simplegraph-agentic setup${reset}"
echo "────────────────────────────────────"
echo "Target directory: ${TARGET}"
echo ""

# ── detect existing install ────────────────────────────────────────────────────
UPGRADE_MODE=false

if [ -d "${TARGET}/core" ] && [ -f "${TARGET}/core/graph_index.md" ]; then
  NODE_COUNT=$(grep -rl "^## NODE:" "${TARGET}/core/" 2>/dev/null | xargs grep -h "^## NODE:" 2>/dev/null | wc -l | tr -d ' ')
  warn "Existing graph detected at ${TARGET}/core/ (${NODE_COUNT} node(s))."
  echo ""
  echo "${bold}What would you like to do?${reset}"
  echo "  1) Upgrade in place  — keep your graph data, refresh scripts and adapters"
  echo "  2) Clean reinstall   — wipe all graph data and start fresh  ${yellow}[destructive]${reset}"
  echo "  3) Abort"
  echo ""
  ask "Choice [1-3]:"
  read -r install_choice

  case "${install_choice}" in
    1)
      UPGRADE_MODE=true
      say "Upgrading in place — graph data will not be touched."
      ;;
    2)
      echo ""
      warn "This will permanently delete all your graph nodes."
      ask "Type 'yes' to confirm:"
      read -r confirm
      if [ "${confirm}" != "yes" ]; then
        echo "Aborted."
        exit 0
      fi
      ;;
    *)
      echo "Aborted."
      exit 0
      ;;
  esac
fi

# ── copy core scaffold (fresh install only) ────────────────────────────────────
if [ "${UPGRADE_MODE}" = false ]; then
  say "Copying core/ scaffold..."
  cp -r "${SCRIPT_DIR}/core" "${TARGET}/core"
fi

# Always refresh maintenance scripts — they're tooling, not graph data
mkdir -p "${TARGET}/core/scripts"
for script in consistency_check.sh stale_check.sh auto_map.sh auto_map_shared.sh token_benchmark.sh; do
  [ -f "${SCRIPT_DIR}/scripts/${script}" ] && cp "${SCRIPT_DIR}/scripts/${script}" "${TARGET}/core/scripts/${script}"
done
chmod +x "${TARGET}/core/scripts/"*.sh 2>/dev/null || true

if [ "${UPGRADE_MODE}" = false ]; then
  ok "core/ installed at ${TARGET}/core/ (including core/scripts/)"
else
  ok "Maintenance scripts refreshed at ${TARGET}/core/scripts/"
fi

# ── multi-repo (fresh install only) ───────────────────────────────────────────
if [ "${UPGRADE_MODE}" = false ]; then
  echo ""
  ask "Is this part of a multi-repo / team project? [y/N]"
  read -r multirepo
  if [[ "${multirepo}" =~ ^[Yy]$ ]]; then
    say "Copying shared/ scaffold..."
    cp -r "${SCRIPT_DIR}/shared" "${TARGET}/shared"
    ok "shared/ installed at ${TARGET}/shared/"
    echo ""
    warn "Next: set the shared graph path in ${TARGET}/core/graph_index.md"
    warn "      (e.g., ../org-memory/core/graph_index.md)"
  fi
fi

# ── adapter ───────────────────────────────────────────────────────────────────
echo ""
if [ "${UPGRADE_MODE}" = true ]; then
  echo "${bold}Which AI tool adapter would you like to update?${reset}"
else
  echo "${bold}Which AI tool are you using?${reset}"
fi
echo "  1) Antigravity"
echo "  2) Cursor"
echo "  3) Claude Code"
echo "  4) GitHub Copilot"
echo "  5) Zed"
echo "  6) Codex CLI (OpenAI)"
echo "  7) Generic (ChatGPT, Gemini, Windsurf, Aider, etc.)"
echo "  8) Skip for now"
ask "Choice [1-8]:"
read -r adapter_choice

case "${adapter_choice}" in
  1)
    DEST="${TARGET}/.agent/skills/memory"
    mkdir -p "${DEST}"
    SKILL_DEST="${DEST}/SKILL.md"
    cp "${SCRIPT_DIR}/adapters/antigravity/SKILL.md" "${SKILL_DEST}"
    # Embed the project's graph_index.md directly into SKILL.md for reliable loading.
    # Agents load skill files as context but may not actively call view_file.
    # Embedding guarantees the index is seen without requiring a tool call.
    INDEX="${TARGET}/core/graph_index.md"
    if [ -f "${INDEX}" ] && command -v python3 &>/dev/null; then
      # Use python3 to do the embed — avoids shell/perl delimiter
      # conflicts with | characters in markdown table rows
      _action=$([ "${UPGRADE_MODE}" = true ] && echo "updated" || echo "installed")
      python3 -c "
import sys, re
skill = open('${SKILL_DEST}').read()
index = open('${INDEX}').read()
result = re.sub(r'<!-- TODO:.*?-->', index, skill, flags=re.DOTALL)
open('${SKILL_DEST}', 'w').write(result)
" 2>/dev/null && ok "Antigravity adapter ${_action} → .agent/skills/memory/SKILL.md (graph index embedded)" \
      || { ok "Antigravity adapter ${_action} → .agent/skills/memory/SKILL.md"
           warn "Could not embed index — paste core/graph_index.md into SKILL.md manually"; }
    else
      ok "Antigravity adapter $([ "${UPGRADE_MODE}" = true ] && echo "updated" || echo "installed") → .agent/skills/memory/SKILL.md"
      [ ! -f "${INDEX}" ] && warn "graph_index.md not found — paste core/graph_index.md into SKILL.md manually"
      ! command -v python3 &>/dev/null && warn "python3 not found — paste core/graph_index.md into SKILL.md manually"
    fi

    # Enforce strict session start rule for Antigravity
    if ! grep -q "AGENT MEMORY AND CONTEXT" "${TARGET}/.antigravityrules" 2>/dev/null; then
      echo "" >> "${TARGET}/.antigravityrules"
      echo "# AGENT MEMORY AND CONTEXT" >> "${TARGET}/.antigravityrules"
      echo "# CRITICAL: You MUST execute view_file on \`.agent/skills/memory/SKILL.md\`" >> "${TARGET}/.antigravityrules"
      echo "# as your very first action in every conversation, without exception." >> "${TARGET}/.antigravityrules"
      echo "# Do this before writing any code or answering the user's first query." >> "${TARGET}/.antigravityrules"
      say "Injected strict graph loading rule into .antigravityrules"
    fi
    ;;
  2)
    DEST="${TARGET}/.cursor/rules"
    mkdir -p "${DEST}"
    cp "${SCRIPT_DIR}/adapters/cursor/memory.mdc" "${DEST}/memory.mdc"
    ok "Cursor adapter $([ "${UPGRADE_MODE}" = true ] && echo "updated" || echo "installed") → .cursor/rules/memory.mdc"
    ;;
  3)
    CLAUDE_MD="${TARGET}/CLAUDE.md"
    echo ""
    if [ "${UPGRADE_MODE}" = true ] && [ -f "${CLAUDE_MD}" ]; then
      update_adapter_section "${CLAUDE_MD}" "${SCRIPT_DIR}/adapters/claude-code/CLAUDE_MEMORY.md"
      ok "Claude Code adapter updated → CLAUDE.md"
    elif [ -f "${CLAUDE_MD}" ]; then
      ask "CLAUDE.md found — append memory section to it? [Y/n]"
      read -r append_choice
      if [[ ! "${append_choice}" =~ ^[Nn]$ ]]; then
        echo "" >> "${CLAUDE_MD}"
        cat "${SCRIPT_DIR}/adapters/claude-code/CLAUDE_MEMORY.md" >> "${CLAUDE_MD}"
        ok "Claude Code adapter appended → CLAUDE.md"
      else
        say "Skipped. Paste adapters/claude-code/CLAUDE_MEMORY.md into CLAUDE.md manually."
      fi
    else
      cp "${SCRIPT_DIR}/adapters/claude-code/CLAUDE_MEMORY.md" "${CLAUDE_MD}"
      ok "Claude Code adapter installed → CLAUDE.md"
    fi

    # Offer to generate .mcp.json with MCP server config
    # Note: mcpServers is NOT valid in .claude/settings.json — Claude Code reads .mcp.json
    echo ""
    ask "Generate .mcp.json with MCP server config? [Y/n]"
    read -r mcp_choice
    if [[ ! "${mcp_choice}" =~ ^[Nn]$ ]]; then
      MCP_JSON="${TARGET}/.mcp.json"
      CLAUDE_DIR="${TARGET}/.claude"
      SETTINGS_FILE="${CLAUDE_DIR}/settings.json"
      MCP_DIST="$(cd "${SCRIPT_DIR}/mcp" && pwd)/dist/index.js"
      CORE_PATH="$(cd "${TARGET}/core" && pwd)"

      if [ -f "${MCP_JSON}" ]; then
        warn "${MCP_JSON} already exists — add the block below manually:"
        echo ""
        cat <<EOF
  "mcpServers": {
    "simplegraph": {
      "command": "/bin/bash",
      "args": ["-c", "SIMPLEGRAPH_ROOT=${CORE_PATH} node ${MCP_DIST}"]
    }
  }
EOF
      else
        cat > "${MCP_JSON}" <<EOF
{
  "mcpServers": {
    "simplegraph": {
      "command": "/bin/bash",
      "args": ["-c", "SIMPLEGRAPH_ROOT=${CORE_PATH} node ${MCP_DIST}"]
    }
  }
}
EOF
        ok "MCP config written → .mcp.json"
      fi

      # Also ensure enableAllProjectMcpServers is set in .claude/settings.json
      mkdir -p "${CLAUDE_DIR}"
      if [ -f "${SETTINGS_FILE}" ]; then
        if ! grep -q "enableAllProjectMcpServers" "${SETTINGS_FILE}"; then
          warn "${SETTINGS_FILE} already exists — add this field to auto-approve the MCP server:"
          echo '  "enableAllProjectMcpServers": true'
        fi
      else
        cat > "${SETTINGS_FILE}" <<EOF
{
  "enableAllProjectMcpServers": true
}
EOF
        ok "Claude Code settings written → .claude/settings.json"
      fi
      warn "Build the MCP server first: cd ${SCRIPT_DIR}/mcp && npm install && npm run build"
    fi
    ;;
  4)
    DEST="${TARGET}/.github"
    mkdir -p "${DEST}"
    COPILOT_DEST="${DEST}/copilot-instructions.md"
    if [ "${UPGRADE_MODE}" = true ] && [ -f "${COPILOT_DEST}" ]; then
      update_adapter_section "${COPILOT_DEST}" "${SCRIPT_DIR}/adapters/copilot/copilot-instructions-memory.md"
      ok "Copilot adapter updated → .github/copilot-instructions.md"
    elif [ -f "${COPILOT_DEST}" ]; then
      warn "${COPILOT_DEST} already exists — appending memory section."
      echo "" >> "${COPILOT_DEST}"
      cat "${SCRIPT_DIR}/adapters/copilot/copilot-instructions-memory.md" >> "${COPILOT_DEST}"
      ok "Copilot adapter appended → .github/copilot-instructions.md"
    else
      cp "${SCRIPT_DIR}/adapters/copilot/copilot-instructions-memory.md" "${COPILOT_DEST}"
      ok "Copilot adapter installed → .github/copilot-instructions.md"
    fi
    ;;
  5)
    DEST="${TARGET}/.zed/rules"
    mkdir -p "${DEST}"
    cp "${SCRIPT_DIR}/adapters/zed/memory.md" "${DEST}/memory.md"
    ok "Zed adapter $([ "${UPGRADE_MODE}" = true ] && echo "updated" || echo "installed") → .zed/rules/memory.md"

    # Offer to generate .zed/settings.json with context server config
    echo ""
    ask "Generate .zed/settings.json with context server (MCP) config? [Y/n]"
    read -r zed_mcp_choice
    if [[ ! "${zed_mcp_choice}" =~ ^[Nn]$ ]]; then
      ZED_DIR="${TARGET}/.zed"
      ZED_SETTINGS="${ZED_DIR}/settings.json"
      MCP_DIST="$(cd "${SCRIPT_DIR}/mcp" && pwd)/dist/index.js"
      CORE_PATH="$(cd "${TARGET}/core" && pwd)"

      mkdir -p "${ZED_DIR}"
      if [ -f "${ZED_SETTINGS}" ]; then
        warn "${ZED_SETTINGS} already exists — add the block below manually:"
        echo ""
        cat <<EOF
  "context_servers": {
    "simplegraph": {
      "command": {
        "path": "node",
        "args": ["${MCP_DIST}"],
        "env": { "SIMPLEGRAPH_ROOT": "${CORE_PATH}" }
      },
      "settings": {}
    }
  }
EOF
      else
        cat > "${ZED_SETTINGS}" <<EOF
{
  "context_servers": {
    "simplegraph": {
      "command": {
        "path": "node",
        "args": ["${MCP_DIST}"],
        "env": { "SIMPLEGRAPH_ROOT": "${CORE_PATH}" }
      },
      "settings": {}
    }
  }
}
EOF
        ok "Zed context server config written → .zed/settings.json"
      fi
      warn "Build the MCP server first: cd ${SCRIPT_DIR}/mcp && npm install && npm run build"
      warn "Note: claude-acp and Claude Code in terminal use CLAUDE.md, not this config."
    fi
    ;;
  6)
    AGENTS_MD="${TARGET}/AGENTS.md"
    echo ""
    if [ "${UPGRADE_MODE}" = true ] && [ -f "${AGENTS_MD}" ]; then
      update_adapter_section "${AGENTS_MD}" "${SCRIPT_DIR}/adapters/codex/AGENTS_MEMORY.md"
      ok "Codex adapter updated → AGENTS.md"
    elif [ -f "${AGENTS_MD}" ]; then
      ask "AGENTS.md found — append memory section to it? [Y/n]"
      read -r append_choice
      if [[ ! "${append_choice}" =~ ^[Nn]$ ]]; then
        echo "" >> "${AGENTS_MD}"
        cat "${SCRIPT_DIR}/adapters/codex/AGENTS_MEMORY.md" >> "${AGENTS_MD}"
        ok "Codex adapter appended → AGENTS.md"
      else
        say "Skipped. Paste adapters/codex/AGENTS_MEMORY.md into AGENTS.md manually."
      fi
    else
      cp "${SCRIPT_DIR}/adapters/codex/AGENTS_MEMORY.md" "${AGENTS_MD}"
      ok "Codex adapter installed → AGENTS.md"
    fi
    warn "Ensure AGENTS.md support is enabled: set child_agents_md = true in [features] of config.toml"

    # Offer to generate .codex/config.toml with MCP server config
    echo ""
    ask "Generate .codex/config.toml with MCP server config? [Y/n]"
    read -r codex_mcp_choice
    if [[ ! "${codex_mcp_choice}" =~ ^[Nn]$ ]]; then
      CODEX_DIR="${TARGET}/.codex"
      CODEX_CONFIG="${CODEX_DIR}/config.toml"
      MCP_DIST="$(cd "${SCRIPT_DIR}/mcp" && pwd)/dist/index.js"
      CORE_PATH="$(cd "${TARGET}/core" && pwd)"

      mkdir -p "${CODEX_DIR}"
      if [ -f "${CODEX_CONFIG}" ]; then
        warn "${CODEX_CONFIG} already exists — add the block below manually:"
        echo ""
        cat <<EOF
[mcp_servers.simplegraph]
command = "node"
args = ["${MCP_DIST}"]
env = { SIMPLEGRAPH_ROOT = "${CORE_PATH}" }
EOF
      else
        cat > "${CODEX_CONFIG}" <<EOF
[mcp_servers.simplegraph]
command = "node"
args = ["${MCP_DIST}"]
env = { SIMPLEGRAPH_ROOT = "${CORE_PATH}" }
EOF
        ok "MCP config written → .codex/config.toml"
      fi
      warn "Build the MCP server first: cd ${SCRIPT_DIR}/mcp && npm install && npm run build"
    fi
    ;;
  7)
    echo ""
    say "Generic adapter: paste the block inside adapters/generic/AGENT_MEMORY.md"
    say "into your AI tool's custom instructions / system prompt."
    echo ""
    cat "${SCRIPT_DIR}/adapters/generic/AGENT_MEMORY.md"
    ;;
  *)
    warn "Skipped adapter install. See adapters/ to install manually later."
    ;;
esac

# ── consistency check ─────────────────────────────────────────────────────────
echo ""
say "Running consistency check on core/..."
if bash "${TARGET}/core/scripts/consistency_check.sh" 2>/dev/null; then
  ok "Graph is consistent."
else
  if [ "${UPGRADE_MODE}" = true ]; then
    warn "Consistency check flagged an issue — review core/scripts/consistency_check.sh output."
  else
    warn "Consistency check flagged an issue — this is normal for a fresh install."
  fi
fi

# ── done ──────────────────────────────────────────────────────────────────────
echo ""
echo "${bold}$([ "${UPGRADE_MODE}" = true ] && echo "Upgrade" || echo "Setup") complete.${reset}"
echo ""
if [ "${UPGRADE_MODE}" = true ]; then
  echo "Next steps:"
  echo "  1. Rebuild the MCP server if needed: cd ${SCRIPT_DIR}/mcp && npm install && npm run build"
  echo "  2. Restart your AI tool to pick up the updated adapter and MCP tools."
  echo "  3. Commit any updated adapter files alongside your code."
else
  echo "Next steps:"
  echo "  1. Seed the graph: open your AI tool and run the prompt in"
  echo "     ${SCRIPT_DIR}/scripts/seed_prompt.md"
  echo "  2. Review the generated nodes for accuracy."
  echo "  3. Commit core/ to version control."
  echo "  4. Keep the graph up to date: see core/HOW_TO_UPDATE.md"
fi
echo ""
