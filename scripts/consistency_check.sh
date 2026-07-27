#!/usr/bin/env bash
# simplegraph-agentic consistency check
# Verifies graph integrity across the core/ graph and, when present, the
# shared/ (org-level) graph:
#   • no duplicate node IDs (the collision two branches/agents can create
#     without git ever raising a conflict);
#   • no broken edges (every `→ TARGET` resolves to a node, across both graphs);
#   • shared nodes carry attribution — a shared node is loaded as guidance by
#     every repo and agent, so an untraceable org-wide rule is flagged (warning).
#
# Run from the repo root: bash core/scripts/consistency_check.sh
# Optional: --shared <dir> to point at a shared graph explicitly (otherwise a
# sibling `shared/` next to core/ is auto-detected).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SHARED_DIR_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --shared) SHARED_DIR_ARG="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

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

# Resolve the shared graph: explicit flag wins; otherwise a sibling shared/.
SHARED_DIR=""
if [ -n "$SHARED_DIR_ARG" ]; then
  SHARED_DIR="$SHARED_DIR_ARG"
  [ -d "$SHARED_DIR" ] || { echo "ERROR: --shared dir not found at $SHARED_DIR"; exit 1; }
elif [ -d "$(dirname "$CORE_DIR")/shared" ]; then
  SHARED_DIR="$(dirname "$CORE_DIR")/shared"
fi

CORE_STRIPPED=$(mktemp /tmp/sg_core.XXXXXX)
SHARED_STRIPPED=$(mktemp /tmp/sg_shared.XXXXXX)
ALL_STRIPPED=$(mktemp /tmp/sg_all.XXXXXX)
EDGE_TARGETS=$(mktemp /tmp/sg_edge_targets.XXXXXX)
NODE_IDS=$(mktemp /tmp/sg_node_ids.XXXXXX)
trap 'rm -f "${CORE_STRIPPED}" "${SHARED_STRIPPED}" "${ALL_STRIPPED}" "${EDGE_TARGETS}" "${NODE_IDS}"' EXIT

# Strip HTML comments and fenced code blocks (template examples) from each
# hand-authored .md file in a graph dir and append to the given output file.
# Excludes generated/gitignored files. Processes files individually to avoid a
# perl slurp stall on large concatenations.
strip_graph() {
  local dir="$1" out="$2"
  : > "${out}"
  [ -d "$dir" ] || return 0
  while IFS= read -r f; do
    case "$(basename "$f")" in
      auto_map.md|.scratchpad.md) continue ;;
    esac
    perl -0777 -pe 's/<!--.*?-->//gs; s/^```.*?^```//gms' < "$f" >> "${out}"
  done < <(find "$dir" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' | sort)
}

strip_graph "${CORE_DIR}" "${CORE_STRIPPED}"
strip_graph "${SHARED_DIR}" "${SHARED_STRIPPED}"
cat "${CORE_STRIPPED}" "${SHARED_STRIPPED}" > "${ALL_STRIPPED}"

# Node IDs and edge targets span both graphs, so cross-graph edges
# (core → shared, shared → core) resolve instead of reading as broken.
grep -oP '→ \K[A-Z_]+' "${ALL_STRIPPED}" 2>/dev/null | sort -u > "${EDGE_TARGETS}" || true
grep -oP '## NODE: \K[A-Z_]+' "${ALL_STRIPPED}" 2>/dev/null | sort -u > "${NODE_IDS}" || true

STATUS=0
[ -n "$SHARED_DIR" ] && echo "Checking core/ + shared/ ($SHARED_DIR)" || echo "Checking core/"

# 1. Duplicate node IDs (across both graphs). Two agents or two merged branches
#    can independently mint the same ID; git merges the files with no conflict.
DUPES=$(grep -oP '## NODE: \K[A-Z_]+' "${ALL_STRIPPED}" 2>/dev/null | sort | uniq -d || true)
if [ -n "$DUPES" ]; then
  echo "✗ Duplicate node IDs found (same ID defined more than once):"
  echo "$DUPES"
  echo "  Rename one, or merge the two definitions into a single NODE block, then re-run 'sg reindex'."
  STATUS=1
fi

# 2. Broken edge references (targets with no matching NODE in either graph).
BROKEN=$(comm -23 "${EDGE_TARGETS}" "${NODE_IDS}")
if [ -n "$BROKEN" ]; then
  echo "✗ Broken edge references found (targets with no matching NODE):"
  echo "$BROKEN"
  STATUS=1
fi

# 3. Traceability of shared (org-level) nodes. A shared node is loaded as
#    guidance by every repo and agent, so it should say where it came from —
#    an Author (who promoted it), Provenance (mined source), or Seeded marker.
#    Advisory (warning), not fatal: it does not fail the build.
if [ -n "$SHARED_DIR" ] && [ -s "${SHARED_STRIPPED}" ]; then
  UNTRACED=$(awk '
    /^## NODE:/ {
      if (id != "" && !traced) print "  ⚠ " id
      id = $3; traced = 0
    }
    /^\*\*Author:\*\*/ || /^\*\*Provenance:\*\*/ || /^\*\*Seeded:\*\*/ { traced = 1 }
    END { if (id != "" && !traced) print "  ⚠ " id }
  ' "${SHARED_STRIPPED}")
  if [ -n "$UNTRACED" ]; then
    echo "⚠ Shared nodes with no attribution (Author / Provenance / Seeded) — an"
    echo "  org-wide rule with no traceable source. Add an Author when promoting to shared/:"
    echo "$UNTRACED"
  fi
fi

if [ "$STATUS" -eq 0 ]; then
  echo "✓ All edge references are valid and all node IDs are unique."
fi
exit "$STATUS"
