#!/usr/bin/env bash
# Wire the "document before you finish" Stop hook into a project's
# .claude/settings.json. Idempotent: re-running is a no-op if already wired.
#
# Usage: bash scripts/install_doc_hook.sh [TARGET_DIR]   (default: cwd)

set -euo pipefail

TARGET="${1:-$(pwd)}"
SETTINGS="${TARGET}/.claude/settings.json"
HOOK_REL='core/scripts/require_documentation.sh'
# $CLAUDE_PROJECT_DIR is expanded by Claude Code at hook-run time, so the hook
# works regardless of the cwd the agent is launched from.
HOOK_CMD='bash "$CLAUDE_PROJECT_DIR"/'"${HOOK_REL}"

if [ ! -f "${TARGET}/${HOOK_REL}" ]; then
  echo "! Hook script not found at ${TARGET}/${HOOK_REL}"
  echo "  Run setup.sh first (it copies the maintenance scripts into core/scripts/)."
  exit 1
fi

mkdir -p "${TARGET}/.claude"

if command -v python3 >/dev/null 2>&1; then
  RESULT=$(python3 - "$SETTINGS" "$HOOK_CMD" <<'PY'
import json, sys
path, cmd = sys.argv[1], sys.argv[2]
try:
    with open(path) as f: cfg = json.load(f)
    if not isinstance(cfg, dict): cfg = {}
except (FileNotFoundError, ValueError):
    cfg = {}

stop = cfg.setdefault("hooks", {}).setdefault("Stop", [])

# Idempotent: bail if any Stop hook already runs our script.
already = any(
    "require_documentation.sh" in h.get("command", "")
    for group in stop if isinstance(group, dict)
    for h in group.get("hooks", []) if isinstance(h, dict)
)
if already:
    print("already-wired"); sys.exit(0)

stop.append({"hooks": [{"type": "command", "command": cmd}]})
with open(path, "w") as f:
    json.dump(cfg, f, indent=2); f.write("\n")
print("wired")
PY
)
  case "$RESULT" in
    wired)         echo "✓ Stop hook wired into ${SETTINGS}" ;;
    already-wired) echo "✓ Stop hook already present in ${SETTINGS} — no change." ;;
    *)             echo "! Could not wire the hook — check ${SETTINGS}"; exit 1 ;;
  esac
else
  echo "! python3 not found — add this block to ${SETTINGS} manually:"
  cat <<EOF

  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "${HOOK_CMD}" } ] }
    ]
  }
EOF
fi
