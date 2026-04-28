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

echo ""
echo "${bold}simplegraph-agentic setup${reset}"
echo "────────────────────────────────────"
echo "Target directory: ${TARGET}"
echo ""

# ── guard: already installed ───────────────────────────────────────────────────
if [ -d "${TARGET}/core" ] && [ -f "${TARGET}/core/graph_index.md" ]; then
  warn "core/ already exists in ${TARGET}."
  ask "Overwrite? [y/N]"
  read -r overwrite
  if [[ ! "${overwrite}" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ── copy core scaffold ─────────────────────────────────────────────────────────
say "Copying core/ scaffold..."
cp -r "${SCRIPT_DIR}/core" "${TARGET}/core"
# Install maintenance scripts into core/scripts/ (co-located with the graph)
mkdir -p "${TARGET}/core/scripts"
for script in consistency_check.sh stale_check.sh auto_map.sh auto_map_shared.sh token_benchmark.sh; do
  [ -f "${SCRIPT_DIR}/scripts/${script}" ] && cp "${SCRIPT_DIR}/scripts/${script}" "${TARGET}/core/scripts/${script}"
done
chmod +x "${TARGET}/core/scripts/"*.sh 2>/dev/null || true
ok "core/ installed at ${TARGET}/core/ (including core/scripts/)"

# ── multi-repo ─────────────────────────────────────────────────────────────────
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

# ── adapter ───────────────────────────────────────────────────────────────────
echo ""
echo "${bold}Which AI tool are you using?${reset}"
echo "  1) Antigravity"
echo "  2) Cursor"
echo "  3) Claude Code"
echo "  4) GitHub Copilot"
echo "  5) Generic (ChatGPT, Gemini, Windsurf, Aider, etc.)"
echo "  6) Skip for now"
ask "Choice [1-6]:"
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
      python3 -c "
import sys, re
skill = open('${SKILL_DEST}').read()
index = open('${INDEX}').read()
result = re.sub(r'<!-- TODO:.*?-->', index, skill, flags=re.DOTALL)
open('${SKILL_DEST}', 'w').write(result)
" 2>/dev/null && ok "Antigravity adapter installed → .agent/skills/memory/SKILL.md (graph index embedded)" \
      || { ok "Antigravity adapter installed → .agent/skills/memory/SKILL.md"
           warn "Could not embed index — paste core/graph_index.md into SKILL.md manually"; }
    else
      ok "Antigravity adapter installed → .agent/skills/memory/SKILL.md"
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
    ok "Cursor adapter installed → .cursor/rules/memory.mdc"
    ;;
  3)
    CLAUDE_MD="${TARGET}/CLAUDE.md"
    echo ""
    if [ -f "${CLAUDE_MD}" ]; then
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

    # Offer to generate .claude/settings.json with MCP server config
    echo ""
    ask "Generate .claude/settings.json with MCP server config? [Y/n]"
    read -r mcp_choice
    if [[ ! "${mcp_choice}" =~ ^[Nn]$ ]]; then
      CLAUDE_DIR="${TARGET}/.claude"
      SETTINGS_FILE="${CLAUDE_DIR}/settings.json"
      MCP_DIST="$(cd "${SCRIPT_DIR}/mcp" && pwd)/dist/index.js"
      CORE_PATH="$(cd "${TARGET}/core" && pwd)"

      mkdir -p "${CLAUDE_DIR}"
      if [ -f "${SETTINGS_FILE}" ]; then
        warn "${SETTINGS_FILE} already exists — add the block below manually:"
        echo ""
        cat <<EOF
  "mcpServers": {
    "simplegraph": {
      "command": "node",
      "args": ["${MCP_DIST}"],
      "env": { "SIMPLEGRAPH_ROOT": "${CORE_PATH}" }
    }
  }
EOF
      else
        cat > "${SETTINGS_FILE}" <<EOF
{
  "mcpServers": {
    "simplegraph": {
      "command": "node",
      "args": ["${MCP_DIST}"],
      "env": { "SIMPLEGRAPH_ROOT": "${CORE_PATH}" }
    }
  }
}
EOF
        ok "MCP config written → .claude/settings.json"
      fi
      warn "Build the MCP server first: cd ${SCRIPT_DIR}/mcp && npm install && npm run build"
    fi
    ;;
  4)
    DEST="${TARGET}/.github"
    mkdir -p "${DEST}"
    COPILOT_DEST="${DEST}/copilot-instructions.md"
    if [ -f "${COPILOT_DEST}" ]; then
      warn "${COPILOT_DEST} already exists — appending memory section."
      echo "" >> "${COPILOT_DEST}"
      cat "${SCRIPT_DIR}/adapters/copilot/copilot-instructions-memory.md" >> "${COPILOT_DEST}"
    else
      cp "${SCRIPT_DIR}/adapters/copilot/copilot-instructions-memory.md" "${COPILOT_DEST}"
    fi
    ok "Copilot adapter installed → .github/copilot-instructions.md"
    ;;
  5)
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
say "Running consistency check on installed core/..."
if bash "${TARGET}/core/scripts/consistency_check.sh" 2>/dev/null; then
  ok "Graph is consistent."
else
  warn "Consistency check flagged an issue — this is normal for a fresh install."
fi

# ── done ──────────────────────────────────────────────────────────────────────
echo ""
echo "${bold}Setup complete.${reset}"
echo ""
echo "Next steps:"
echo "  1. Seed the graph: open your AI tool and run the prompt in"
echo "     ${SCRIPT_DIR}/scripts/seed_prompt.md"
echo "  2. Review the generated nodes for accuracy."
echo "  3. Commit core/ to version control."
echo "  4. Keep the graph up to date: see core/HOW_TO_UPDATE.md"
echo ""
