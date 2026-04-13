#!/usr/bin/env bash
# simplegraph-agentic auto-map generator
# Generates a structural map of the codebase using ctags.
#
# Usage:
#   bash scripts/auto_map.sh [PROJECT_DIR]
#   bash scripts/auto_map.sh --public-only [PROJECT_DIR]
#
# Output: core/auto_map.md (gitignored — generated artifact)
#
# Requires: Universal Ctags (https://ctags.io)
#   Install: sudo apt install universal-ctags  (Debian/Ubuntu)
#            brew install universal-ctags      (macOS)

set -euo pipefail

# ── parse args ────────────────────────────────────────────────────────────────
PUBLIC_ONLY=false
PROJECT_DIR=""

for arg in "$@"; do
  case "$arg" in
    --public-only) PUBLIC_ONLY=true ;;
    *) PROJECT_DIR="$arg" ;;
  esac
done

PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"

# Auto-detect graph directory or accept --output
if [ -d "${PROJECT_DIR}/core" ]; then
  OUTPUT_DIR="${PROJECT_DIR}/core"
elif [ -d "${PROJECT_DIR}/.agent/skills/memory" ]; then
  OUTPUT_DIR="${PROJECT_DIR}/.agent/skills/memory"
else
  OUTPUT_DIR="${PROJECT_DIR}"
fi
OUTPUT="${OUTPUT_DIR}/auto_map.md"

# ── verify deps ───────────────────────────────────────────────────────────────
if ! command -v ctags &>/dev/null; then
  echo "ERROR: ctags not found. Install Universal Ctags first."
  echo "  Debian/Ubuntu: sudo apt install universal-ctags"
  echo "  macOS:         brew install universal-ctags"
  exit 1
fi

# ── configure exclusions ──────────────────────────────────────────────────────
EXCLUDE_DIRS="node_modules,.git,dist,build,.next,__pycache__,venv,.venv,vendor,target,core,shared"

# ── generate tags ─────────────────────────────────────────────────────────────
TAGS_FILE=$(mktemp /tmp/sg_tags.XXXXXX)
trap 'rm -f "${TAGS_FILE}"' EXIT

CTAGS_OPTS=(
  --recurse
  --fields=+KnS
  --output-format=json
  --sort=no
)

# Add exclusions
IFS=',' read -ra DIRS <<< "$EXCLUDE_DIRS"
for dir in "${DIRS[@]}"; do
  CTAGS_OPTS+=(--exclude="${dir}")
done

# Public-only mode: restrict to exported/public symbols
if [ "$PUBLIC_ONLY" = true ]; then
  CTAGS_OPTS+=(
    --kinds-typescript=+cfiImMe-vlp
    --kinds-python=+cfCim-vl
    --kinds-javascript=+cfCm-vl
    --kinds-java=+cim-fl
    --kinds-go=+fitsmn-vrl
  )
fi

ctags "${CTAGS_OPTS[@]}" -o "${TAGS_FILE}" "${PROJECT_DIR}" 2>/dev/null || true

# ── parse tags into markdown ──────────────────────────────────────────────────
{
  echo "# Auto-generated Repository Map"
  echo "<!-- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) -->"
  echo "<!-- Do not edit manually. Regenerate with: bash scripts/auto_map.sh -->"
  if [ "$PUBLIC_ONLY" = true ]; then
    echo "<!-- Mode: public API surface only -->"
  fi
  echo ""

  if [ ! -s "${TAGS_FILE}" ]; then
    echo "> No symbols found. Ensure your project has source files ctags can parse."
    exit 0
  fi

  # Group by directory, then by file
  python3 -c "
import json, sys, os
from collections import defaultdict

project_dir = '${PROJECT_DIR}'.rstrip('/')
tags = []
with open('${TAGS_FILE}') as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('{'):
            try:
                tag = json.loads(line)
                if tag.get('_type') == 'tag':
                    tags.append(tag)
            except (json.JSONDecodeError, KeyError):
                pass

# Group by relative directory
by_dir = defaultdict(lambda: defaultdict(list))
for tag in tags:
    path = tag.get('path', '')
    if path.startswith(project_dir):
        path = path[len(project_dir)+1:]
    dirname = os.path.dirname(path) or '.'
    basename = os.path.basename(path)
    name = tag.get('name', '?')
    kind = tag.get('kind', '?')
    scope = tag.get('scope', None)
    sig = tag.get('signature', '')

    # Format the symbol
    if kind in ('class', 'interface', 'module', 'struct', 'type'):
        symbol = f'### {kind.title()}: \`{name}\` ({path})'
        by_dir[dirname][path].insert(0, ('heading', symbol))
    else:
        prefix = '  ' if scope else ''
        label = f'{prefix}- \`{name}{sig}\` ({kind})'
        by_dir[dirname][path].append(('symbol', label))

# Output
for dirname in sorted(by_dir.keys()):
    print(f'## {dirname}/')
    print()
    files = by_dir[dirname]
    for filepath in sorted(files.keys()):
        entries = files[filepath]
        has_heading = any(e[0] == 'heading' for e in entries)
        if not has_heading:
            print(f'### {os.path.basename(filepath)}')
        for entry_type, content in entries:
            print(content)
        print()
    print('---')
    print()
" 2>/dev/null || {
    echo "> auto_map generation requires Python 3 for JSON ctags parsing."
    echo "> Install Python 3 or use a ctags output format your environment supports."
  }

} > "${OUTPUT}"

echo "✓ Auto-map generated: ${OUTPUT}"
if [ "$PUBLIC_ONLY" = true ]; then
  echo "  Mode: public API surface only"
fi
LINES=$(wc -l < "${OUTPUT}")
echo "  ${LINES} lines"
