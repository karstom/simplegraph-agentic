// sg seed — draft bundle assembly: run extractors, apply quality controls
// (confidence floor, per-type caps, cross-extractor dedupe), infer edges,
// and produce the reviewable DraftBundle. Deterministic: same repo state +
// same options → byte-identical bundle.

import type { DraftBundle, DraftNode, ExtractorContext, Extractor, NodeType, SeedOptions } from "./types.js";
import { SEED_VERSION } from "./types.js";
import { normalizeForDedupe } from "./ids.js";
import { regressionExtractor, decisionExtractor } from "./extractors/history.js";
import { invariantExtractor, watchlistExtractor, componentExtractor } from "./extractors/worktree.js";
import { inferEdges } from "./edges.js";

export const EXTRACTORS: Extractor[] = [
  componentExtractor,   // components first — edge inference anchors on them
  regressionExtractor,
  decisionExtractor,
  invariantExtractor,
  watchlistExtractor,
];

export function assembleBundle(ctx: ExtractorContext, opts: SeedOptions): DraftBundle {
  const wanted = new Set<NodeType>(opts.types);
  let drafts: DraftNode[] = [];
  for (const ex of EXTRACTORS) {
    if (!ex.produces.some(t => wanted.has(t))) continue;
    drafts.push(...ex.extract(ctx).filter(d => wanted.has(d.type)));
  }

  // ── Cross-extractor dedupe by normalized label within a type ──
  const seen = new Map<string, DraftNode>();
  let deduped = 0;
  for (const d of drafts) {
    const key = `${d.type}:${normalizeForDedupe(d.label)}`;
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, d);
    } else {
      deduped++;
      if (d.confidence > prior.confidence) seen.set(key, d);
    }
  }
  drafts = [...seen.values()];

  // ── Confidence floor ──
  const floored = drafts.filter(d => d.confidence >= opts.minConfidence);
  const belowConfidence = drafts.length - floored.length;

  // ── Per-type caps: keep highest-confidence, then most recent, then by ID ──
  const byType = new Map<NodeType, DraftNode[]>();
  for (const d of floored) {
    if (!byType.has(d.type)) byType.set(d.type, []);
    byType.get(d.type)!.push(d);
  }
  let overCap = 0;
  const kept: DraftNode[] = [];
  for (const [, group] of byType) {
    group.sort((a, b) =>
      b.confidence - a.confidence ||
      (a.lastUpdated < b.lastUpdated ? 1 : a.lastUpdated > b.lastUpdated ? -1 : 0) ||
      (a.id < b.id ? -1 : 1)
    );
    overCap += Math.max(0, group.length - opts.maxPerType);
    kept.push(...group.slice(0, opts.maxPerType));
  }

  // ── Edge inference over the surviving set — no dangling targets possible ──
  inferEdges(kept, ctx);

  // ── Deterministic output order: type, then confidence desc, then ID ──
  const typeOrder = ["Component", "Regression", "Decision", "Invariant", "Watchlist"];
  kept.sort((a, b) =>
    typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type) ||
    b.confidence - a.confidence ||
    (a.id < b.id ? -1 : 1)
  );

  return {
    seedVersion: SEED_VERSION,
    repoRoot: ctx.repoRoot,
    headSha: ctx.headSha,
    headDate: ctx.headDate,
    options: {
      since: opts.since,
      minConfidence: opts.minConfidence,
      maxPerType: opts.maxPerType,
      types: opts.types,
    },
    nodes: kept,
    dropped: { belowConfidence, overCap, deduped },
  };
}
