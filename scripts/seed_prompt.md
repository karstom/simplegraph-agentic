# Seed Prompt — Bootstrap Your Memory Graph

Use this prompt once (in any AI coding tool) to populate the graph from a cold start.
Copy it, fill in the bracketed values, and paste it into your AI assistant.

---

## Prompt Template

```
I want you to bootstrap a simplegraph-agentic memory graph for this codebase.

First, read `core/HOW_TO_UPDATE.md` to understand the exact node format and edge vocabulary.
Then scan this repository and produce the following, written directly into the `core/` files:

1. **Component nodes** (`core/components/{NAME}.md`) — one file per major service, module,
   or subsystem. Use a short UPPER_SNAKE_CASE Node ID (e.g., AUTH_SERVICE, API_GATEWAY).
   Focus on components where the AI is most likely to make mistakes.

2. **Invariant nodes** (`core/invariants.md`) — hard rules you can infer from:
   - Prominent comments (e.g., "DO NOT", "NEVER", "ALWAYS")
   - Configuration that would silently break things if changed
   - Non-obvious framework or environment constraints

3. **Decision nodes** (`core/decisions.md`) — intentional architectural choices visible in
   the code that have non-obvious rationale (e.g., why a specific library was chosen,
   why a particular pattern is used everywhere).

4. **Update `core/graph_index.md`** — fill in the Quick Index and Task Routing table with
   the actual node IDs and file areas for this project.

Quality bar: 3–5 high-signal nodes per type is better than 20 shallow ones.
Don't invent nodes — only record things you can see evidence of in the code.
Follow the node format from HOW_TO_UPDATE.md exactly.
```

---

## After Seeding

Once the graph is bootstrapped:

- **Review** the generated nodes for accuracy — the AI may hallucinate rationale.
- **Commit** the populated `core/` directory to version control.
- The graph improves automatically as you fix bugs and make decisions. See `HOW_TO_UPDATE.md`.

---

## Tips

- Run the seed prompt **after** the codebase has meaningful structure — not on a blank project.
- For large codebases, scope it: *"Focus only on the authentication and API layers."*
- Re-seed after a major refactor to catch stale nodes.
