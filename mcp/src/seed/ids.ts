// sg seed — stable, content-derived node IDs and content hashing.
//
// IDs must be deterministic across runs (idempotency) and survive cosmetic
// changes like a TODO moving between files (dedupe). Format:
//   <PREFIX>_<SLUG>_<4-hex of stable key>
// The hex suffix disambiguates same-slug nodes without sacrificing stability.

import { createHash } from "crypto";

export const TYPE_PREFIX: Record<string, string> = {
  Regression: "REG",
  Decision: "DEC",
  Invariant: "INV",
  Watchlist: "WATCH",
  Component: "", // components use the bare name, matching AUTH_SERVICE-style IDs
};

export function slugify(text: string, maxWords = 5): string {
  const words = text
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    // Drop conventional-commit noise words that add no identity.
    .filter(w => !["FIX", "FIXED", "FIXES", "FEAT", "CHORE", "THE", "A", "AN", "OF", "TO", "IN", "FOR", "AND"].includes(w))
    .slice(0, maxWords);
  return words.join("_") || "UNNAMED";
}

export function shortHash(key: string, len = 4): string {
  return createHash("sha1").update(key).digest("hex").slice(0, len).toUpperCase();
}

/**
 * Build a node ID. `stableKey` should identify the *source* (commit SHA,
 * normalized comment text, dir path) — not the rendered node content, so
 * heuristic tweaks to summaries don't change identity.
 */
export function makeNodeId(type: string, labelSource: string, stableKey: string): string {
  const prefix = TYPE_PREFIX[type] ?? "NODE";
  const slug = slugify(labelSource);
  const suffix = shortHash(stableKey);
  return prefix ? `${prefix}_${slug}_${suffix}` : `${slug}_${suffix}`;
}

/**
 * Hash a node's rendered markdown block for hand-edit detection. The
 * **Seeded:** line is excluded (it contains this hash) and whitespace is
 * normalized so formatting-only churn doesn't read as a user edit.
 */
export function contentHash(nodeBlock: string): string {
  let canonical = nodeBlock
    .split("\n")
    .filter(l => !l.startsWith("**Seeded:**"))
    .map(l => l.trimEnd())
    .join("\n")
    .trim();
  // A parsed node's rawContent keeps the trailing `---` separator when another
  // node follows it; a freshly rendered block has none. Strip so they compare.
  canonical = canonical.replace(/\n-{3,}$/, "").trim();
  return createHash("sha1").update(canonical).digest("hex").slice(0, 8);
}

/** Normalize free text for dedupe keys: lowercase, collapse space, strip punct. */
export function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
