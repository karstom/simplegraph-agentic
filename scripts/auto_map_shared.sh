#!/usr/bin/env bash
# simplegraph-agentic shared auto-map generator
# Generates a combined public API surface map across multiple repos.
#
# Usage: bash scripts/auto_map_shared.sh [SHARED_DIR]
#
# Reads repo paths from shared/auto_map_config.yaml.
# Output: shared/auto_map.md (gitignored)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED_DIR="${1:-$(dirname "$SCRIPT_DIR")/shared}"
CONFIG="${SHARED_DIR}/auto_map_config.yaml"
OUTPUT="${SHARED_DIR}/auto_map.md"

if [ ! -f "${CONFIG}" ]; then
  echo "ERROR: Config not found at ${CONFIG}"
  echo "Create shared/auto_map_config.yaml with repo paths."
  exit 1
fi

# Parse repo paths from YAML (simple grep — no YAML parser needed)
REPOS=$(grep -E '^\s+-\s+' "${CONFIG}" | sed 's/^\s*-\s*//' | grep -v '^#')

if [ -z "${REPOS}" ]; then
  echo "ERROR: No repos configured in ${CONFIG}."
  echo "Uncomment or add repo paths under 'repos:'."
  exit 1
fi

{
  echo "# Shared Auto-generated Interface Map"
  echo "<!-- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) -->"
  echo "<!-- Mode: public API surface only (--public-only) -->"
  echo "<!-- Source: ${CONFIG} -->"
  echo ""
} > "${OUTPUT}"

# Generate per-repo public maps and append
while IFS= read -r repo_path; do
  # Resolve relative paths from shared/ directory
  if [[ ! "${repo_path}" = /* ]]; then
    repo_path="$(cd "${SHARED_DIR}" && cd "${repo_path}" 2>/dev/null && pwd)" || {
      echo "WARNING: Cannot resolve path: ${repo_path} — skipping"
      continue
    }
  fi

  REPO_NAME=$(basename "${repo_path}")
  echo "  Scanning ${REPO_NAME}..."

  # Use the main auto_map.sh in --public-only mode to a temp location
  TEMP_CORE=$(mktemp -d)
  mkdir -p "${TEMP_CORE}/core"
  bash "${SCRIPT_DIR}/auto_map.sh" --public-only "${repo_path}" 2>/dev/null || true

  if [ -f "${repo_path}/core/auto_map.md" ]; then
    {
      echo ""
      echo "---"
      echo ""
      echo "# ${REPO_NAME}"
      echo ""
      # Strip the header lines and append the symbols
      tail -n +5 "${repo_path}/core/auto_map.md"
    } >> "${OUTPUT}"
  fi

  rm -rf "${TEMP_CORE}"
done <<< "${REPOS}"

LINES=$(wc -l < "${OUTPUT}")
echo "✓ Shared auto-map generated: ${OUTPUT}"
echo "  ${LINES} lines"
