# Changelog

## [Unreleased]

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/karstom/simplegraph-agentic/main/install.sh | bash
```

- **`install.sh`.** Fetches simplegraph into `~/.simplegraph`, builds and wires
  the MCP server when Node 18+ is present, and hands off to `setup.sh`. A
  persistent home is required rather than incidental: `setup.sh` writes an
  `.mcp.json` pointing at `<home>/mcp/dist/index.js`, so a temp checkout would
  leave a dangling server path. Re-running the command upgrades in place.
  Degrades cleanly without Node — the markdown graph installs and MCP is
  skipped. `SIMPLEGRAPH_REPO_URL` points it at a fork.
- **`setup.sh` is scriptable.** `--tool`, `--dir`, `--mcp`/`--no-mcp`,
  `--multi-repo`, `--upgrade`/`--reinstall`, `--yes`. The AI tool is
  auto-detected from the project (`CLAUDE.md`, `.cursor/`, copilot
  instructions, `.zed/`, `AGENTS.md`) so the common case needs no flag.
  `--yes` can never trigger the destructive reinstall; that still requires an
  explicit flag or a typed confirmation.
- **Prompts survive a pipe.** Answers are read from stdin when stdin carries
  them, from `/dev/tty` when stdin is an exhausted script stream (the
  `curl … | bash` case), and default safely when there is no terminal at all.
  Getting this order wrong breaks one of the three in a way that hangs, so all
  three are covered by tests.

### Cross-platform

Verified on all three supported platforms:

| Platform | Notes |
|---|---|
| **macOS** | Test suite green under the **system `/bin/bash` 3.2**, not a Homebrew bash — so the bash 3.2 constraints this is written to are actually exercised, and the BSD `sed`/`date` paths are real. |
| **WSL2 (Ubuntu)** | Including projects on a Windows drive under `/mnt/c`. |
| **Ubuntu 24.04 VM** | Kernel 6.8, bash 5.2, git 2.43, Node 18.19, Universal Ctags 6.1 (snap), no npm. |

On the Ubuntu VM, from a clean clone: 42/42 adapter tests, 12/12 gate tests,
one-line install, exclusion flags, and symbol staleness all pass. Two paths
that had only been reasoned about were exercised for real — **Node present but
npm absent** (the MCP build is skipped and no `.mcp.json` is written, rather
than failing the install), and **Node at exactly the v18 minimum**.

Verified on WSL with the project on `/mnt/c`:

- The installer detects WSL from `/proc/version` and warns about CRLF when the
  project is on a Windows drive.
- Scripts execute from `drvfs`, which mounts without the `metadata` option, so
  Linux permission bits are absent and everything reads as `0777`.
- The graph's atomic writes (temp file + rename) and its cross-process advisory
  lock behave correctly on 9p/drvfs: eight concurrent `REGRESSED_N_TIMES`
  increments advanced the counter 1 → 9 with no lost updates, no torn file, and
  no stray temp or lock files. That is the multi-agent safety guarantee holding
  on a filesystem it had never been tested against.

- **bash 3.2 compatible** — no `mapfile`, associative arrays, or `${var,,}`,
  because that is what macOS ships as `/bin/bash`.
- **`auto_map.sh` now verifies it found Universal Ctags.** macOS ships a
  BSD/Xcode `ctags` that satisfies `command -v` but cannot emit JSON tags; it
  failed into `|| true` and the run ended with "No symbols found", which reads
  as "your project has no code" rather than "this is the wrong ctags".
Running against macOS is what surfaced two bash 3.2 bugs that bash 4.4+ hides
entirely: `token_benchmark.sh` and `auto_map.sh` both expanded a possibly-empty
array as `"${arr[@]}"`, which bash 3.2 treats as an unbound variable under
`set -u` and aborts on. Both now use the portable `${arr[@]+"${arr[@]}"}` guard.
The first macOS run also failed six tests that were entirely the harness —
`timeout` and `setsid` do not exist there — including one assertion that passed
for the wrong reason because a missing command still exits non-zero.

- **Root `.gitattributes` pins `eol=lf`.** Confirmed both halves on WSL: a
  CRLF copy of `setup.sh` fails with exactly `$'\r': command not found`
  followed by `set: pipefail: invalid option name`, and a fresh
  `git clone -c core.autocrlf=true` of this branch onto `/mnt/c` now checks out
  LF regardless, because `.gitattributes` overrides the client setting.

### Documentation

- **README rewritten as a landing page** — 409 lines to 149. It now opens with
  the tool catching a real six-recurrence regression, then the install command.
  Previously a reader met a token-efficiency table at line 17 and no install
  command until line 72.
- **Reference material moved to `docs/`** — seeding, graph format, maintenance,
  code graphs, and multi-agent, all linked from the README.

## [0.5.0] — 2026-08-26

### Blast-radius anchoring — compose with a structural code graph

simplegraph stores judgment, not structure: what regressed, what's forbidden, why
the code is the way it is. Structural code graphs (codebase-memory-mcp,
code-review-graph, Graphify, an LSP) store the opposite and can compute what an
edit touches. Neither answers the other's question, so this release adds the seam
between them rather than a second parser.

- **`simplegraph_check_files` accepts a blast radius.** Alongside `files`, it now
  takes `symbols`, `related_files`, and `related_symbols`. Fill the last two from
  whatever structural tool you already have; simplegraph reports which parts of
  that radius have a recorded history. Results are grouped — directly affected
  first, then blast radius — with a `Matched on:` line per node explaining why it
  fired, so widening the radius adds context instead of burying the file being
  edited. All arguments are optional and an unexpanded call behaves as before.
- **`**Symbols:**` node anchor.** Matches a function/class/method name, qualified
  or bare (`AuthService.refreshToken` ↔ `refreshToken`), anchored at a separator so
  `Foo.run` never collides with `Bar.run`. A path-only anchor breaks silently when
  a file is renamed; a symbol survives the move, and fires when a *caller* is
  edited — usually where the bug is actually reintroduced.
- **`**Paths:**` node anchor.** Directory containment, intended for Component
  nodes: `COMP_AUTH` owning `src/auth` fires for any file beneath it, including
  files that did not exist when the node was written. Segment-wise, so `src/auth`
  does not match `src/authz`, and an absolute path from an external tool still
  matches a repo-relative owned path.
- **`stale_check.sh` covers the new anchors.** Reports `Paths` that are no longer
  directories, and `Symbols` absent from `auto_map.md` — skipped entirely when no
  `auto_map.md` has been generated, rather than flagging every symbol.
### Configurable

- **Output budget.** `SIMPLEGRAPH_CHECK_DETAIL_LIMIT` (5),
  `SIMPLEGRAPH_CHECK_DIGEST_LIMIT` (20), `SIMPLEGRAPH_CHECK_DIGEST_CHARS` (180),
  and `SIMPLEGRAPH_EDGE_PREVIEW` (6) tune `check_files` output. Defaults are tuned
  against a 251-node graph; raise them on a small graph, lower them when many
  nodes match one edit. `0` is legal and pushes a group to its terser form — it
  never hides a node. A malformed value falls back to the default rather than
  collapsing to zero and suppressing safety output.
- **`auto_map.sh` exclusions.** `--exclude DIR` adds and `--include DIR` removes,
  both repeatable; `SIMPLEGRAPH_EXCLUDE_DIRS` / `SIMPLEGRAPH_EXCLUDE_PATTERNS`
  replace the default lists, with flags applied on top. The worktree defaults are
  a heuristic — a project with real source in a `worktrees/` directory recovers it
  with `--include worktrees`. Unknown options and missing flag values now exit 2
  instead of being silently read as the project path.

### Fixed — found by running against live repositories

Validated against four real repos, including a 251-node production graph built by
real usage over 718 commits.

- **Hand-written `**Files:**` lists were silently ignored.** The parser extracted
  only backtick-wrapped entries. On a real graph the single highest-value node — a
  regression that had recurred **six times**, with a full root-cause writeup —
  listed its ten files without backticks, so it parsed as having no anchors and
  never fired in `check_files`. It read as healthy in every listing while guarding
  nothing. List fields now fall back to a comma-separated split when the line
  carries no backticks. Audited across 615 real nodes / 1,605 anchors: zero
  spurious entries.
- **`check_files` could return more context than it saved.** A realistic two-file
  edit with a four-file blast radius returned 34 nodes as ~14,500 tokens — more
  than the project's entire per-task budget, on a tool whose premise is reading
  ~50 lines instead of 5,000. Full records are now reserved for the top-ranked
  direct hits; everything else is digested to one compact block, and inline edge
  lists are capped (one seeded Component spent ~1.4k tokens dumping 36 `CONTAINS`
  edges). The same query now costs ~4,900 tokens — 66% less, with every one of the
  34 nodes still represented and **nothing on the direct path hidden**.
- **`sg seed` left Component nodes unanchored.** The structure extractor derives a
  Component *from* a directory, then recorded only three sample files — which
  cannot represent a 275-file module. Seeded Components now carry `**Paths:**`, so
  directory ownership works out of the box. (`SEED_VERSION` → 0.4.0.)
- **`auto_map.sh` corrupted hidden-directory paths.** With a relative project dir
  (`auto_map.sh .`), the prefix strip turned `.claude/x/y.ts` into `laude/x/y.ts`,
  so no such entry could be matched back to a real file. The project directory is
  now resolved to an absolute path and the prefix is only stripped at a separator
  boundary.
- **`setup.sh` miscounted a pristine graph as populated.** A raw
  `grep -c '^## NODE:'` counted the template's commented-out examples, so a fresh
  install reported "7 node(s)" — directly above a destructive "wipe all graph
  data" option. Users were asked to protect data they did not have, and a real
  graph counted its examples too. Now uses the same fence/comment stripping as
  `consistency_check.sh`, so the installer and the gate agree, and an empty
  install says so plainly.
- **`auto_map.sh` indexed agent worktrees.** `.claude/worktrees/` holds complete
  duplicate checkouts: on a live repo they made up **47% of the generated map**
  (106,517 → 56,538 lines once excluded). Worse for the new symbol check, a stale
  worktree copy keeps a deleted symbol visible — masking exactly the drift
  `stale_check.sh` exists to find.

- **No migration.** Both fields are optional and are emitted only when populated,
  so a node with neither renders byte-identically to previous versions and every
  recorded `sg seed` content hash is unaffected. `simplegraph_update_node` inserts
  `Symbols` / `Paths` into nodes that predate the fields instead of refusing the
  write, so an existing graph can adopt anchoring node by node.

## [0.4.0] — 2026-07-22

### Multi-agent development safety

Hardens the graph for concurrent writers — parallel Claude Code sessions,
worktree-based subagents, or a team whose tools all write to the same graph.

- **Atomic writes.** Every graph write now goes through a temp-file-plus-rename,
  so a reader in another session can never observe a half-written node file.
- **Cross-process graph lock.** Read-modify-write tool calls
  (`simplegraph_update_node`, `simplegraph_add_node`, `simplegraph_archive_regression`,
  scratchpad append) now hold a single advisory lock per graph root for the whole
  operation. This closes the lost-update race where two sessions both read
  `REGRESSED_N_TIMES = N` and both write `N+1`, silently dropping a recurrence —
  the one signal the graph most needs to keep. Stale locks (crashed holder) are
  detected by timestamp and reclaimed; the lock is always released, including on
  error.
- **Derived, regenerable Quick Index.** `graph_index.md`'s Quick Index is now
  treated as a *view* of the node files, not a hand-appended list. A new
  `sg reindex` command and `simplegraph_reindex` tool rebuild it deterministically
  (IDs sorted, recurring regressions annotated `(×N)`), leaving the Task Routing
  section untouched. Because the output is order-independent, this is the intended
  way to resolve `graph_index.md` merge conflicts after parallel branches. Adding
  or archiving a node now regenerates the index automatically — the manual
  `simplegraph_update_index` step is no longer required (the tool remains, now an
  alias for reindex).
- **Author/Session attribution.** Nodes may carry `**Author:**` and `**Session:**`
  fields recording which agent/tool and session created them, so concurrent or
  conflicting writes can be told apart and arbitrated. `simplegraph_add_node`
  accepts `author`/`session` arguments and falls back to the `SIMPLEGRAPH_AUTHOR`
  and `SIMPLEGRAPH_SESSION` environment variables. Fields are optional and omitted
  when unset, so existing nodes and seeded output are unchanged.
- **Duplicate-ID detection.** `consistency_check.sh` now fails when the same node
  ID is defined more than once — the collision two agents (or two merged branches)
  can create without git ever raising a conflict.
- **Union-merged list files.** A shipped `core/.gitattributes` (and
  `shared/.gitattributes`) marks the append-only node files `merge=union`, so two
  branches that each appended a node merge cleanly instead of conflicting on every
  add. `graph_index.md` is deliberately excluded — regenerate it with `sg reindex`
  after a merge. `setup.sh` installs and refreshes these files.
- **Trust boundary for the shared graph.** The MCP server was already read-only
  against `shared/`, making promotion a deliberate human act; that control is now
  documented, and `consistency_check.sh` is shared-aware — it auto-detects a
  sibling `shared/` graph (or takes `--shared <dir>`), validates IDs and edges
  across both graphs (so cross-graph edges resolve instead of reading as broken),
  and warns when a shared node carries no attribution (`Author`/`Provenance`/
  `Seeded`) — an org-wide rule with no traceable source.

Propagation across branches follows your git workflow: a node reaches other
agents when its branch merges, so commit graph updates alongside the code and
land them promptly (documented in `core/HOW_TO_UPDATE.md`).

All additions are backward-compatible: the node format only grows optional
fields, `sg seed` output is byte-identical to 0.3.0, and the shared-graph checks
are inert when no `shared/` graph is present.

## [0.3.0] — 2026-07-20

### New: `sg seed` — bootstrap a graph from repository history

The mcp package now ships a second bin, `sg`, whose first command mines an
existing repository into a draft memory graph. Deterministic, offline, no API
key required (Tier 1); an LLM enrichment seam exists behind the same extractor
interface but is deliberately unimplemented this release.

- **Extractors:** reverts and repeated/annotated fix commits → Regressions;
  ADR/RFC docs, merge-commit bodies, deliberate-change commits → Decisions;
  emphatic rule comments and rule-shaped test names → Invariants; TODO-class
  comments and high-churn files → Watchlists; top-level structure → Components.
- **Edges:** component ownership (`CONTAINS`), revert pairs (`SUPERSEDED_BY`/
  `CAUSES`), shared issue references and co-change coupling (`RELATES_TO`).
  `SUPERSEDED_BY` and `RELATES_TO` are new documented edge types.
- **Provenance:** every seeded node carries `**Provenance:**` (source commits /
  file locations) and `**Seeded:**` (extractor, confidence, content hash).
  Both fields round-trip through the parser and MCP tools.
- **Review gate:** nothing is written without an interactive confirm (`--yes`
  for scripts); `--dry-run` mines and summarizes only. Quality controls:
  `--min-confidence` floor, `--max-per-type` caps, near-duplicate collapsing.
- **Idempotent:** stable content-derived node IDs; re-runs at the same commit
  are no-ops, re-runs after new commits add only what's new, and hand-edited
  seeded nodes are never overwritten (conflicts are reported).

### Fixed

- Importing `mcp/src/index.ts` for its exported handlers (as the tests do) no
  longer attaches the MCP server to stdio — previously `node --test` never
  exited. The server now starts only when `index.js` is the entry module.

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
