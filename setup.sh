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
ok "core/ installed at ${TARGET}/core/"

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
    cp "${SCRIPT_DIR}/adapters/antigravity/SKILL.md" "${DEST}/SKILL.md"
    ok "Antigravity adapter installed → .agent/skills/memory/SKILL.md"
    ;;
  2)
    DEST="${TARGET}/.cursor/rules"
    mkdir -p "${DEST}"
    cp "${SCRIPT_DIR}/adapters/cursor/memory.mdc" "${DEST}/memory.mdc"
    ok "Cursor adapter installed → .cursor/rules/memory.mdc"
    ;;
  3)
    echo ""
    say "Claude Code adapter: paste the following section into your CLAUDE.md"
    echo "────────────────────────────────────"
    cat "${SCRIPT_DIR}/adapters/claude-code/CLAUDE_MEMORY.md"
    echo "────────────────────────────────────"
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
if bash "${SCRIPT_DIR}/scripts/consistency_check.sh" 2>/dev/null; then
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
