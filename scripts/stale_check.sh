#!/usr/bin/env bash
# simplegraph-agentic stale node detector
# Flags graph nodes that may be outdated.
#
# Usage: bash scripts/stale_check.sh [CORE_DIR] [MAX_AGE_DAYS]
#
# Checks for:
#   1. Nodes with LastUpdated older than MAX_AGE_DAYS (default: 90)
#   2. Nodes referencing file paths that no longer exist on disk
#
# Exit code: 0 if clean, 1 if stale nodes found

set -euo pipefail

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
  STALE_DATES=$(grep -rn "^\*\*LastUpdated:\*\*" --include='*.md' "${CORE_DIR}" | while IFS= read -r line; do
    DATE=$(echo "$line" | grep -oP '\d{4}-\d{2}-\d{2}' || echo "")
    if [ -n "${DATE}" ] && [[ "${DATE}" < "${CUTOFF_DATE}" ]]; then
      FILE=$(echo "$line" | cut -d: -f1)
      # Find the node ID for this file
      NODE_ID=$(grep -B10 "LastUpdated" "$FILE" 2>/dev/null | grep -oP '## NODE: \K[A-Z_]+' | tail -1 || echo "unknown")
      echo "  ⏳ ${NODE_ID} (${DATE}) — $(basename "$FILE")"
    fi
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

DEAD_REFS=$(grep -rn "^\*\*Files:\*\*" --include='*.md' "${CORE_DIR}" | while IFS= read -r line; do
  FILE=$(echo "$line" | cut -d: -f1)
  NODE_ID=$(grep -B10 "Files:" "$FILE" 2>/dev/null | grep -oP '## NODE: \K[A-Z_]+' | tail -1 || echo "unknown")

  # Extract backtick-quoted file paths
  REFS=$(echo "$line" | grep -oP '`[^`]+`' | tr -d '`')
  for ref in $REFS; do
    FULL_PATH="${PROJECT_DIR}/${ref}"
    if [ ! -f "${FULL_PATH}" ] && [ ! -d "${FULL_PATH}" ]; then
      echo "  💀 ${NODE_ID} → ${ref} (not found)"
    fi
  done
done)

if [ -n "${DEAD_REFS}" ]; then
  echo "${DEAD_REFS}"
  FOUND_STALE=true
else
  echo "  ✓ All file references are valid."
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
