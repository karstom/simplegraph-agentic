#!/usr/bin/env bash
# simplegraph-agentic stale node detector
# Flags graph nodes that may be outdated.
#
# Usage: bash scripts/stale_check.sh [CORE_DIR] [MAX_AGE_DAYS]
#
# Checks for:
#   1. Nodes with LastUpdated older than MAX_AGE_DAYS (default: 90)
#   2. Nodes referencing file paths that no longer exist on disk
#   3. Nodes owning **Paths:** directories that no longer exist
#   4. Nodes anchored to **Symbols:** absent from auto_map.md (skipped if unmapped)
#
# Exit code: 0 if clean, 1 if stale nodes found

set -euo pipefail

# Node IDs are UPPER_SNAKE_CASE and MAY CONTAIN DIGITS. Must stay in sync with
# parser.ts and consistency_check.sh — a narrower class truncates IDs.
ID_CLASS='[A-Z][A-Z0-9_]*'

# Portability: POSIX grep -E / sed / awk only. `grep -P` is absent from BSD/macOS
# grep, and every -P call here was wrapped in `|| true`, so on a Mac the checks
# silently degraded instead of failing.

# Drop fenced code blocks and HTML comments so template/example paths are not
# scanned. Kept in sync with consistency_check.sh; duplicated because setup.sh
# copies each script standalone into core/scripts/.
strip_noise() {
  awk '
    /^[[:space:]]*(```|~~~)/ { fence = !fence; next }
    fence { next }
    {
      line = $0
      while (1) {
        if (incomment) {
          i = index(line, "-->")
          if (i == 0) { line = ""; break }
          line = substr(line, i + 3); incomment = 0
        } else {
          i = index(line, "<!--")
          if (i == 0) break
          head = substr(line, 1, i - 1)
          rest = substr(line, i + 4)
          e = index(rest, "-->")
          if (e == 0) { line = head; incomment = 1; break }
          line = head substr(rest, e + 3)
        }
      }
      print line
    }
  ' "$1"
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Auto-detect core directory (mirrors consistency_check.sh logic)
if [ "${1:-}" = "" ]; then
  if [ "$(basename "$(dirname "$SCRIPT_DIR")")" = "core" ]; then
    CORE_DIR="$(dirname "$SCRIPT_DIR")"
  elif [ -d "$(dirname "$SCRIPT_DIR")/core" ]; then
    CORE_DIR="$(dirname "$SCRIPT_DIR")/core"
  else
    CORE_DIR="$(pwd)/core"
  fi
else
  CORE_DIR="$1"
fi
MAX_AGE_DAYS="${2:-90}"
PROJECT_DIR="$(dirname "${CORE_DIR}")"
FOUND_STALE=false

if [ ! -d "${CORE_DIR}" ]; then
  echo "ERROR: core/ directory not found at ${CORE_DIR}"
  exit 1
fi

echo "Stale check: MAX_AGE_DAYS=${MAX_AGE_DAYS}, CORE_DIR=${CORE_DIR}"
echo ""

# ── check 1: old LastUpdated dates ────────────────────────────────────────────
CUTOFF_DATE=$(date -u -d "${MAX_AGE_DAYS} days ago" +%Y-%m-%d 2>/dev/null || \
              date -u -v-${MAX_AGE_DAYS}d +%Y-%m-%d 2>/dev/null || \
              echo "")

if [ -n "${CUTOFF_DATE}" ]; then
  echo "── Nodes older than ${MAX_AGE_DAYS} days (before ${CUTOFF_DATE}) ──"
  # Walk each file's stripped content once, tracking the current node ID, so an
  # old LastUpdated is attributed to the node it actually belongs to.
  STALE_DATES=$(find "${CORE_DIR}" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' | sort | while IFS= read -r mdfile; do
    strip_noise "$mdfile" | awk -v cutoff="${CUTOFF_DATE}" -v fname="$(basename "$mdfile")" -v idre="^## NODE: (${ID_CLASS})$" '
      match($0, /^## NODE: [A-Z][A-Z0-9_]*$/) { node = substr($0, 10); next }
      /^\*\*LastUpdated:\*\*/ {
        if (match($0, /[0-9]{4}-[0-9]{2}-[0-9]{2}/)) {
          d = substr($0, RSTART, RLENGTH)
          if (d < cutoff) printf "  ⏳ %s (%s) — %s\n", (node == "" ? "unknown" : node), d, fname
        }
      }
    '
  done)

  if [ -n "${STALE_DATES}" ]; then
    echo "${STALE_DATES}"
    FOUND_STALE=true
  else
    echo "  ✓ All nodes are recent."
  fi
else
  echo "── Skipping date check (date calculation not supported on this OS) ──"
fi

echo ""

# ── check 2: dead file references ────────────────────────────────────────────
echo "── Nodes referencing files that no longer exist ──"

# For each node, check every path listed in its **Files:** field.
# NOTE: the previous implementation ended a pipeline with `grep ... || true | while`,
# which parses as `grep ... || (true | while ...)`. When grep matched, the while
# loop was skipped entirely and grep's raw output became the "dead refs" report —
# so every node with a **Files:** line was flagged, whether or not the file existed.
DEAD_REFS=$(find "${CORE_DIR}" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' | sort | while IFS= read -r mdfile; do
  strip_noise "$mdfile" \
    | awk '
        match($0, /^## NODE: [A-Z][A-Z0-9_]*$/) { node = substr($0, 10); next }
        /^\*\*Files:\*\*/ { printf "%s\t%s\n", (node == "" ? "unknown" : node), $0 }
      ' \
    | while IFS="$(printf '\t')" read -r node fileline; do
        # Each path is wrapped in backticks: **Files:** `a.ts`, `b.ts`
        echo "$fileline" | grep -Eo '`[^`]+`' | tr -d '`' | while IFS= read -r ref; do
          [ -n "$ref" ] || continue
          FULL_PATH="${PROJECT_DIR}/${ref}"
          if [ ! -e "${FULL_PATH}" ]; then
            echo "  💀 ${node} → ${ref} (not found in $(basename "$mdfile"))"
          fi
        done
      done
done)

if [ -n "${DEAD_REFS}" ]; then
  echo "${DEAD_REFS}"
  FOUND_STALE=true
else
  echo "  ✓ All file references are valid."
fi

echo ""

# ── check 3: dead path ownership ─────────────────────────────────────────────
# **Paths:** entries name directories a node owns (mainly Component nodes). A
# path that no longer exists means the node's ownership matching silently stops
# firing — the node still reads as live but no longer guards anything.
echo "── Nodes owning paths that no longer exist ──"

DEAD_PATHS=$(find "${CORE_DIR}" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' | sort | while IFS= read -r mdfile; do
  strip_noise "$mdfile" \
    | awk '
        match($0, /^## NODE: [A-Z][A-Z0-9_]*$/) { node = substr($0, 10); next }
        /^\*\*Paths:\*\*/ { printf "%s\t%s\n", (node == "" ? "unknown" : node), $0 }
      ' \
    | while IFS="$(printf '\t')" read -r node pathline; do
        echo "$pathline" | grep -Eo '`[^`]+`' | tr -d '`' | while IFS= read -r ref; do
          [ -n "$ref" ] || continue
          if [ ! -d "${PROJECT_DIR}/${ref}" ]; then
            echo "  💀 ${node} → ${ref}/ (directory not found, in $(basename "$mdfile"))"
          fi
        done
      done
done)

if [ -n "${DEAD_PATHS}" ]; then
  echo "${DEAD_PATHS}"
  FOUND_STALE=true
else
  echo "  ✓ All owned paths exist."
fi

echo ""

# ── check 4: symbols missing from the structural map ─────────────────────────
# A **Symbols:** anchor outlives a file rename — that is the point of it — but
# not a deletion or a rename of the symbol itself. auto_map.md is the cheapest
# available symbol inventory; when it is absent the check is skipped rather
# than guessed at, because reporting every symbol as missing would be worse
# than reporting none.
echo "── Nodes anchored to symbols not found in auto_map.md ──"

AUTO_MAP="${CORE_DIR}/auto_map.md"
# An auto_map that exists but carries no symbols is worse than one that is
# absent: every anchored symbol would be reported missing, burying any real
# drift under a wall of false positives. That state is easy to reach — a
# sandboxed snap ctags that could not read the project emits a header-only map.
# Treat "no symbols at all" the same as "no map".
# `grep -c` prints 0 AND exits 1 when there are no matches, so `|| echo 0`
# would append a second zero and make the numeric test below fail outright.
# Assign, then correct the value only if the assignment itself failed.
MAP_SYMBOLS=0
if [ -f "${AUTO_MAP}" ]; then
  MAP_SYMBOLS=$(grep -c '`' "${AUTO_MAP}" 2>/dev/null) || MAP_SYMBOLS=0
fi

if [ ! -f "${AUTO_MAP}" ]; then
  echo "  — Skipped: no auto_map.md. Generate it with: bash scripts/auto_map.sh"
elif [ "${MAP_SYMBOLS}" -eq 0 ]; then
  echo "  — Skipped: auto_map.md contains no symbols, so every anchor would be"
  echo "    reported missing. Regenerate it and check for errors:"
  echo "      bash scripts/auto_map.sh"
else
  MISSING_SYMS=$(find "${CORE_DIR}" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' | sort | while IFS= read -r mdfile; do
    strip_noise "$mdfile" \
      | awk '
          match($0, /^## NODE: [A-Z][A-Z0-9_]*$/) { node = substr($0, 10); next }
          /^\*\*Symbols:\*\*/ { printf "%s\t%s\n", (node == "" ? "unknown" : node), $0 }
        ' \
      | while IFS="$(printf '\t')" read -r node symline; do
          echo "$symline" | grep -Eo '`[^`]+`' | tr -d '`' | while IFS= read -r ref; do
            [ -n "$ref" ] || continue
            # Compare on the unqualified tail: a node may record
            # AuthService.refreshToken while ctags emits only refreshToken.
            TAIL="${ref##*.}"
            TAIL="${TAIL##*::}"
            TAIL="${TAIL##*#}"
            # auto_map wraps every symbol in backticks, so anchoring on the
            # opening backtick avoids matching the name inside a signature.
            if ! grep -qF "\`${TAIL}" "${AUTO_MAP}"; then
              echo "  ❓ ${node} → ${ref} (not in auto_map.md, from $(basename "$mdfile"))"
            fi
          done
        done
  done)

  if [ -n "${MISSING_SYMS}" ]; then
    echo "${MISSING_SYMS}"
    echo ""
    echo "  Note: auto_map.md only covers what ctags parses. Verify before deleting a node —"
    echo "  regenerate with 'bash scripts/auto_map.sh' first if the map is out of date."
    FOUND_STALE=true
  else
    echo "  ✓ All anchored symbols found."
  fi
fi

echo ""

# ── result ────────────────────────────────────────────────────────────────────
if [ "${FOUND_STALE}" = true ]; then
  echo "✗ Stale nodes detected. Review and update as needed."
  exit 1
else
  echo "✓ All nodes are fresh."
  exit 0
fi
