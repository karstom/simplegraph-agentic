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

# Node IDs are UPPER_SNAKE_CASE and MAY CONTAIN DIGITS (e.g. REG_TOKEN_LEAK_1F3A).
# Must stay in sync with parser.ts (/^## NODE:\s*([A-Z][A-Z0-9_]*)/) and with
# seed/ids.ts, which mints IDs with a 4-hex-char suffix. A narrower class such as
# [A-Z_]+ truncates every hashed ID at its first digit, which makes BOTH checks
# below unsound: distinct IDs collapse into false duplicates, and a genuinely
# broken edge can "resolve" against an unrelated node sharing the truncated stem.
ID_CLASS='[A-Z][A-Z0-9_]*'
NODE_RE="^##[[:space:]]*NODE:[[:space:]]*${ID_CLASS}"
EDGE_RE="→[[:space:]]*${ID_CLASS}"
STRIP_NODE_PREFIX='s/^##[[:space:]]*NODE:[[:space:]]*//'
STRIP_EDGE_PREFIX='s/^→[[:space:]]*//'

# Portability: POSIX grep -E / sed / awk only. `grep -P` is absent from BSD/macOS
# grep, so on a stock Mac every -P call here failed; because each was written as
# `... 2>/dev/null || true`, the failure was swallowed and the checks silently
# compared two empty sets — printing "all valid" while verifying nothing.
grep_or_die() {
  local pattern="$1" file="$2" out rc=0
  out=$(grep -Eo "$pattern" "$file") || rc=$?
  if [ "$rc" -ge 2 ]; then
    echo "ERROR: grep -Eo failed (exit $rc) for pattern: $pattern" >&2
    echo "       The consistency check cannot run reliably on this system." >&2
    exit 2
  fi
  printf '%s' "$out"
}

# Prove the extraction pipeline works before trusting a clean result from it.
# Without this, any toolchain problem is indistinguishable from a healthy graph.
canary() {
  local fixture ids edges
  fixture=$(mktemp "${TMPDIR:-/tmp}/sg_canary.XXXXXX")
  printf '## NODE: REG_CANARY_1F3A\n**Edges:**\n- CAUSED_BY → INV_CANARY_2B\n' > "$fixture"
  ids=$(grep_or_die "$NODE_RE" "$fixture" | sed -E "$STRIP_NODE_PREFIX")
  edges=$(grep_or_die "$EDGE_RE" "$fixture" | sed -E "$STRIP_EDGE_PREFIX")
  rm -f "$fixture"
  if [ "$ids" != "REG_CANARY_1F3A" ] || [ "$edges" != "INV_CANARY_2B" ]; then
    echo "ERROR: consistency check self-test failed — ID extraction is broken." >&2
    echo "       expected node id 'REG_CANARY_1F3A', got '$ids'" >&2
    echo "       expected edge target 'INV_CANARY_2B', got '$edges'" >&2
    echo "       Refusing to report a result that would be meaningless." >&2
    exit 2
  fi
}
canary

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

# Strip fenced code blocks (format templates such as "## NODE: YOUR_NODE_ID")
# and HTML comments (commented-out examples) from each hand-authored .md file in
# a graph dir, appending to the given output file. Excludes generated/gitignored
# files. Uses POSIX awk rather than perl, and runs once per file so fence and
# comment state never leak across files.
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

strip_graph() {
  local dir="$1" out="$2"
  : > "${out}"
  [ -d "$dir" ] || return 0
  while IFS= read -r f; do
    case "$(basename "$f")" in
      auto_map.md|.scratchpad.md) continue ;;
    esac
    strip_noise "$f" >> "${out}"
  done < <(find "$dir" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' | sort)
}

strip_graph "${CORE_DIR}" "${CORE_STRIPPED}"
strip_graph "${SHARED_DIR}" "${SHARED_STRIPPED}"
cat "${CORE_STRIPPED}" "${SHARED_STRIPPED}" > "${ALL_STRIPPED}"

# Node IDs and edge targets span both graphs, so cross-graph edges
# (core → shared, shared → core) resolve instead of reading as broken.
grep_or_die "$EDGE_RE" "${ALL_STRIPPED}" | sed -E "$STRIP_EDGE_PREFIX" | sort -u > "${EDGE_TARGETS}"
grep_or_die "$NODE_RE" "${ALL_STRIPPED}" | sed -E "$STRIP_NODE_PREFIX" | sort   > "${NODE_IDS}"

STATUS=0
[ -n "$SHARED_DIR" ] && echo "Checking core/ + shared/ ($SHARED_DIR)" || echo "Checking core/"

# 1. Duplicate node IDs (across both graphs). Two agents or two merged branches
#    can independently mint the same ID; git merges the files with no conflict.
DUPES=$(uniq -d < "${NODE_IDS}")
if [ -n "$DUPES" ]; then
  echo "✗ Duplicate node IDs found (same ID defined more than once):"
  echo "$DUPES"
  echo "  Rename one, or merge the two definitions into a single NODE block, then re-run 'sg reindex'."
  STATUS=1
fi

# 2. Broken edge references (targets with no matching NODE in either graph).
UNIQUE_IDS=$(mktemp "${TMPDIR:-/tmp}/sg_uniq_ids.XXXXXX")
sort -u < "${NODE_IDS}" > "${UNIQUE_IDS}"
BROKEN=$(comm -23 "${EDGE_TARGETS}" "${UNIQUE_IDS}")
rm -f "${UNIQUE_IDS}"
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
  NODE_COUNT=$(grep -c . "${NODE_IDS}" || true)
  EDGE_COUNT=$(grep -c . "${EDGE_TARGETS}" || true)
  echo "✓ ${NODE_COUNT} node(s), ${EDGE_COUNT} distinct edge target(s): all references resolve, all IDs unique."
fi
exit "$STATUS"
