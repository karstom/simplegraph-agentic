// sg seed — Tier 2 enrichment seam (interface only in this release).
//
// Tier 1 (deterministic extractors) must stand alone: no API key, offline,
// reproducible. Tier 2 improves *wording* — summarizing a commit body into a
// crisp Decision statement, or inferring the invariant a test actually pins —
// without changing which nodes exist. An enricher may rewrite label/summary/
// tags and adjust confidence, but must not mint or delete nodes, so
// provenance and stable IDs are unaffected.

import type { DraftNode } from "./types.js";

export interface Enricher {
  name: string;
  /** Rewrite presentation fields of a draft. Must return the same node ID. */
  enrich(node: DraftNode): Promise<DraftNode>;
}

/** Tier 1 default: pass-through. Keeps the pipeline shape identical. */
export const noopEnricher: Enricher = {
  name: "noop",
  async enrich(node: DraftNode): Promise<DraftNode> {
    return node;
  },
};

/**
 * Tier 2 stub. A future implementation calls a model with the node's
 * provenance (commit bodies, test source, comment context) and rewrites the
 * summary. Deliberately unimplemented: `sg seed` must never require a key.
 */
export function createLlmEnricher(): Enricher {
  return {
    name: "llm",
    async enrich(): Promise<DraftNode> {
      throw new Error(
        "LLM enrichment is not implemented yet. Run without --enrich (Tier 1 " +
        "deterministic extraction is the supported path), or use " +
        "scripts/seed_prompt.md for interactive LLM-based seeding."
      );
    },
  };
}
