# Component Nodes

Add one file per major service, module, or subsystem in your project.

**Naming:** `components/{YOUR_COMPONENT_NAME}.md` — use UPPER_SNAKE_CASE for the node ID.

**Template:**

```markdown
## NODE: YOUR_COMPONENT_NAME
**Type:** Component
**Label:** Human-readable component name
**Summary:** What this component does, why it exists, and what an AI would get wrong
without this context. Keep to 2–4 sentences.
**Edges:**
- DEPENDS_ON → OTHER_NODE_ID: why this component needs the other
**Files:** `src/path/to/main-file.ts`, `src/path/to/other.ts`
**Symbols:** `MainClass`, `MainClass.entryPoint`
**Paths:** `src/path/to`
**LastUpdated:** YYYY-MM-DD
```

`**Paths:**` is what makes a Component node earn its place: it claims a directory,
so `simplegraph_check_files` fires this node for *any* file beneath it — including
files that did not exist when you wrote the node. Keep it to a directory, not a
file, and let `**Files:**` name the specific entry points.

Focus on components where the AI is most likely to introduce bugs:
- Services with non-obvious side effects
- Modules with strict initialization order
- Components that have regressed before

3–5 well-scoped components beat 20 shallow ones.
