#!/usr/bin/env bash
# simplegraph-agentic consistency check
# Verifies no broken edge references in the core/ graph files.
# Run from the repo root: bash core/scripts/consistency_check.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Auto-detect: if we're inside core/scripts/, parent is core/
# If we're inside scripts/ at repo root, sibling is core/
if [ "$(basename "$(dirname "$SCRIPT_DIR")")" = "core" ] || [ "$(basename "$SCRIPT_DIR")" != "scripts" ]; then
  CORE_DIR="$(dirname "$SCRIPT_DIR")"
else
  CORE_DIR="$(dirname "$SCRIPT_DIR")/core"
fi

if [ ! -d "$CORE_DIR" ]; then
  echo "ERROR: core/ directory not found at $CORE_DIR"
  exit 1
fi

STRIPPED=$(mktemp /tmp/sg_stripped.XXXXXX)
EDGE_TARGETS=$(mktemp /tmp/sg_edge_targets.XXXXXX)
NODE_IDS=$(mktemp /tmp/sg_node_ids.XXXXXX)
trap 'rm -f "${STRIPPED}" "${EDGE_TARGETS}" "${NODE_IDS}"' EXIT

# Find only hand-authored .md files — exclude generated/gitignored files
# Process each file individually to avoid perl slurp stall on large concatenations
: > "${STRIPPED}"
while IFS= read -r f; do
  case "$(basename "$f")" in
    auto_map.md|.scratchpad.md) continue ;;
  esac
  # Strip HTML comments from each file and append
  perl -0777 -pe 's/<!--.*?-->//gs' < "$f" >> "${STRIPPED}"
done < <(find "$CORE_DIR" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' | sort)

grep -oP '→ \K[A-Z_]+' "${STRIPPED}" 2>/dev/null | sort -u > "${EDGE_TARGETS}" || true
grep -oP '## NODE: \K[A-Z_]+' "${STRIPPED}" 2>/dev/null | sort -u > "${NODE_IDS}" || true

BROKEN=$(comm -23 "${EDGE_TARGETS}" "${NODE_IDS}")

if [ -z "$BROKEN" ]; then
  echo "✓ All edge references are valid."
  exit 0
else
  echo "✗ Broken edge references found (targets with no matching NODE):"
  echo "$BROKEN"
  exit 1
fi
