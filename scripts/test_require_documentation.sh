#!/usr/bin/env bash
# Tests for require_documentation.sh (the "document before you finish" Stop hook).
# Builds throwaway git repos with a graph and asserts the hook blocks only when
# a HIGH-priority file was edited with nothing recorded — and always fails open.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$REPO_ROOT/scripts/require_documentation.sh"
PASS=0
FAIL=0

git_q() { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}" >/dev/null 2>&1; }

# A repo with core/regressions.md holding one HIGH node that points at
# src/auth.ts, committed as the baseline so later edits show up as changes.
make_repo() {
  local dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/sg_hooktest.XXXXXX")
  git_q "$dir" init -b main
  mkdir -p "$dir/core/components" "$dir/src"
  cat > "$dir/core/regressions.md" <<'G'
## NODE: REG_TOKEN_LEAK
**Type:** Regression
**Priority:** HIGH
**Label:** Token leak
**Summary:** Tokens leaked across sessions.
**Tags:** _(none)_
**Edges:** _(none)_
**Files:** `src/auth.ts`
**LastUpdated:** 2026-01-01
G
  printf 'export const login = 1;\n' > "$dir/src/auth.ts"
  printf 'export const cache = 1;\n' > "$dir/src/cache.ts"
  git_q "$dir" add -A
  git_q "$dir" commit -m baseline
  echo "$dir"
}

# run <name> <want: block|allow> <stdin-json> <env...> -- edits happen via a
# callback function name passed as the last arg (given the repo dir).
run() {
  local name="$1" want="$2" json="$3" edit_fn="$4"
  local dir out
  dir=$(make_repo)
  "$edit_fn" "$dir"
  out=$(CLAUDE_PROJECT_DIR="$dir" bash "$HOOK" <<<"$json" 2>/dev/null)
  local got="allow"
  case "$out" in *'"decision":"block"'*) got="block" ;; esac
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); printf '  ok   %s\n' "$name"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL %s (want %s, got %s)\n       out: %s\n' "$name" "$want" "$got" "$out"
  fi
  rm -rf "$dir"
}

edit_risky()        { printf 'export const login = 2;\n' > "$1/src/auth.ts"; }        # touch HIGH file
edit_safe()         { printf 'export const cache = 2;\n' > "$1/src/cache.ts"; }         # non-HIGH file
edit_documented()   { edit_risky "$1"; printf '\n\n---\n\n## NODE: DEC_X\n**Type:** Decision\n**Priority:** LOW\n**Label:** d\n**Summary:** recorded.\n**Files:** _(none)_\n**LastUpdated:** 2026-02-02\n' >> "$1/core/decisions.md"; }
edit_scratch_only() { edit_risky "$1"; printf 'note\n' > "$1/core/.scratchpad.md"; }   # scratchpad doesn't count
noop()              { :; }

echo "require_documentation.sh"

run "risky edit, nothing recorded -> block"        block '{}' edit_risky
run "risky edit + node recorded -> allow"          allow '{}' edit_documented
run "risky edit, only scratchpad -> block"         block '{}' edit_scratch_only
run "non-HIGH file edited -> allow"                allow '{}' edit_safe
run "no changes at all -> allow"                   allow '{}' noop
run "stop_hook_active guard -> allow"              allow '{"stop_hook_active":true}' edit_risky

# Escape hatch: env var set at hook-run time must allow even a risky edit.
dir=$(make_repo); edit_risky "$dir"
out=$(CLAUDE_PROJECT_DIR="$dir" SIMPLEGRAPH_SKIP_DOC_HOOK=1 bash "$HOOK" <<<'{}' 2>/dev/null)
case "$out" in *'"decision":"block"'*) FAIL=$((FAIL+1)); printf '  FAIL escape hatch env -> allow (got block)\n' ;;
               *) PASS=$((PASS+1)); printf '  ok   escape hatch env -> allow\n' ;; esac
rm -rf "$dir"

# Fail-open: a non-git directory must never block.
dir=$(mktemp -d "${TMPDIR:-/tmp}/sg_nogit.XXXXXX"); mkdir -p "$dir/core"
out=$(CLAUDE_PROJECT_DIR="$dir" bash "$HOOK" <<<'{}' 2>/dev/null)
case "$out" in *'"decision":"block"'*) FAIL=$((FAIL+1)); printf '  FAIL non-git tree -> allow (got block)\n' ;;
               *) PASS=$((PASS+1)); printf '  ok   non-git tree -> allow\n' ;; esac
rm -rf "$dir"

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
