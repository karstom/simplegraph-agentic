# Seeding a graph from your repo's history

How `sg seed` mines regressions, decisions, and invariants out of git — deterministically, offline, with no API key.

[← back to the README](../README.md)

---

## `sg seed` — bootstrap the graph from your repo's history

A new graph doesn't have to start empty. Everything it wants to store is already
latent in your repository: reverted and repeatedly-fixed files are regressions,
merge bodies and ADRs are decisions, emphatic comments and rule-shaped test names
are invariants, TODO/FIXME markers and high-churn files are watchlists, and your
directory structure is the component map. `sg seed` mines all of it —
**deterministically, offline, no API key** — into a draft you review before
anything is written.

```bash
cd mcp && npm install && npm run build && npm link   # installs the `sg` bin
cd /path/to/your/project
sg seed --dry-run     # mine and summarize, write nothing
sg seed               # mine, review the summary, confirm the merge
```

```
sg seed [PATH]
  --dry-run              mine and summarize, write nothing
  --since <ref|date>     history window (default: last 500 commits)
  --min-confidence <n>   drop draft nodes below threshold (default 0.5)
  --types <list>         restrict to given node types
  --max-per-type <n>     cap per type (default 15)
  --output <path>        write the draft bundle here
  --yes                  skip the interactive confirm
```

Every seeded node carries **provenance** (the commits and file locations it was
mined from) plus a confidence score, so you can audit — and delete — anything
that reads as noise. Re-running is safe: output is idempotent at the same
commit, re-runs after new commits add only what's new, and a seeded node you've
hand-edited is never overwritten (the conflict is reported instead). See the
"Seeded nodes" section of `core/HOW_TO_UPDATE.md`.

`scripts/seed_prompt.md` remains the LLM-assisted alternative: richer summaries,
but non-deterministic and model-dependent. `sg seed` is the reproducible baseline.

---
