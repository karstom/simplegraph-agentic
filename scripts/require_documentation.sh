#!/usr/bin/env bash
# simplegraph-agentic — "document before you finish" Stop hook.
#
# Runs as a Claude Code `Stop` hook. When the agent tries to end a task that
# changed files a HIGH-priority graph node points at (a known regression or
# danger zone) WITHOUT recording anything in the graph, it blocks once and
# tells the agent to capture the change as a node. This is the "force capture"
# the CI gate can't do: CI checks that the graph is internally valid, this
# checks that new knowledge was actually written down.
#
# Design (deliberate):
#   • Nudge once, never trap. The `stop_hook_active` guard lets the very next
#     stop through, so the agent is reminded exactly once per task — CI remains
#     the backstop for anything it ignores.
#   • Fail OPEN. Any error, missing tool, or non-git tree exits 0 (allow). A
#     documentation reminder must never wedge someone's session.
#   • Scoped to HIGH-priority nodes only, so it fires on genuine danger zones,
#     not every edit — over-firing just trains agents to write junk nodes.
#
# Wire it in .claude/settings.json (install_doc_hook.sh does this for you):
#   "hooks": { "Stop": [ { "hooks": [ { "type": "command",
#     "command": "bash \"$CLAUDE_PROJECT_DIR\"/core/scripts/require_documentation.sh" } ] } ] }
#
# Escape hatch: set SIMPLEGRAPH_SKIP_DOC_HOOK=1 to disable entirely.

set -uo pipefail   # NOT -e: we handle every failure and fall through to allow.

allow() { exit 0; }   # allow the stop (fail-open default)

block() {
  # Emit the Stop-hook block decision. `reason` is fed back to the agent.
  # Keep it single-line JSON; escape only what our content can contain.
  local reason="$1"
  reason=${reason//\\/\\\\}
  reason=${reason//\"/\\\"}
  reason=${reason//$'\n'/\\n}
  printf '{"decision":"block","reason":"%s"}\n' "$reason"
  exit 0
}

[ -n "${SIMPLEGRAPH_SKIP_DOC_HOOK:-}" ] && allow

INPUT=$(cat 2>/dev/null || true)

# Avoid loops / over-forcing: if we are already inside a stop-hook continuation,
# let the agent finish. This makes the reminder fire at most once per task.
case "$INPUT" in
  *'"stop_hook_active"'*'true'*) allow ;;
esac

# Locate the repo and the graph. Prefer the values Claude Code / the MCP set.
ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
ROOT=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null) || allow
CORE="${SIMPLEGRAPH_ROOT:-$ROOT/core}"
[ -d "$CORE" ] || allow
COREREL=$(realpath --relative-to="$ROOT" "$CORE" 2>/dev/null || echo "core")

# Delegate to the cross-platform TypeScript implementation if node and dist/ are built.
MCP_CLI="${ROOT}/mcp/dist/seed/cli.js"
if [ -f "$MCP_CLI" ] && command -v node >/dev/null 2>&1; then
  printf '%s' "$INPUT" | exec node "$MCP_CLI" hook require-doc --repo "$ROOT" --graph "$CORE"
fi

# What changed in this task: tracked edits vs HEAD, plus new untracked files.
CHANGED=$(
  { git -C "$ROOT" diff --name-only HEAD 2>/dev/null
    git -C "$ROOT" ls-files --others --exclude-standard 2>/dev/null
  } | sort -u
)
[ -n "$CHANGED" ] || allow

# Did the agent touch the graph? Any change under core/ that is not a generated
# / gitignored artifact counts as "documented".
DOCUMENTED=$(
  printf '%s\n' "$CHANGED" \
    | grep -E "^${COREREL}/" 2>/dev/null \
    | grep -vE "^${COREREL}/(archive|generated)/" \
    | grep -vE "/(auto_map\.md|\.scratchpad\.md|\.seed_(draft|state)\.json)$" 2>/dev/null \
    || true
)
[ -n "$DOCUMENTED" ] && allow   # something was recorded — good enough for v1.

# Files that HIGH-priority nodes point at, as "path<TAB>NODE_ID" pairs.
HIGH_FILES=$(
  awk '
    /^##[[:space:]]*NODE:/ { id=$0; sub(/^##[[:space:]]*NODE:[[:space:]]*/,"",id); prio="" }
    /^\*\*Priority:\*\*/   { prio=$2 }
    /^\*\*Files:\*\*/ {
      if (prio=="HIGH") {
        line=$0
        while (match(line, /`[^`]+`/)) {
          f=substr(line, RSTART+1, RLENGTH-2)
          print f "\t" id
          line=substr(line, RSTART+RLENGTH)
        }
      }
    }
  ' "$CORE"/*.md "$CORE"/components/*.md 2>/dev/null
)
[ -n "$HIGH_FILES" ] || allow   # no danger zones defined — nothing to enforce.

# Reconcile: any changed file that a HIGH node references (substring match in
# either direction, mirroring simplegraph_check_files) is an undocumented
# risky edit. Collect "path (NODE_ID)" for the message.
RISKY=""
while IFS=$'\t' read -r hpath hid; do
  [ -n "$hpath" ] || continue
  hl=$(printf '%s' "$hpath" | tr '[:upper:]' '[:lower:]' | tr '\\' '/')
  while IFS= read -r cf; do
    [ -n "$cf" ] || continue
    cl=$(printf '%s' "$cf" | tr '[:upper:]' '[:lower:]' | tr '\\' '/')
    if case "$cl" in *"$hl"*) true ;; *) case "$hl" in *"$cl"*) true ;; *) false ;; esac ;; esac; then
      RISKY="${RISKY}  • ${cf} (${hid})"$'\n'
      break
    fi
  done <<EOF
$CHANGED
EOF
done <<EOF
$HIGH_FILES
EOF

[ -n "$RISKY" ] || allow

block "Before finishing: this task changed files a HIGH-priority graph node flags, but nothing was recorded in the graph.

Undocumented risky edits:
${RISKY}
Capture what happened before you stop:
  • Fixed a bug in one of these? Add or update a Regression node (simplegraph_add_node / simplegraph_update_node).
  • Made a deliberate design choice? Add a Decision node.
  • Learned this area is riskier than the node says? Update its Watchlist/Summary.
If there is genuinely nothing worth recording, say so and stop again — this reminder fires only once."
