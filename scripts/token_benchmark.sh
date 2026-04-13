#!/usr/bin/env bash
# simplegraph-agentic token efficiency benchmark
# Measures context window usage across different approaches.
#
# Usage: bash scripts/token_benchmark.sh [CORE_DIR]
#
# Compares:
#   1. Session-start payload (graph_index.md only)
#   2. Typical task load (index + 2 component files + invariants)
#   3. Full graph (everything — never actually loaded in practice)
#   4. Monolith equivalent (if a single flat file were used instead)
#
# Token estimation: ~1.3 tokens per word (standard for English markdown)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Auto-detect core directory
if [ -n "${1:-}" ]; then
  CORE_DIR="$1"
elif [ "$(basename "$(dirname "$SCRIPT_DIR")")" = "core" ]; then
  CORE_DIR="$(dirname "$SCRIPT_DIR")"
elif [ -d "$(dirname "$SCRIPT_DIR")/core" ]; then
  CORE_DIR="$(dirname "$SCRIPT_DIR")/core"
else
  CORE_DIR="$(pwd)/core"
fi

if [ ! -f "${CORE_DIR}/graph_index.md" ]; then
  echo "ERROR: graph_index.md not found at ${CORE_DIR}"
  exit 1
fi

TOKEN_RATIO=1.3  # tokens per word for English markdown

count_tokens() {
  local words
  words=$(cat "$@" 2>/dev/null | wc -w)
  echo "$words"
}

fmt_tokens() {
  local words=$1
  local tokens
  tokens=$(echo "$words * $TOKEN_RATIO" | bc 2>/dev/null || echo "$((words * 13 / 10))")
  # Round to nearest 100
  tokens=$(printf "%.0f" "$tokens" 2>/dev/null || echo "$tokens")
  echo "${tokens}"
}

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║          simplegraph-agentic Token Efficiency Report            ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo "Core directory: ${CORE_DIR}"
echo "Token ratio:    ${TOKEN_RATIO} tokens/word (English markdown)"
echo ""

# ── 1. Session start: graph_index.md only ─────────────────────────────────────
INDEX_WORDS=$(count_tokens "${CORE_DIR}/graph_index.md")
INDEX_TOKENS=$(fmt_tokens "$INDEX_WORDS")
INDEX_LINES=$(wc -l < "${CORE_DIR}/graph_index.md")

echo "─── Session Start (mandatory read) ───────────────────────────────"
echo "  File:      graph_index.md"
echo "  Lines:     ${INDEX_LINES}"
echo "  Words:     ${INDEX_WORDS}"
echo "  ≈ Tokens:  ${INDEX_TOKENS}"
echo ""

# ── 2. Anti-patterns (recommended on code generation) ─────────────────────────
if [ -f "${CORE_DIR}/anti_patterns.md" ]; then
  AP_WORDS=$(count_tokens "${CORE_DIR}/anti_patterns.md")
  AP_TOKENS=$(fmt_tokens "$AP_WORDS")
  echo "─── Anti-Patterns (loaded before code generation) ──────────────"
  echo "  File:      anti_patterns.md"
  echo "  Words:     ${AP_WORDS}"
  echo "  ≈ Tokens:  ${AP_TOKENS}"
  echo ""
fi

# ── 3. Typical task load: index + 2 largest components + invariants ───────────
# Find the 2 largest component files
COMPONENTS=()
if [ -d "${CORE_DIR}/components" ]; then
  while IFS= read -r f; do
    COMPONENTS+=("$f")
  done < <(ls -S "${CORE_DIR}/components/"*.md 2>/dev/null | head -2)
fi

TASK_FILES=("${CORE_DIR}/graph_index.md")
[ -f "${CORE_DIR}/invariants.md" ] && TASK_FILES+=("${CORE_DIR}/invariants.md")
TASK_FILES+=("${COMPONENTS[@]}")

TASK_WORDS=$(count_tokens "${TASK_FILES[@]}")
TASK_TOKENS=$(fmt_tokens "$TASK_WORDS")
TASK_FILE_COUNT=${#TASK_FILES[@]}

echo "─── Typical Task Load (index + invariants + 2 components) ────────"
echo "  Files:     ${TASK_FILE_COUNT}"
for f in "${TASK_FILES[@]}"; do
  echo "             $(basename "$f") ($(wc -w < "$f") words)"
done
echo "  Total:     ${TASK_WORDS} words"
echo "  ≈ Tokens:  ${TASK_TOKENS}"
echo ""

# ── 4. Full graph (everything — theoretical max, never loaded) ────────────────
ALL_WORDS=$(count_tokens $(find "${CORE_DIR}" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md'))
ALL_TOKENS=$(fmt_tokens "$ALL_WORDS")
ALL_FILES=$(find "${CORE_DIR}" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' | wc -l)

echo "─── Full Graph (theoretical max — never loaded at once) ──────────"
echo "  Files:     ${ALL_FILES}"
echo "  Words:     ${ALL_WORDS}"
echo "  ≈ Tokens:  ${ALL_TOKENS}"
echo ""

# ── 5. Comparison summary ─────────────────────────────────────────────────────
echo "═══ Comparison ═════════════════════════════════════════════════════"
echo ""
printf "  %-40s %8s %8s\n" "Approach" "Words" "≈ Tokens"
printf "  %-40s %8s %8s\n" "────────────────────────────────────────" "────────" "────────"
printf "  %-40s %8s %8s\n" "simplegraph: session start only" "$INDEX_WORDS" "$INDEX_TOKENS"
printf "  %-40s %8s %8s\n" "simplegraph: typical task load" "$TASK_WORDS" "$TASK_TOKENS"
printf "  %-40s %8s %8s\n" "Monolith (flat file, every session)" "$ALL_WORDS" "$ALL_TOKENS"
echo ""

# Calculate reduction
if [ "$ALL_WORDS" -gt 0 ]; then
  REDUCTION_SESSION=$((ALL_WORDS / INDEX_WORDS))
  REDUCTION_TASK=$((ALL_WORDS / TASK_WORDS))
  echo "  Session-start:  ${REDUCTION_SESSION}x fewer tokens than monolith"
  echo "  Typical task:   ${REDUCTION_TASK}x fewer tokens than monolith"
fi

echo ""
echo "─── What This Means ──────────────────────────────────────────────"
echo "  • The AI reads ~${INDEX_TOKENS} tokens at session start (the index)"
echo "  • For a typical task it loads ~${TASK_TOKENS} tokens total"
echo "  • A flat-file approach would load ~${ALL_TOKENS} tokens every time"
echo "  • Savings compound across every request in a session"
echo ""
