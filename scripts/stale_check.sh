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

SHOW_ALL=false
CORE_DIR_ARG=""
MAX_AGE_DAYS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --all) SHOW_ALL=true; shift ;;
    *)
      if [ -z "$CORE_DIR_ARG" ]; then
        CORE_DIR_ARG="$1"
      elif [ -z "$MAX_AGE_DAYS" ]; then
        MAX_AGE_DAYS="$1"
      fi
      shift ;;
  esac
done

# Auto-detect core directory (mirrors consistency_check.sh logic)
if [ -n "$CORE_DIR_ARG" ]; then
  CORE_DIR="$CORE_DIR_ARG"
else
  if [ "$(basename "$(dirname "$SCRIPT_DIR")")" = "core" ]; then
    CORE_DIR="$(dirname "$SCRIPT_DIR")"
  elif [ -d "$(dirname "$SCRIPT_DIR")/core" ]; then
    CORE_DIR="$(dirname "$SCRIPT_DIR")/core"
  else
    CORE_DIR="$(pwd)/core"
  fi
fi
MAX_AGE_DAYS="${MAX_AGE_DAYS:-90}"
PROJECT_DIR="$(dirname "${CORE_DIR}")"
FOUND_STALE=false

if [ ! -d "${CORE_DIR}" ]; then
  echo "ERROR: core/ directory not found at ${CORE_DIR}"
  exit 1
fi

# Delegate to the cross-platform TypeScript implementation if node and dist/ are built.
MCP_CLI="${PROJECT_DIR}/mcp/dist/seed/cli.js"
if [ -f "$MCP_CLI" ] && command -v node >/dev/null 2>&1; then
  ALL_FLAG=""
  [ "$SHOW_ALL" = true ] && ALL_FLAG="--all"
  exec node "$MCP_CLI" stale "$PROJECT_DIR" --graph "$CORE_DIR" --days "${MAX_AGE_DAYS}" $ALL_FLAG
fi

echo "Stale check: MAX_AGE_DAYS=${MAX_AGE_DAYS}, CORE_DIR=${CORE_DIR}"
if [ "$SHOW_ALL" = false ]; then
  echo "Showing HIGH-priority nodes only. Use --all to inspect MEDIUM and LOW nodes."
fi
echo ""

# ── check 1: old LastUpdated dates ────────────────────────────────────────────
CUTOFF_DATE=$(date -u -d "${MAX_AGE_DAYS} days ago" +%Y-%m-%d 2>/dev/null || \
              date -u -v-${MAX_AGE_DAYS}d +%Y-%m-%d 2>/dev/null || \
              echo "")

if [ -n "${CUTOFF_DATE}" ]; then
  echo "── Nodes older than ${MAX_AGE_DAYS} days (before ${CUTOFF_DATE}) ──"
  STALE_DATES=$(find "${CORE_DIR}" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' -not -path '*/archive/*' -not -path '*/generated/*' | sort | while IFS= read -r mdfile; do
    strip_noise "$mdfile" | awk -v cutoff="${CUTOFF_DATE}" -v fname="$(basename "$mdfile")" -v show_all="${SHOW_ALL}" '
      match($0, /^##[[:space:]]*NODE:[[:space:]]*[A-Z][A-Z0-9_]*/) {
        line = $0
        sub(/\r$/, "", line)
        sub(/^##[[:space:]]*NODE:[[:space:]]*/, "", line)
        sub(/[[:space:]].*$/, "", line)
        node = line
        priority = "UNSET"
        next
      }
      /^\*\*Priority:\*\*/ {
        line = $0
        sub(/\r$/, "", line)
        sub(/^\*\*Priority:\*\*[[:space:]]*/, "", line)
        priority = line
        next
      }
      /^\*\*LastUpdated:\*\*/ {
        if (show_all == "false" && toupper(priority) != "HIGH") next
        if (match($0, /[0-9]{4}-[0-9]{2}-[0-9]{2}/)) {
          d = substr($0, RSTART, RLENGTH)
          if (d < cutoff) printf "  ⏳ %s [%s] — unmodified since %s (> %sd) — in %s\n", (node == "" ? "unknown" : node), priority, d, cutoff, fname
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

DEAD_REFS=$(find "${CORE_DIR}" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' -not -path '*/archive/*' -not -path '*/generated/*' | sort | while IFS= read -r mdfile; do
  strip_noise "$mdfile" \
    | awk -v show_all="${SHOW_ALL}" '
        match($0, /^##[[:space:]]*NODE:[[:space:]]*[A-Z][A-Z0-9_]*/) {
          line = $0
          sub(/\r$/, "", line)
          sub(/^##[[:space:]]*NODE:[[:space:]]*/, "", line)
          sub(/[[:space:]].*$/, "", line)
          node = line
          priority = "UNSET"
          next
        }
        /^\*\*Priority:\*\*/ {
          line = $0
          sub(/\r$/, "", line)
          sub(/^\*\*Priority:\*\*[[:space:]]*/, "", line)
          priority = line
          next
        }
        /^\*\*Files:\*\*/ {
          if (show_all == "false" && toupper(priority) != "HIGH") next
          if (node != "") printf "%s\t%s\t%s\n", node, priority, $0
        }
      ' \
    | while IFS="$(printf '\t')" read -r node priority fileline; do
        [ -n "$node" ] || continue
        echo "$fileline" | grep -Eo '`[^`]+`' | tr -d '`' | while IFS= read -r ref; do
          [ -n "$ref" ] || continue
          FULL_PATH="${PROJECT_DIR}/${ref}"
          if [ ! -e "${FULL_PATH}" ]; then
            echo "  💀 ${node} [${priority}] — missing file: ${ref} — in $(basename "$mdfile")"
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
echo "── Nodes owning paths that no longer exist ──"

DEAD_PATHS=$(find "${CORE_DIR}" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' -not -path '*/archive/*' -not -path '*/generated/*' | sort | while IFS= read -r mdfile; do
  strip_noise "$mdfile" \
    | awk -v show_all="${SHOW_ALL}" '
        match($0, /^##[[:space:]]*NODE:[[:space:]]*[A-Z][A-Z0-9_]*/) {
          line = $0
          sub(/\r$/, "", line)
          sub(/^##[[:space:]]*NODE:[[:space:]]*/, "", line)
          sub(/[[:space:]].*$/, "", line)
          node = line
          priority = "UNSET"
          next
        }
        /^\*\*Priority:\*\*/ {
          line = $0
          sub(/\r$/, "", line)
          sub(/^\*\*Priority:\*\*[[:space:]]*/, "", line)
          priority = line
          next
        }
        /^\*\*Paths:\*\*/ {
          if (show_all == "false" && toupper(priority) != "HIGH") next
          if (node != "") printf "%s\t%s\t%s\n", node, priority, $0
        }
      ' \
    | while IFS="$(printf '\t')" read -r node priority pathline; do
        [ -n "$node" ] || continue
        echo "$pathline" | grep -Eo '`[^`]+`' | tr -d '`' | while IFS= read -r ref; do
          [ -n "$ref" ] || continue
          if [ ! -d "${PROJECT_DIR}/${ref}" ]; then
            echo "  💀 ${node} [${priority}] — missing directory: ${ref}/ — in $(basename "$mdfile")"
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
echo "── Nodes anchored to symbols not found in auto_map.md ──"

AUTO_MAP="${CORE_DIR}/generated/auto_map.md"
[ -f "${AUTO_MAP}" ] || AUTO_MAP="${CORE_DIR}/auto_map.md"

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
  MISSING_SYMS=$(find "${CORE_DIR}" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' -not -path '*/archive/*' -not -path '*/generated/*' | sort | while IFS= read -r mdfile; do
    strip_noise "$mdfile" \
      | awk -v show_all="${SHOW_ALL}" '
          match($0, /^##[[:space:]]*NODE:[[:space:]]*[A-Z][A-Z0-9_]*/) {
            line = $0
            sub(/\r$/, "", line)
            sub(/^##[[:space:]]*NODE:[[:space:]]*/, "", line)
            sub(/[[:space:]].*$/, "", line)
            node = line
            priority = "UNSET"
            next
          }
          /^\*\*Priority:\*\*/ {
            line = $0
            sub(/\r$/, "", line)
            sub(/^\*\*Priority:\*\*[[:space:]]*/, "", line)
            priority = line
            next
          }
          /^\*\*Symbols:\*\*/ {
            if (show_all == "false" && toupper(priority) != "HIGH") next
            if (node != "") printf "%s\t%s\t%s\n", node, priority, $0
          }
        ' \
      | while IFS="$(printf '\t')" read -r node priority symline; do
          [ -n "$node" ] || continue
          echo "$symline" | grep -Eo '`[^`]+`' | tr -d '`' | while IFS= read -r ref; do
            [ -n "$ref" ] || continue
            TAIL="${ref##*.}"
            TAIL="${TAIL##*::}"
            TAIL="${TAIL##*#}"
            if ! grep -qF "\`${TAIL}" "${AUTO_MAP}"; then
              echo "  ❓ ${node} [${priority}] — unmapped symbol: ${ref} — in $(basename "$mdfile")"
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

# ── check 5: code churn on anchored files since write commit ─────────────────
echo "── Nodes whose anchored files have changed since write commit ──"
if command -v git >/dev/null 2>&1 && git -C "${PROJECT_DIR}" rev-parse --git-dir >/dev/null 2>&1; then
  CHURN_REFS=$(find "${CORE_DIR}" -name '*.md' -not -name 'auto_map.md' -not -name '.scratchpad.md' -not -path '*/archive/*' -not -path '*/generated/*' | sort | while IFS= read -r mdfile; do
    strip_noise "$mdfile" \
      | awk -v show_all="${SHOW_ALL}" '
          match($0, /^##[[:space:]]*NODE:[[:space:]]*[A-Z][A-Z0-9_]*/) {
            line = $0
            sub(/\r$/, "", line)
            sub(/^##[[:space:]]*NODE:[[:space:]]*/, "", line)
            sub(/[[:space:]].*$/, "", line)
            node = line
            priority = "UNSET"
            commit = ""
            files = ""
            next
          }
          /^\*\*Priority:\*\*/ {
            line = $0
            sub(/\r$/, "", line)
            sub(/^\*\*Priority:\*\*[[:space:]]*/, "", line)
            priority = line
            next
          }
          /^\*\*Commit:\*\*/ {
            line = $0
            sub(/\r$/, "", line)
            sub(/^\*\*Commit:\*\*[[:space:]]*/, "", line)
            commit = line
            next
          }
          /^\*\*Files:\*\*/ {
            line = $0
            sub(/\r$/, "", line)
            sub(/^\*\*Files:\*\*[[:space:]]*/, "", line)
            files = line
            next
          }
          /^(##[[:space:]]*NODE:|$)/ {
            if (node != "" && commit != "" && files != "" && files !~ /_\(none\)_/) {
              if (show_all == "true" || toupper(priority) == "HIGH") {
                printf "%s\t%s\t%s\t%s\n", node, priority, commit, files
              }
            }
            node = ""
          }
        ' \
      | while IFS="$(printf '\t')" read -r node priority commit fileline; do
          [ -n "$node" ] || continue
          FILE_ARGS=""
          for ref in $(echo "$fileline" | grep -Eo '`[^`]+`' | tr -d '`'); do
            [ -n "$ref" ] && FILE_ARGS="${FILE_ARGS} ${ref}"
          done
          if [ -n "$FILE_ARGS" ]; then
            DIST=$(git -C "${PROJECT_DIR}" rev-list --count "${commit}..HEAD" -- ${FILE_ARGS} 2>/dev/null || echo 0)
            if [ "$DIST" -gt 0 ] 2>/dev/null; then
              echo "  ⏳ ${node} [${priority}] — code under node changed ${DIST} time(s) since write at ${commit} — in $(basename "$mdfile")"
            fi
          fi
        done
  done)

  if [ -n "${CHURN_REFS}" ]; then
    echo "${CHURN_REFS}"
    FOUND_STALE=true
  else
    echo "  ✓ No code churn detected under anchored nodes."
  fi
else
  echo "  — Skipped: not a git repository or git not available."
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
