#!/usr/bin/env bash
# simplegraph-agentic auto-map generator
# Generates a structural map of the codebase using ctags.
#
# Usage:
#   bash core/scripts/auto_map.sh [PROJECT_DIR]
#   bash core/scripts/auto_map.sh --public-only [PROJECT_DIR]
#   bash core/scripts/auto_map.sh --include worktrees        # map a dir excluded by default
#   bash core/scripts/auto_map.sh --exclude fixtures         # skip an extra dir
#
# Exclusions:
#   Defaults skip dependency, build, and duplicate-checkout directories.
#   Agent worktrees (.claude/, worktrees/) are skipped because they are complete
#   second copies of the source: they double the map and keep deleted symbols
#   visible, which hides the drift stale_check.sh looks for. If your project has
#   real source in a directory of that name, un-skip it with --include.
#
#     --exclude DIR        add DIR to the skip list (repeatable)
#     --include DIR        remove DIR from the skip list (repeatable)
#     SIMPLEGRAPH_EXCLUDE_DIRS      comma-separated list; REPLACES the defaults
#     SIMPLEGRAPH_EXCLUDE_PATTERNS  space-separated globs; REPLACES the defaults
#
#   Flags apply on top of whichever list is in effect, so
#   `SIMPLEGRAPH_EXCLUDE_DIRS=node_modules,.git ./auto_map.sh --exclude tmp`
#   skips exactly those three.
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
ADD_EXCLUDES=""
DROP_EXCLUDES=""

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --public-only) PUBLIC_ONLY=true; shift ;;
    --exclude)
      [ $# -ge 2 ] || { echo "ERROR: --exclude needs a directory name" >&2; exit 2; }
      ADD_EXCLUDES="${ADD_EXCLUDES}${ADD_EXCLUDES:+,}$2"; shift 2 ;;
    --include)
      [ $# -ge 2 ] || { echo "ERROR: --include needs a directory name" >&2; exit 2; }
      DROP_EXCLUDES="${DROP_EXCLUDES}${DROP_EXCLUDES:+,}$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    -*) echo "ERROR: unknown option: $1" >&2; usage 2 ;;
    *) PROJECT_DIR="$1"; shift ;;
  esac
done

PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"
# Resolve to an absolute path. With a relative PROJECT_DIR of ".", the prefix
# strip below turned ".claude/x/y.ts" into "laude/x/y.ts" — every hidden-directory
# path in the map came out corrupted, and the entry could never be matched back
# to a real file.
if [ -d "${PROJECT_DIR}" ]; then
  PROJECT_DIR="$(cd "${PROJECT_DIR}" && pwd)"
else
  echo "ERROR: project directory not found: ${PROJECT_DIR}" >&2
  exit 1
fi

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
if ! command -v ctags >/dev/null 2>&1; then
  echo "ERROR: ctags not found. Install Universal Ctags first." >&2
  echo "  Debian/Ubuntu: sudo apt install universal-ctags" >&2
  echo "  macOS:         brew install universal-ctags" >&2
  echo "  Fedora/RHEL:   sudo dnf install ctags" >&2
  exit 1
fi

# macOS ships a BSD/Xcode `ctags` that answers `command -v` but does not support
# --output-format=json. Left unchecked it exits non-zero into `|| true`, and the
# run ends with "No symbols found" — which reads as "your project has no code"
# rather than "this is the wrong ctags". Name the actual problem instead.
if ! ctags --version 2>/dev/null | grep -qi "universal ctags"; then
  echo "ERROR: found '$(command -v ctags)', but it is not Universal Ctags." >&2
  echo "       macOS ships a BSD/Xcode ctags that cannot emit JSON tags." >&2
  echo "  macOS: brew install universal-ctags" >&2
  echo "         (then ensure its bin directory precedes /usr/bin in PATH)" >&2
  echo "  Check: ctags --version   # should say 'Universal Ctags'" >&2
  exit 1
fi

# ── configure exclusions ──────────────────────────────────────────────────────
# .claude/.worktrees hold complete duplicate checkouts: indexing them doubles the
# map and, worse, keeps a deleted symbol visible via the stale copy — which would
# hide exactly the drift stale_check.sh looks for. Override with --include if a
# directory of that name holds real source in your project.
DEFAULT_EXCLUDE_DIRS="node_modules,.git,dist,build,.next,__pycache__,venv,.venv,vendor,target,core,shared,.cache,.claude,worktrees,.worktrees"
DEFAULT_EXCLUDE_PATTERNS="*.parquet *.log *.trace *.json.lock"

EXCLUDE_DIRS="${SIMPLEGRAPH_EXCLUDE_DIRS:-$DEFAULT_EXCLUDE_DIRS}"
EXCLUDE_PATTERNS="${SIMPLEGRAPH_EXCLUDE_PATTERNS:-$DEFAULT_EXCLUDE_PATTERNS}"

# --exclude appends; --include removes. Applied after the env override so the
# flags always win, and exact-match only so --include core cannot also drop
# .cache.
[ -n "${ADD_EXCLUDES}" ] && EXCLUDE_DIRS="${EXCLUDE_DIRS},${ADD_EXCLUDES}"
if [ -n "${DROP_EXCLUDES}" ]; then
  KEPT=""
  IFS=',' read -ra _cur <<< "${EXCLUDE_DIRS}"
  for d in "${_cur[@]}"; do
    [ -n "$d" ] || continue
    drop=false
    IFS=',' read -ra _drop <<< "${DROP_EXCLUDES}"
    for x in "${_drop[@]}"; do [ "$d" = "$x" ] && drop=true && break; done
    [ "$drop" = true ] || KEPT="${KEPT}${KEPT:+,}$d"
  done
  EXCLUDE_DIRS="${KEPT}"
fi

# ── generate tags ─────────────────────────────────────────────────────────────
# Use a tempfile path but DELETE it before writing — ctags refuses to overwrite
# an existing empty file when --output-format=json is set. We use -f - (stdout)
# and redirect to the tempfile ourselves instead.
TAGS_FILE=$(mktemp -u /tmp/sg_tags.XXXXXX)  # -u: generate name only, don't create
trap 'rm -f "${TAGS_FILE}"' EXIT

CTAGS_OPTS=(
  --recurse
  --fields=+KnS
  --output-format=json
  --sort=no
  -f -
)

# Add directory exclusions
IFS=',' read -ra DIRS <<< "$EXCLUDE_DIRS"
for dir in "${DIRS[@]}"; do
  CTAGS_OPTS+=(--exclude="${dir}")
done

# Add file pattern exclusions (binary/data files that cause hangs)
for pat in $EXCLUDE_PATTERNS; do
  CTAGS_OPTS+=(--exclude="${pat}")
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

ctags "${CTAGS_OPTS[@]}" "${PROJECT_DIR}" 2>/dev/null > "${TAGS_FILE}" || true

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
    echo "> No symbols found."
    echo ">"
    # "Your project has no parseable code" is almost never the real cause. The
    # common one on Ubuntu is the snap build of universal-ctags: it is confined,
    # so it cannot read /tmp at all and refuses a top-level ~/.dotdir, failing
    # with "cannot open input file" into the `|| true` above. Name it here
    # rather than blaming the project.
    if command -v ctags >/dev/null 2>&1 && case "$(command -v ctags)" in /snap/*) true ;; *) false ;; esac; then
      echo "> ctags is the snap build ($(command -v ctags)), which is sandboxed:"
      echo ">   • it cannot read /tmp at all"
      echo ">   • it cannot read a top-level dot-directory such as ~/.cache"
      echo "> Your project is at: ${PROJECT_DIR}"
      echo "> If that path is affected, either move the project under \$HOME or"
      echo "> install an unconfined build:  sudo apt install universal-ctags"
    else
      echo "> Check that ${PROJECT_DIR} contains source files in a language ctags"
      echo "> parses, and that they are not all excluded. Current skip list:"
      echo ">   ${EXCLUDE_DIRS}"
      echo "> Use --include DIR to un-skip one."
    fi
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
    # Match on a separator boundary so a sibling that merely shares the prefix
    # (project '/a/b' vs path '/a/bc/d.ts') is never truncated.
    if path.startswith(project_dir + os.sep):
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
