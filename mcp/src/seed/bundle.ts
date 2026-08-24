// sg seed — draft bundle assembly: run extractors, apply quality controls
// (confidence floor, per-type caps, cross-extractor dedupe), infer edges,
// and produce the reviewable DraftBundle. Deterministic: same repo state +
// same options → byte-identical bundle.

import type { DraftBundle, DraftNode, ExtractorContext, Extractor, NodeType, SeedOptions } from "./types.js";
import { SEED_VERSION } from "./types.js";
import { normalizeForDedupe, slugify } from "./ids.js";
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

  // ── Churn/repeat-fix overlap ──
  // The Watchlist "high churn" and Regression "repeatedly fixed" extractors read
  // the same commit-frequency signal, so a fix-prone file produced one of each.
  // The Regression node strictly dominates: it carries the fix commits and a
  // REGRESSED_N_TIMES count, where the Watchlist only reports a total.
  const repeatFixFiles = new Set(
    drafts.filter(d => d.type === "Regression" && d.tags.includes("repeat-fix")).flatMap(d => d.files)
  );
  const beforeOverlap = drafts.length;
  drafts = drafts.filter(
    d => !(d.type === "Watchlist" && d.tags.includes("churn") && d.files.some(f => repeatFixFiles.has(f)))
  );
  deduped += beforeOverlap - drafts.length;

  // ── Same-slug siblings ──
  // Two extractors can phrase one rule differently ("...is NEVER touched" from a
  // comment, "...is never overwritten" from a test) and escape the label dedupe
  // above while still slugifying to the same ID stem. They are linked rather
  // than merged: same stem is weaker evidence than same label, and dropping one
  // would discard a distinct source. The edge makes the overlap reviewable and
  // leaves both IDs — and their provenance — intact.
  const bySlug = new Map<string, DraftNode[]>();
  for (const d of drafts) {
    const key = `${d.type}:${slugify(d.label)}`;
    if (!bySlug.has(key)) bySlug.set(key, []);
    bySlug.get(key)!.push(d);
  }
  for (const group of bySlug.values()) {
    if (group.length < 2) continue;
    for (const d of group) {
      for (const other of group) {
        if (other.id === d.id) continue;
        d.edges.push({
          edgeType: "RELATES_TO",
          target: other.id,
          explanation: "same rule stem, mined from a different source — review whether these are one node",
        });
      }
    }
  }

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
