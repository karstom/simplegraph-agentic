// sg seed — working-tree extractors: Invariant, Watchlist, Component nodes.
// Deterministic Tier 1: comment conventions, test names, directory structure.

import * as path from "path";
import type { DraftNode, Extractor, ExtractorContext } from "../types.js";
import { makeNodeId, normalizeForDedupe, slugify, shortHash } from "../ids.js";

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|sql|tf|ex|exs|scala|vue|svelte)$/;
const TEST_FILE = /(\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|exs)$|(^|\/)tests?\/)/;
const COMMENT_LINE = /^\s*(\/\/|#|\*|\/\*|--|<!--)\s?(.*)$/;

function truncate(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1).trimEnd() + "…";
}

interface CommentHit { file: string; line: number; text: string }

/** Scan code files for comment lines matching a pattern. Skips markdown. */
function scanComments(ctx: ExtractorContext, match: RegExp): CommentHit[] {
  const hits: CommentHit[] = [];
  for (const f of ctx.worktreeFiles) {
    if (!CODE_EXT.test(f)) continue;
    const content = ctx.readFile(f);
    if (!content) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(COMMENT_LINE);
      if (!m) continue;
      const text = m[2].replace(/\*\/\s*$|-->\s*$/, "").trim();
      if (match.test(text)) hits.push({ file: f, line: i + 1, text });
    }
  }
  return hits;
}

/** Dedupe hits by normalized text — a comment moved across files is one node. */
function groupByText(hits: CommentHit[]): Map<string, CommentHit[]> {
  const groups = new Map<string, CommentHit[]>();
  for (const h of hits) {
    const key = normalizeForDedupe(h.text);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(h);
  }
  return groups;
}

const INVARIANT_COMMENT = /\b(MUST NOT|MUST|NEVER|ALWAYS|DO NOT|INVARIANT)\b/;
const TEST_NAME = /\b(?:test|it)\s*\(\s*["'`](.{10,140}?)["'`]/g;
const INVARIANT_TEST_NAME = /\b(never|always|must|only|cannot|can't|should ?not|shouldn't|reject\w*|refus\w*|block\w*|requir\w*|forbid\w*|denie[sd]|deny|prevent\w*|survives?)\b/i;

export const invariantExtractor: Extractor = {
  name: "invariant-worktree",
  version: "1",
  produces: ["Invariant"],
  extract(ctx: ExtractorContext): DraftNode[] {
    const drafts: DraftNode[] = [];

    // ── Emphatic rule comments (uppercase — the author shouted on purpose) ──
    for (const [key, hits] of [...groupByText(scanComments(ctx, INVARIANT_COMMENT)).entries()].sort()) {
      const h = hits[0];
      // Skip TODO-class lines; those are watchlist material.
      if (/^\s*(TODO|FIXME|HACK|XXX)\b/i.test(h.text)) continue;
      drafts.push({
        id: makeNodeId("Invariant", h.text, key),
        type: "Invariant",
        label: truncate(h.text, 80),
        summary: truncate(
          `Rule asserted in code comments: "${h.text}" ` +
          `(${hits.length} occurrence${hits.length > 1 ? "s" : ""}, e.g. ${h.file}:${h.line}).`,
          400
        ),
        tags: ["seeded", "comment-rule"],
        files: [...new Set(hits.map(x => x.file))].slice(0, 4),
        edges: [],
        confidence: 0.7,
        lastUpdated: ctx.headDate,
        provenance: {
          commits: [],
          locations: hits.slice(0, 4).map(x => `${x.file}:${x.line}`),
          extractor: "invariant-worktree",
          extractorVersion: "1",
        },
      });
    }

    // ── Behavioral test names phrased as rules ──
    const testHits: CommentHit[] = [];
    for (const f of ctx.worktreeFiles) {
      if (!TEST_FILE.test(f) || !CODE_EXT.test(f)) continue;
      const content = ctx.readFile(f);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const m of lines[i].matchAll(TEST_NAME)) {
          if (INVARIANT_TEST_NAME.test(m[1])) testHits.push({ file: f, line: i + 1, text: m[1] });
        }
      }
    }
    for (const [key, hits] of [...groupByText(testHits).entries()].sort()) {
      const h = hits[0];
      drafts.push({
        id: makeNodeId("Invariant", h.text, key),
        type: "Invariant",
        label: truncate(h.text, 80),
        summary: truncate(
          `Behavior pinned by test: "${h.text}" (${h.file}:${h.line}). ` +
          `The test suite treats this as a rule; breaking it is a regression, not a refactor.`,
          400
        ),
        tags: ["seeded", "test-invariant"],
        files: [...new Set(hits.map(x => x.file))].slice(0, 4),
        edges: [],
        confidence: 0.55,
        lastUpdated: ctx.headDate,
        provenance: {
          commits: [],
          locations: hits.slice(0, 4).map(x => `${x.file}:${x.line}`),
          extractor: "invariant-worktree",
          extractorVersion: "1",
        },
      });
    }

    return drafts;
  },
};

const TODO_COMMENT = /^(TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)/i;
const TODO_CONFIDENCE: Record<string, number> = { FIXME: 0.6, HACK: 0.6, XXX: 0.55, TODO: 0.5 };

export const watchlistExtractor: Extractor = {
  name: "watchlist-worktree",
  version: "1",
  produces: ["Watchlist"],
  extract(ctx: ExtractorContext): DraftNode[] {
    const drafts: DraftNode[] = [];

    // ── TODO-class comments ──
    const hits = scanComments(ctx, /^(TODO|FIXME|HACK|XXX)\b/i)
      .map(h => {
        const m = h.text.match(TODO_COMMENT)!;
        return { ...h, marker: m[1].toUpperCase(), text: m[2].trim() };
      })
      .filter(h => h.text.length >= 12); // "TODO: fix" carries no information
    const groups = new Map<string, typeof hits>();
    for (const h of hits) {
      const key = normalizeForDedupe(h.text);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(h);
    }
    for (const [key, group] of [...groups.entries()].sort()) {
      const h = group[0];
      drafts.push({
        id: makeNodeId("Watchlist", `${h.marker} ${h.text}`, key),
        type: "Watchlist",
        label: truncate(`${h.marker}: ${h.text}`, 80),
        summary: truncate(
          `Open ${h.marker} in code: "${h.text}" (${h.file}:${h.line}` +
          (group.length > 1 ? ` and ${group.length - 1} more location(s)` : "") +
          `). Unresolved marker comments flag known-incomplete or fragile code.`,
          400
        ),
        tags: ["seeded", h.marker.toLowerCase()],
        files: [...new Set(group.map(x => x.file))].slice(0, 4),
        edges: [],
        confidence: TODO_CONFIDENCE[h.marker] ?? 0.5,
        lastUpdated: ctx.headDate,
        provenance: {
          commits: [],
          locations: group.slice(0, 4).map(x => `${x.file}:${x.line}`),
          extractor: "watchlist-worktree",
          extractorVersion: "1",
        },
      });
    }

    // ── High-churn files: modified in many commits within the window ──
    const churn = new Map<string, number>();
    for (const c of ctx.commits) {
      for (const f of c.files) churn.set(f, (churn.get(f) ?? 0) + 1);
    }
    for (const [file, count] of [...churn.entries()].sort()) {
      if (count < 5) continue;
      if (TEST_FILE.test(file) || file.endsWith(".md") || !ctx.worktreeFiles.includes(file)) continue;
      drafts.push({
        id: makeNodeId("Watchlist", `HIGH CHURN ${file}`, `churn:${file}`),
        type: "Watchlist",
        label: truncate(`High churn: ${file}`, 80),
        summary: truncate(
          `${file} was modified in ${count} commits within the mined window — well above typical. ` +
          `High-churn files concentrate risk: review related regressions before editing.`,
          400
        ),
        tags: ["seeded", "churn"],
        files: [file],
        edges: [],
        confidence: 0.55,
        lastUpdated: ctx.headDate,
        provenance: {
          commits: [],
          locations: [file],
          extractor: "watchlist-worktree",
          extractorVersion: "1",
        },
      });
    }

    return drafts;
  },
};

const MANIFESTS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "Gemfile"];

export const componentExtractor: Extractor = {
  name: "component-structure",
  version: "1",
  produces: ["Component"],
  extract(ctx: ExtractorContext): DraftNode[] {
    // Resolve slug collisions deterministically: bare name when unique.
    const slugCount = new Map<string, number>();
    for (const dir of ctx.componentDirs) {
      const s = slugify(dir);
      slugCount.set(s, (slugCount.get(s) ?? 0) + 1);
    }

    return ctx.componentDirs.map((dir): DraftNode => {
      const files = ctx.worktreeFiles.filter(f => f.startsWith(dir + "/"));
      const manifest = files.find(f => MANIFESTS.includes(path.basename(f)) && f.split("/").length === 2);
      let manifestNote = "";
      if (manifest?.endsWith("package.json")) {
        try {
          const pkg = JSON.parse(ctx.readFile(manifest));
          manifestNote = ` Package: ${pkg.name ?? ""}${pkg.description ? ` — ${pkg.description}` : ""}.`;
        } catch { /* unparseable manifest — skip the note */ }
      }
      const extCounts = new Map<string, number>();
      for (const f of files) {
        const e = path.extname(f);
        if (e) extCounts.set(e, (extCounts.get(e) ?? 0) + 1);
      }
      const topExts = [...extCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([e]) => e);
      const slug = slugify(dir);
      const id = slugCount.get(slug)! > 1 ? `${slug}_${shortHash(dir)}` : slug;
      return {
        id,
        type: "Component",
        label: `${dir}/`,
        summary: truncate(
          `Top-level module \`${dir}/\` — ${files.length} tracked file(s)` +
          (topExts.length ? `, mainly ${topExts.join(", ")}` : "") + `.${manifestNote}`,
          400
        ),
        tags: ["seeded", "structure"],
        files: [manifest ?? files[0], ...files.slice(0, 2).filter(f => f !== manifest)].filter(Boolean).slice(0, 3),
        edges: [],
        confidence: 0.8,
        lastUpdated: ctx.headDate,
        provenance: {
          commits: [],
          locations: [dir + "/"],
          extractor: "component-structure",
          extractorVersion: "1",
        },
      };
    });
  },
};
