# Anti-Patterns

> Things the AI should **never** generate for this project. These prevent wasted
> correction cycles — the AI gets it right on the first attempt instead of
> generating wrong code that must be reviewed and rejected.
>
> These are different from Invariants:
> - **Invariants** = rules about how the code must behave at runtime
> - **Anti-patterns** = rules about what the AI should never write

---

<!-- Add your anti-patterns below. Use clear, imperative language. -->

## Debugging / Recurring-Bug Anti-Patterns

- **NEVER add the Nth place to set, preserve, or re-stamp the same derived flag** when `REGRESSED_N_TIMES ≥ 2`. More than ~2 write sites for a single derived value means the code should read the source of truth directly instead of maintaining a mirror. Each new write site is a future recurrence.

- **NEVER add belt-and-suspenders compensating guards** (a second unreliable check OR-ed in to paper over a first one you don't trust). If you don't trust check A, fix A — don't add check B to catch A's failures. Two unreliable checks in series fail in more ways than one reliable check.

- **NEVER fix a recurring regression without clearing the Root-Cause Gate** (`REGRESSED_N_TIMES ≥ 2`). Same-class patches (another guard, stamp, or preserve site for the same derived value) are banned until the three-question gate in `HOW_TO_UPDATE.md` is answered and the `root_cause` field is written to the node.

<!-- EXAMPLES (delete these when you add real entries):

## Coding Anti-Patterns
- NEVER use `any` type in TypeScript — always use explicit types or `unknown`
- NEVER use string concatenation for SQL — always use parameterized queries
- NEVER import from internal paths of a package (e.g., `lib/internal/utils`) — use the public API only

## Testing Anti-Patterns
- NEVER generate mock data inline — always use the test fixture factory in `tests/fixtures/`
- NEVER skip error case tests — every function that can throw must have a failure test

## Architecture Anti-Patterns
- NEVER add direct database calls outside the data layer (`src/data/`)
- NEVER put business logic in API route handlers — delegate to service classes

-->
