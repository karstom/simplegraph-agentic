# Changelog

## [0.2.0] — 2026-06-04

### Breaking change — Recurrence Root-Cause Gate

`simplegraph_update_node` with `field:"REGRESSED_N_TIMES"` and `value:"increment"` now
**blocks the increment** when the resulting value would be ≥ 2 (second recurrence and beyond),
unless a non-empty `root_cause` argument is supplied.

**Existing callers that never reach a second recurrence are completely unaffected.**
Callers that do reach threshold will receive a structured blocking message (not an exception)
explaining the three-question gate. The counter will not change until `root_cause` is provided.

This is intentional and the intended effect: the graph was recording recurrences faithfully
but the counter only annotated — it never changed behavior. A regression that recurs a second
time has already received at least one symptomatic fix, and another symptomatic fix will
produce recurrence 3. The gate forces the root-cause analysis to happen before the next patch
is recorded.

### What callers need to do

When `REGRESSED_N_TIMES` would reach 2 or more, answer all three questions and pass them as
`root_cause`:

1. **Source of truth** — what is the authoritative source for the state this regression
   corrupts, and why isn't the code reading it directly?
2. **Violated invariant** — which rule is being broken? Add an Invariant node if none exists.
3. **Why prior fixes were symptomatic** — what did each prior fix treat instead of the root cause?

Once supplied, `root_cause` is written to the node as `**RootCause:** <text>` (persisted after
`**REGRESSED_N_TIMES:**`) and round-trips through `simplegraph_get_node` and `simplegraph_nodes`.

### New `root_cause` parameter

- `simplegraph_update_node` — optional parameter; required only when incrementing to ≥ 2.
- `simplegraph_add_node` — optional parameter; required when creating a Regression node with
  `regressedNTimes ≥ 2` (re-importing history).

### Template updates

- `core/HOW_TO_UPDATE.md` — added **Recurrence Root-Cause Gate** section with the three
  required answers and the Nth-stamp smell heuristic.
- `core/anti_patterns.md` — added **Debugging / Recurring-Bug Anti-Patterns** section banning
  Nth-stamp fixes, belt-and-suspenders compensating guards, and uncleared gate patches.
- `adapters/claude-code/CLAUDE_MEMORY.md` — updated `REGRESSED_N_TIMES ≥ 2` line from advisory
  to procedural; updated "Bug recurred" action row to reference the gate.

## [0.1.0] — initial release
