#!/usr/bin/env bash
# Tests for consistency_check.sh.
# Builds synthetic graph roots and asserts the gate reports the right result.
# The point of these tests is that the gate must never silently pass: a
# toolchain that cannot run the extraction has to fail loudly (exit 2), and a
# genuinely broken graph has to fail (exit 1).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$REPO_ROOT/scripts/consistency_check.sh"
PASS=0
FAIL=0

# Build a temp repo laid out as <tmp>/core/{graph_index.md,scripts/} and drop
# the gate in at core/scripts/ so its CORE_DIR auto-detection resolves there.
make_graph() {
  local dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/sg_cctest.XXXXXX")
  mkdir -p "$dir/core/scripts"
  cp "$GATE" "$dir/core/scripts/consistency_check.sh"
  printf '# Graph Index\n' > "$dir/core/graph_index.md"
  cat > "$dir/core/regressions.md"
  echo "$dir"
}

expect() {
  local name="$1" want="$2" dir="$3"
  local out rc=0
  out=$(bash "$dir/core/scripts/consistency_check.sh" 2>&1) || rc=$?
  if [ "$rc" -eq "$want" ]; then
    PASS=$((PASS + 1)); printf '  ok   %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL %s (want exit %s, got %s)\n%s\n' "$name" "$want" "$rc" "$(echo "$out" | sed 's/^/       /')"
  fi
  rm -rf "$dir"
}

echo "consistency_check.sh"

expect "clean graph passes" 0 "$(make_graph <<'G'
## NODE: REG_ALPHA
**Edges:**
- VIOLATED_BY → INV_BETA

---

## NODE: INV_BETA
**Edges:** _(none)_
G
)"

# The regression that motivated widening the ID class to [A-Z][A-Z0-9_]*:
# with the old [A-Z_]+ pattern both sides truncated at the first digit, so
# INV_AUTH_2B "resolved" against the unrelated node INV_AUTH_9Z.
expect "broken edge with digits in ID is caught" 1 "$(make_graph <<'G'
## NODE: INV_AUTH_9Z
**Edges:**
- CAUSED_BY → INV_AUTH_2B
G
)"

expect "edge to a digit-bearing node that exists passes" 0 "$(make_graph <<'G'
## NODE: INV_AUTH_9Z
**Edges:**
- CAUSED_BY → REG_TOKEN_LEAK_1F3A

---

## NODE: REG_TOKEN_LEAK_1F3A
**Edges:** _(none)_
G
)"

expect "duplicate node ID is caught" 1 "$(make_graph <<'G'
## NODE: REG_DUPE
**Edges:** _(none)_

---

## NODE: REG_DUPE
**Edges:** _(none)_
G
)"

# Distinct IDs sharing a prefix that the old [A-Z_]+ pattern collapsed into
# one token must NOT be reported as duplicates.
expect "distinct IDs sharing a prefix are not false dupes" 0 "$(make_graph <<'G'
## NODE: REG_TOKEN_LEAK_1F3A
**Edges:** _(none)_

---

## NODE: REG_TOKEN_LEAK_2B4C
**Edges:** _(none)_
G
)"

expect "templates in code fences are ignored" 0 "$(make_graph <<'G'
Docs for the node format:

```markdown
## NODE: YOUR_NODE_ID
**Edges:**
- EDGE_TYPE → OTHER_NODE_ID: explanation
```
G
)"

expect "examples in HTML comments are ignored" 0 "$(make_graph <<'G'
<!-- EXAMPLE:

## NODE: REG_EXAMPLE
**Edges:**
- VIOLATED_BY → INV_EXAMPLE

-->
G
)"

# A broken graph must still fail even when a fenced template sits next to it.
expect "real broken edge beside a fenced template still fails" 1 "$(make_graph <<'G'
```markdown
## NODE: YOUR_NODE_ID
**Edges:**
- EDGE_TYPE → OTHER_NODE_ID
```

## NODE: REG_REAL
**Edges:**
- DEPENDS_ON → INV_MISSING
G
)"

# Simulate the macOS failure mode: a grep with no -E/-P support must make the
# gate exit 2, not print a green checkmark after checking nothing.
BROKENDIR=$(mktemp -d "${TMPDIR:-/tmp}/sg_ccbadgrep.XXXXXX")
cat > "$BROKENDIR/grep" <<'G'
#!/bin/sh
echo "grep: invalid option -- 'E'" >&2
exit 2
G
chmod +x "$BROKENDIR/grep"
g=$(make_graph <<'G'
## NODE: REG_ALPHA
**Edges:** _(none)_
G
)
rc=0
out=$(PATH="$BROKENDIR:$PATH" bash "$g/core/scripts/consistency_check.sh" 2>&1) || rc=$?
if [ "$rc" -eq 2 ]; then
  PASS=$((PASS + 1)); echo "  ok   unusable grep fails loudly instead of passing"
else
  FAIL=$((FAIL + 1))
  printf '  FAIL unusable grep fails loudly (want exit 2, got %s)\n%s\n' "$rc" "$out"
fi
rm -rf "$BROKENDIR" "$g"


# ── shared/ graph (upstream feature) ──────────────────────────────────────────

# Edges must resolve across core/ + shared/, and duplicate IDs must be caught
# across both graphs — with the full ID class, not a digit-truncated stem.
make_shared_graph() {
  local dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/sg_cctest.XXXXXX")
  mkdir -p "$dir/core/scripts" "$dir/shared"
  cp "$GATE" "$dir/core/scripts/consistency_check.sh"
  printf '# Graph Index\n' > "$dir/core/graph_index.md"
  cat > "$dir/core/regressions.md"
  echo "$dir"
}

d=$(make_shared_graph <<'G'
## NODE: REG_LOCAL_1A2B
**Edges:**
- DEPENDS_ON → INV_ORG_3C4D
G
)
printf '## NODE: INV_ORG_3C4D\n**Author:** alice\n**Edges:** _(none)_\n' > "$d/shared/invariants.md"
expect "core -> shared edge resolves across graphs" 0 "$d"

d=$(make_shared_graph <<'G'
## NODE: REG_LOCAL_1A2B
**Edges:**
- DEPENDS_ON → INV_ORG_9Z9Z
G
)
printf '## NODE: INV_ORG_3C4D\n**Author:** alice\n**Edges:** _(none)_\n' > "$d/shared/invariants.md"
expect "core -> shared edge to a missing node fails" 1 "$d"

d=$(make_shared_graph <<'G'
## NODE: INV_ORG_3C4D
**Edges:** _(none)_
G
)
printf '## NODE: INV_ORG_3C4D\n**Author:** alice\n**Edges:** _(none)_\n' > "$d/shared/invariants.md"
expect "duplicate ID across core/ and shared/ is caught" 1 "$d"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
