#!/usr/bin/env bash
# simplegraph-agentic consistency check
# Verifies no broken edge references in the core/ graph files.
# Run from the repo root: bash scripts/consistency_check.sh

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

# Strip HTML comments, then scan. This avoids false positives from example nodes
# inside <!-- --> blocks in template files.
STRIPPED=$(mktemp /tmp/sg_stripped.XXXXXX)
trap 'rm -f "${STRIPPED}"' EXIT

find "$CORE_DIR" -name '*.md' -exec cat {} + | \
  perl -0777 -pe 's/<!--.*?-->//gs' > "${STRIPPED}"

grep -oP '→ \K[A-Z_]+' "${STRIPPED}" 2>/dev/null | sort -u > /tmp/sg_edge_targets.txt || true
grep -oP '## NODE: \K[A-Z_]+' "${STRIPPED}" 2>/dev/null | sort -u > /tmp/sg_node_ids.txt || true

# Ensure files exist even if empty
touch /tmp/sg_edge_targets.txt /tmp/sg_node_ids.txt

BROKEN=$(comm -23 /tmp/sg_edge_targets.txt /tmp/sg_node_ids.txt)

if [ -z "$BROKEN" ]; then
  echo "✓ All edge references are valid."
  exit 0
else
  echo "✗ Broken edge references found (targets with no matching NODE):"
  echo "$BROKEN"
  exit 1
fi
